from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from math import isfinite
from time import monotonic
from typing import Literal
from uuid import uuid4

from switchyard_guard import StopController, Stopped, fingerprint

from .fixtures import FixtureLibrary
from .policy import PolicyEngine
from .schemas import (
    ActionPlan,
    ActionResponse,
    AuditReceipt,
    ControlResponse,
    GateCheck,
    OperatorRequest,
    PlannedAction,
    PolicyDecision,
    ReceiptStatus,
    ResetStopRequest,
    RiskTier,
    StopRequest,
    StopState,
)
from .storage import ReceiptStore


class Planner:
    def fixture_plan(self, request_fingerprint: str) -> ActionPlan:
        suffix = request_fingerprint[:16]
        return ActionPlan(
            plan_id=f"plan_{suffix}",
            actions=[
                PlannedAction(
                    action_id=f"act_{suffix}",
                    kind="fixture.replay",
                    capability="fixtures.read",
                    risk=RiskTier.READ_ONLY,
                    synthetic=True,
                    summary="Replay the embedded relay-recovery evidence bundle.",
                )
            ],
        )

    def control_plan(
        self,
        kind: Literal["stop.enable", "stop.reset"],
        request_fingerprint: str,
    ) -> ActionPlan:
        capability = "control.stop" if kind == "stop.enable" else "control.reset"
        suffix = request_fingerprint[:16]
        return ActionPlan(
            plan_id=f"plan_{suffix}",
            actions=[
                PlannedAction(
                    action_id=f"act_{suffix}",
                    kind=kind,
                    capability=capability,
                    risk=RiskTier.SAFETY_CONTROL,
                    synthetic=True,
                    summary="Latch the stop boundary." if kind == "stop.enable" else "Explicitly reset the local stop boundary.",
                )
            ],
        )


class SyntheticExecutor:
    def __init__(
        self,
        stop: StopController,
        fixtures: FixtureLibrary | None = None,
        checkpoint_hook: Callable[[], Awaitable[None]] | None = None,
        *,
        inspection_seconds: float = 4.0,
    ) -> None:
        if not isfinite(inspection_seconds) or inspection_seconds < 0:
            raise ValueError("inspection_seconds must be finite and non-negative")
        self._stop = stop
        self._fixtures = fixtures or FixtureLibrary()
        self._checkpoint_hook = checkpoint_hook
        self._inspection_seconds = inspection_seconds

    async def run(self, fixture_id: str, token: int):
        self._stop.check(token)
        await asyncio.sleep(0)
        self._stop.check(token)
        if self._checkpoint_hook is not None:
            await self._checkpoint_hook()
            self._stop.check(token)

        # Deliberate synthetic pacing gives the operator time to exercise stop.
        # It represents no provider work or per-stage progress.
        deadline = monotonic() + self._inspection_seconds
        while (remaining := deadline - monotonic()) > 0:
            self._stop.check(token)
            await asyncio.sleep(min(remaining, 0.1))
            self._stop.check(token)

        self._stop.check(token)
        result, sources = self._fixtures.load(fixture_id)
        self._stop.check(token)
        await asyncio.sleep(0)
        self._stop.check(token)
        return result, sources


