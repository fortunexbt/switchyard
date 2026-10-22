from __future__ import annotations

import asyncio
import contextvars
import functools
import inspect
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Any, NoReturn, ParamSpec, TypeVar

from .fingerprint import fingerprint
from .ledger import Ledger, MemoryLedger, Receipt, Status
from .policy import Call, Decision, Policy, Risk

P = ParamSpec("P")
R = TypeVar("R")


class Denied(Exception):
    """The gate refused the call before it ran. Agent loops can hand this back to the model."""

    def __init__(self, receipt: Receipt, decision: Decision) -> None:
        super().__init__(f"{receipt.tool} denied: {decision.code}")
        self.receipt = receipt
        self.decision = decision


class Stopped(BaseException):
    """The stop is latched or was pressed mid-call. A BaseException, like KeyboardInterrupt,
    so a tool's or agent loop's `except Exception` cannot swallow it and carry on."""

    def __init__(self, receipt: Receipt | None = None) -> None:
        super().__init__(f"{receipt.tool} stopped: {receipt.code}" if receipt else "stopped")
        self.receipt = receipt


@dataclass(frozen=True)
class StopState:
    latched: bool
    reason: str | None
    generation: int


class _StopController:
    """Every stop and reset bumps the generation, so a token issued before either never runs again."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._latched = False
        self._reason: str | None = None
        self._generation = 0

    @property
    def state(self) -> StopState:
        with self._lock:
            return StopState(self._latched, self._reason, self._generation)

    def token(self) -> int:
        with self._lock:
            return self._generation

    def valid(self, token: int) -> bool:
        with self._lock:
            return not self._latched and token == self._generation

    def transition(self, latched: bool, reason: str | None) -> StopState:
        with self._lock:
            self._generation += 1
            self._latched = latched
            self._reason = reason
            return StopState(self._latched, self._reason, self._generation)


_STOP_CANCEL = "switchyard_guard.stop"

_active: contextvars.ContextVar[tuple[_StopController, int] | None] = contextvars.ContextVar(
    "switchyard_guard_active", default=None
)


def checkpoint() -> None:
    """Raise Stopped if the gated call this code runs inside has been stopped.

    Call it between units of work in a long-running tool. Outside a gated call it does nothing.
    """
    active = _active.get()
    if active is not None and not active[0].valid(active[1]):
        raise Stopped()


class Guard:
    """Gates tool calls against a policy, lets any of them be stopped, and writes a receipt per call."""

    def __init__(
        self,
        policy: Policy,
        ledger: Ledger | None = None,
        *,
        fingerprint_key: bytes | None = None,
    ) -> None:
        self.policy = policy
        self.ledger = ledger if ledger is not None else MemoryLedger()
        self._key = fingerprint_key
        self._stop = _StopController()
        self._tasks: dict[asyncio.Task[Any], list[int]] = {}
        self._cancelled: set[asyncio.Task[Any]] = set()
        self._tasks_lock = threading.Lock()

    @property
    def state(self) -> StopState:
        return self._stop.state

    def stop(self, reason: str = "operator-stop") -> Receipt:
        """Latch the stop. Calls in flight end at their next checkpoint (async calls at their next await)."""
        state = self._latch(reason)
        return self._record_control("guard.stop", "control.stop", state)

    def reset(self) -> Receipt:
        """Reopen the gate for new calls. Calls admitted before the stop stay invalid."""
        state = self._stop.transition(False, None)
        return self._record_control("guard.reset", "control.reset", state)

    def gated(
        self, capability: str, risk: Risk | str = Risk.READ, *, name: str | None = None
    ) -> Callable[[Callable[P, R]], Callable[P, R]]:
        tier = Risk.parse(risk)

        def decorate(func: Callable[P, R]) -> Callable[P, R]:
            signature = inspect.signature(func)
            tool = name or func.__qualname__.rpartition("<locals>.")[2]

            def admit(args: tuple[Any, ...], kwargs: dict[str, Any]) -> tuple[Call, int, float]:
                bound = signature.bind(*args, **kwargs)
                bound.apply_defaults()
                call = Call(tool, capability, tier, MappingProxyType(dict(bound.arguments)))
                token = self._stop.token()
                started = time.monotonic()
                decision = self.policy.evaluate(call, stopped=not self._stop.valid(token))
                if not decision.allowed:
                    status: Status = "stopped" if decision.code == "denied.stop-active" else "blocked"
                    receipt = self._record(call, status, decision.code, None, started)
                    if status == "stopped":
                        raise Stopped(receipt)
                    raise Denied(receipt, decision)
                return call, token, started

            if inspect.iscoroutinefunction(func):

                @functools.wraps(func)
                async def run_async(*args: P.args, **kwargs: P.kwargs) -> Any:
                    call, token, started = admit(args, kwargs)
                    self._halt_if_invalid(call, token, "stopped.before-start", started)
                    task = asyncio.current_task()
                    assert task is not None
                    self._track(task, token)
                    context = _active.set((self._stop, token))
                    try:
                        result = await func(*args, **kwargs)
                    except Stopped:
                        self._halt(call, "stopped.in-flight", started)
                    except asyncio.CancelledError as cancel:
                        if cancel.args != (_STOP_CANCEL,):
                            # Someone else's cancel (a timeout, a task group) keeps its meaning.
                            self._record(call, "failed", "failed.cancelled", None, started)
                            raise
                        self._halt(call, "stopped.in-flight", started)
                    except Exception:
                        self._record(call, "failed", "failed.exception", None, started)
                        raise
                    finally:
                        _active.reset(context)
                        self._untrack(task, token)
                    return self._release(call, token, result, started)

                return run_async  # type: ignore[return-value]

            @functools.wraps(func)
            def run(*args: P.args, **kwargs: P.kwargs) -> R:
                call, token, started = admit(args, kwargs)
                self._halt_if_invalid(call, token, "stopped.before-start", started)
                context = _active.set((self._stop, token))
                try:
                    result = func(*args, **kwargs)
                except Stopped:
                    self._halt(call, "stopped.in-flight", started)
                except Exception:
                    self._record(call, "failed", "failed.exception", None, started)
                    raise
                finally:
                    _active.reset(context)
                return self._release(call, token, result, started)

            return run

        return decorate

    def _release(self, call: Call, token: int, result: Any, started: float) -> Any:
        # A stop pressed while the tool was running withholds the result even if the tool finished.
        self._halt_if_invalid(call, token, "stopped.after-return", started)
        self._record(call, "completed", "allowed", fingerprint(result, self._key), started)
        return result

    def _halt_if_invalid(self, call: Call, token: int, code: str, started: float) -> None:
        if not self._stop.valid(token):
            self._halt(call, code, started)

    def _halt(self, call: Call, code: str, started: float) -> NoReturn:
        raise Stopped(self._record(call, "stopped", code, None, started))

    def _latch(self, reason: str) -> StopState:
        state = self._stop.transition(True, reason)
        with self._tasks_lock:
            tasks = list(self._tasks)
        for task in tasks:
            task.get_loop().call_soon_threadsafe(self._cancel_if_running, task)
        return state

    def _cancel_if_running(self, task: asyncio.Task[Any]) -> None:
        # Runs on the task's own loop, so the call cannot finish between this check and the
        # cancel. A later call on the same task, admitted after a reset, is left alone.
        with self._tasks_lock:
            tokens = list(self._tasks.get(task, ()))
            if task in self._cancelled or all(self._stop.valid(token) for token in tokens):
                return
            self._cancelled.add(task)  # One cancel per task, however often stop() is pressed.
        task.cancel(_STOP_CANCEL)


    def _track(self, task: asyncio.Task[Any], token: int) -> None:
        with self._tasks_lock:
            self._tasks.setdefault(task, []).append(token)

    def _untrack(self, task: asyncio.Task[Any], token: int) -> None:
        with self._tasks_lock:
            tokens = self._tasks[task]
            tokens.remove(token)
            if tokens:
                return
            del self._tasks[task]
            ours = task in self._cancelled
            self._cancelled.discard(task)
        if ours:
            # Undo our own cancel, delivered or swallowed by the tool, so the caller's task
            # is not left half-cancelled for a later timeout or task group to trip over.
            task.uncancel()

    def _record(
        self, call: Call, status: Status, code: str, result_fingerprint: str | None, started: float
    ) -> Receipt:
        return self._append(
            Receipt(
                receipt_id=f"rcpt_{uuid.uuid4().hex}",
                created_at=datetime.now(UTC).isoformat(),
                tool=call.tool,
                capability=call.capability,
                risk=call.risk.label,
                status=status,
                code=code,
                stop_generation=self._stop.state.generation,
                args_fingerprint=fingerprint(dict(call.args), self._key),
                result_fingerprint=result_fingerprint,
                duration_ms=round((time.monotonic() - started) * 1000, 3),
            )
        )

    def _record_control(self, tool: str, capability: str, state: StopState) -> Receipt:
        return self._append(
            Receipt(
                receipt_id=f"rcpt_{uuid.uuid4().hex}",
                created_at=datetime.now(UTC).isoformat(),
                tool=tool,
                capability=capability,
                risk="control",
                status="completed",
                code="allowed",
                stop_generation=state.generation,
                args_fingerprint=None,
                result_fingerprint=fingerprint(
                    {"enabled": state.latched, "reason_code": state.reason, "generation": state.generation},
                    self._key,
                ),
                duration_ms=None,
            )
        )

    def _append(self, receipt: Receipt) -> Receipt:
        try:
            self.ledger.append(receipt)
        except Exception:
            # Losing the audit trail fails safe: nothing else runs until someone resets.
            self._latch("ledger-write-failed")
            raise
        return receipt
