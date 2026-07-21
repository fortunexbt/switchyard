from __future__ import annotations

import threading

from .schemas import StopState, StopToken


class StopRequested(RuntimeError):
    """Raised at a checkpoint after the operator has invalidated an action."""


class StopController:
    """Generation tokens make a stop irreversible for already-started work."""

    def __init__(self, initial_state: bool = False) -> None:
        self._enabled = initial_state
        self._reason_code = "configured-stop" if initial_state else None
        self._generation = 1 if initial_state else 0
        self._lock = threading.RLock()

    def snapshot(self) -> StopToken:
        with self._lock:
            return StopToken(generation=self._generation)

    @property
    def state(self) -> StopState:
        with self._lock:
            return StopState(
                enabled=self._enabled,
                reason_code=self._reason_code,
                generation=self._generation,
            )

    def enable(self, reason_code: str = "operator-stop") -> StopState:
        with self._lock:
            self._generation += 1
            self._enabled = True
            self._reason_code = reason_code
            return self.state

    def reset(self) -> StopState:
        with self._lock:
            self._generation += 1
            self._enabled = False
            self._reason_code = None
            return self.state

    def checkpoint(self, token: StopToken) -> None:
        with self._lock:
            if self._enabled or token.generation != self._generation:
                raise StopRequested("execution invalidated by stop boundary")