class ActionGateway:
    """The only mutation/execution boundary exposed by the HTTP layer."""

    def __init__(
        self,
        stop: StopController,
        policy: PolicyEngine,
        store: ReceiptStore,
        executor: SyntheticExecutor | None = None,
    ) -> None:
        self.stop = stop
        self.policy = policy
        self.store = store
        self.executor = executor or SyntheticExecutor(stop)
        self.planner = Planner()

    @property
    def stop_state(self) -> StopState:
        state = self.stop.state
        return StopState(enabled=state.latched, reason_code=state.reason, generation=state.generation)

    async def execute(self, request: OperatorRequest) -> ActionResponse:
        request_hash = fingerprint(request)
        plan = self.planner.fixture_plan(request_hash)
        action = plan.actions[0]
        token = self.stop.token()
        decision = self.policy.evaluate(action, self.stop_state)
        if not decision.allowed:
            status = ReceiptStatus.STOPPED if self.stop_state.enabled else ReceiptStatus.BLOCKED
            receipt = self._receipt(action, decision.code, status, request_hash, None)
            self.store.append(receipt)
            return ActionResponse(plan=plan, policy=decision, receipt=receipt)

        try:
            self.stop.check(token)
            result, sources = await self.executor.run(request.fixture_id, token)
            self.stop.check(token)
        except Stopped:
            decision = PolicyDecision(
                allowed=False,
                code="denied.stop-during-execution",
                checks=[GateCheck(code="stop.token-current", passed=False)],
            )
            receipt = self._receipt(
                action,
                decision.code,
                ReceiptStatus.STOPPED,
                request_hash,
                None,
            )
            self.store.append(receipt)
            return ActionResponse(plan=plan, policy=decision, receipt=receipt)
        except Exception:
            receipt = self._receipt(
                action,
                "failed.executor",
                ReceiptStatus.FAILED,
                request_hash,
                None,
            )
            self.store.append(receipt)
            raise

        result_hash = fingerprint({"result": result, "sources": sources})
        receipt = self._receipt(
            action,
            decision.code,
            ReceiptStatus.COMPLETED,
            request_hash,
            result_hash,
        )
        self.store.append(receipt)
        return ActionResponse(
            plan=plan,
            policy=decision,
            result=result,
            sources=sources,
            receipt=receipt,
        )

    async def enable_stop(self, request: StopRequest) -> ControlResponse:
        request_hash = fingerprint(request)
        plan = self.planner.control_plan("stop.enable", request_hash)
        action = plan.actions[0]
        decision = self.policy.evaluate(action, self.stop_state)
        if not decision.allowed:  # Defensive: stop.enable is deliberately always admissible.
            receipt = self._receipt(action, decision.code, ReceiptStatus.BLOCKED, request_hash, None)
            self.store.append(receipt)
            return ControlResponse(state=self.stop_state, policy=decision, receipt=receipt)
        self.stop.latch("operator-stop")
        state = self.stop_state
        receipt = self._receipt(
            action,
            decision.code,
            ReceiptStatus.COMPLETED,
            request_hash,
            fingerprint(state),
        )
        self.store.append(receipt)
        return ControlResponse(state=state, policy=decision, receipt=receipt)

    async def reset_stop(self, request: ResetStopRequest) -> ControlResponse:
        request_hash = fingerprint(request)
        plan = self.planner.control_plan("stop.reset", request_hash)
        action = plan.actions[0]
        decision = self.policy.evaluate(action, self.stop_state)
        if not decision.allowed:
            receipt = self._receipt(action, decision.code, ReceiptStatus.BLOCKED, request_hash, None)
            self.store.append(receipt)
            return ControlResponse(state=self.stop_state, policy=decision, receipt=receipt)
        self.stop.reset()
        state = self.stop_state
        receipt = self._receipt(
            action,
            decision.code,
            ReceiptStatus.COMPLETED,
            request_hash,
            fingerprint(state),
        )
        try:
            self.store.append(receipt)
        except Exception:
            self.stop.latch("receipt-persistence-failure")
            raise
        return ControlResponse(state=state, policy=decision, receipt=receipt)

    def _receipt(
        self,
        action: PlannedAction,
        policy_code: str,
        status: ReceiptStatus,
        request_hash: str,
        result_hash: str | None,
    ) -> AuditReceipt:
        return AuditReceipt(
            receipt_id=f"rcpt_{uuid4().hex}",
            created_at=datetime.now(UTC),
            status=status,
            action_kind=action.kind,
            capability=action.capability,
            policy_code=policy_code,
            stop_generation=self.stop.token(),
            request_fingerprint=request_hash,
            result_fingerprint=result_hash,
            synthetic=action.synthetic,
        )
