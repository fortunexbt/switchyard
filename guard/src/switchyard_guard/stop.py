from __future__ import annotations

import contextvars
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from .ledger import Receipt


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


class StopController:
    """The stop switch. A token is the generation it was issued at, and it stays valid only
    while the stop is open and no stop or reset has happened since.

    One re-entrant lock orders everything: a latch, a reset, a validity check and a commit
    block. That ordering is what the guarantees in guard/README.md rest on.
    """

    def __init__(self, *, latched: bool = False) -> None:
        self._lock = threading.RLock()
        self._latched = latched
        self._reason = "configured-stop" if latched else None
        self._generation = 1 if latched else 0
        self._listeners: list[Callable[[StopState], None]] = []

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

    def check(self, token: int) -> None:
        """Raise Stopped unless the token is still valid."""
        if not self.valid(token):
            raise Stopped()

    @contextmanager
    def commit(self, token: int) -> Iterator[None]:
        """Run a side effect only if the token is valid, and hold off any latch until it ends.

        The block must be short and must not await: a stop pressed meanwhile waits for it.
        """
        with self._lock:
            self.check(token)
            yield

    def latch(self, reason: str = "operator-stop") -> bool:
        """Latch the stop. Returns False, and changes nothing, if it was already latched."""
        with self._lock:
            if self._latched:
                return False
            self._generation += 1
            self._latched = True
            self._reason = reason
            state = StopState(True, reason, self._generation)
            listeners = list(self._listeners)
        for listener in listeners:
            listener(state)
        return True

    def reset(self) -> StopState:
        """Open the stop. The generation moves on, so no token issued before this call works again."""
        with self._lock:
            self._generation += 1
            self._latched = False
            self._reason = None
            return StopState(False, None, self._generation)

    def on_latch(self, listener: Callable[[StopState], None]) -> None:
        """Call `listener` with the new state each time the stop actually latches."""
        with self._lock:
            self._listeners.append(listener)


_active: contextvars.ContextVar[tuple[StopController, int] | None] = contextvars.ContextVar(
    "switchyard_guard_active", default=None
)


def checkpoint() -> None:
    """Raise Stopped if the gated call this code runs inside has been stopped.

    Call it between units of work in a long-running tool. Outside a gated call it does nothing.
    """
    active = _active.get()
    if active is not None:
        active[0].check(active[1])


@contextmanager
def commit() -> Iterator[None]:
    """Wrap one side effect of a gated call: it runs only if the call has not been stopped,
    and no stop can latch while it runs. Outside a gated call it just runs the block."""
    active = _active.get()
    if active is None:
        yield
        return
    with active[0].commit(active[1]):
        yield
