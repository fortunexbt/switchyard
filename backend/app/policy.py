from __future__ import annotations

from .schemas import GateCheck, PlannedAction, PolicyDecision, RiskTier, StopState


class PolicyEngine:
    """A small, explicit allowlist for Switchyard's offline proof mode."""

    _allowed = {
        "fixture.replay": ("fixtures.read", RiskTier.READ_ONLY),
        "stop.enable": ("control.stop", RiskTier.SAFETY_CONTROL),
        "stop.reset": ("control.reset", RiskTier.SAFETY_CONTROL),
    }

    def evaluate(self, action: PlannedAction, stop: StopState) -> PolicyDecision:
        expected = self._allowed.get(action.kind)
        allowlisted = expected == (action.capability, action.risk)
        synthetic_ok = action.synthetic
        stop_ok = action.kind in {"stop.enable", "stop.reset"} or not stop.enabled
        checks = [
            GateCheck(code="capability.allowlisted", passed=allowlisted),
            GateCheck(code="executor.synthetic", passed=synthetic_ok),
            GateCheck(code="stop.open-or-control", passed=stop_ok),
            GateCheck(code="writes.denied", passed=action.risk is not RiskTier.WRITE),
        ]
        allowed = all(check.passed for check in checks)
        if not stop_ok:
            code = "denied.stop-active"
        elif not allowlisted:
            code = "denied.capability"
        elif not synthetic_ok:
            code = "denied.live-executor"
        elif action.risk is RiskTier.WRITE:
            code = "denied.write"
        else:
            code = "allowed.offline-proof"
        return PolicyDecision(allowed=allowed, code=code, checks=checks)
