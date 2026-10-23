from __future__ import annotations

import asyncio
import functools
import inspect
import threading
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Any, NoReturn, ParamSpec, TypeVar

from .fingerprint import fingerprint
from .ledger import Ledger, MemoryLedger, Receipt, Status
from .policy import Call, Decision, Policy, Risk
from .stop import StopController, StopState, Stopped, _active

P = ParamSpec("P")
R = TypeVar("R")

_STOP_CANCEL = "switchyard_guard.stop"


class Denied(Exception):
    """The gate refused the call before it ran. Agent loops can hand this back to the model."""

    def __init__(self, receipt: Receipt, decision: Decision) -> None:
        super().__init__(f"{receipt.tool} denied: {decision.code}")
        self.receipt = receipt
        self.decision = decision


class BudgetExhausted(Denied):
    """The capability's call budget is spent. Raised before the call runs, like any denial."""


class Guard:
    """Gates tool calls against a policy, lets any of them be stopped, and writes a receipt per call."""

    def __init__(
        self,
        policy: Policy,
        ledger: Ledger | None = None,
        *,
        stop: StopController | None = None,
        fingerprint_key: bytes | None = None,
    ) -> None:
        self.policy = policy
        self.ledger = ledger if ledger is not None else MemoryLedger()
        self.controller = stop if stop is not None else StopController()
        self._key = fingerprint_key
        self._tasks: dict[asyncio.Task[Any], list[int]] = {}
        self._cancelled: set[asyncio.Task[Any]] = set()
        self._tasks_lock = threading.Lock()
        self._spent: dict[str, int] = {}
        self._admission = threading.Lock()
        self.controller.on_latch(self._cancel_in_flight)

    @property
    def state(self) -> StopState:
        return self.controller.state

    @property
    def spent(self) -> dict[str, int]:
        """Calls admitted so far per capability, which is what budgets count."""
        with self._admission:
            return dict(self._spent)

    def stop(self, reason: str = "operator-stop") -> Receipt:
        """Latch the stop. Calls in flight end at their next checkpoint (async calls at their next await).

        Pressing it again while latched changes nothing and is recorded as already latched.
        """
        latched_now = self.controller.latch(reason)
        code = "allowed" if latched_now else "allowed.already-latched"
        return self._record_control("guard.stop", "control.stop", code)

    def reset(self) -> Receipt:
        """Reopen the gate for new calls. Calls admitted before the reset stay invalid."""
        self.controller.reset()
        return self._record_control("guard.reset", "control.reset", "allowed")

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
                token = self.controller.token()
                started = time.monotonic()
                with self._admission:
                    # Deciding and spending budget under one lock, so concurrent calls can't overspend.
                    decision = self.policy.evaluate(
                        call, stopped=not self.controller.valid(token), spent=self._spent
                    )
                    if decision.allowed:
                        self._spent[capability] = self._spent.get(capability, 0) + 1
                if not decision.allowed:
                    status: Status = "stopped" if decision.code == "denied.stop-active" else "blocked"
                    receipt = self._record(call, status, decision.code, None, started)
                    if status == "stopped":
                        raise Stopped(receipt)
                    if decision.code == "denied.budget":
                        raise BudgetExhausted(receipt, decision)
                    raise Denied(receipt, decision)
                self._halt_if_invalid(call, token, "stopped.before-start", started)
                return call, token, started

            if inspect.iscoroutinefunction(func):

                @functools.wraps(func)
                async def run_async(*args: P.args, **kwargs: P.kwargs) -> Any:
                    call, token, started = admit(args, kwargs)
                    task = asyncio.current_task()
                    assert task is not None
                    self._track(task, token)
                    if not self.controller.valid(token):
                        # A stop that latched after admission but before _track had no task to
                        # cancel, so check again now that a later latch is sure to see this one.
                        self._untrack(task, token)
                        self._halt(call, "stopped.before-start", started)
                    context = _active.set((self.controller, token))
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
                context = _active.set((self.controller, token))
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
        self._record(call, "completed", "allowed", fingerprint(result, self._key), started, generation=token)
        return result

    def _halt_if_invalid(self, call: Call, token: int, code: str, started: float) -> None:
        if not self.controller.valid(token):
            self._halt(call, code, started)

    def _halt(self, call: Call, code: str, started: float) -> NoReturn:
        raise Stopped(self._record(call, "stopped", code, None, started))

    def _cancel_in_flight(self, _: StopState) -> None:
        with self._tasks_lock:
            tasks = list(self._tasks)
        for task in tasks:
            task.get_loop().call_soon_threadsafe(self._cancel_if_running, task)

    def _cancel_if_running(self, task: asyncio.Task[Any]) -> None:
        # Runs on the task's own loop, so the call cannot finish between this check and the
        # cancel. A later call on the same task, admitted after a reset, is left alone.
        with self._tasks_lock:
            tokens = list(self._tasks.get(task, ()))
            if task in self._cancelled or all(self.controller.valid(token) for token in tokens):
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
        self,
        call: Call,
        status: Status,
        code: str,
        result_fingerprint: str | None,
        started: float,
        *,
        generation: int | None = None,
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
                # A completed call records the generation it ran under. Anything else records
                # the generation that refused or ended it.
                stop_generation=self.controller.token() if generation is None else generation,
                args_fingerprint=fingerprint(dict(call.args), self._key),
                result_fingerprint=result_fingerprint,
                duration_ms=round((time.monotonic() - started) * 1000, 3),
            )
        )

    def _record_control(self, tool: str, capability: str, code: str) -> Receipt:
        state = self.controller.state
        return self._append(
            Receipt(
                receipt_id=f"rcpt_{uuid.uuid4().hex}",
                created_at=datetime.now(UTC).isoformat(),
                tool=tool,
                capability=capability,
                risk="control",
                status="completed",
                code=code,
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
            self.controller.latch("ledger-write-failed")
            raise
        return receipt
