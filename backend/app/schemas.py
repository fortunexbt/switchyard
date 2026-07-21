from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RiskTier(str, Enum):
    READ_ONLY = "read_only"
    SAFETY_CONTROL = "safety_control"
    WRITE = "write"


class ReceiptStatus(str, Enum):
    COMPLETED = "completed"
    BLOCKED = "blocked"
    STOPPED = "stopped"
    FAILED = "failed"


class StopState(StrictModel):
    enabled: bool
    reason_code: str | None = None
    generation: int = Field(ge=0)


class StopToken(StrictModel):
    generation: int = Field(ge=0)


class OperatorRequest(StrictModel):
    command: str = Field(min_length=3, max_length=500)
    fixture_id: Literal["orbital-relay-recovery"] = "orbital-relay-recovery"


class StopRequest(StrictModel):
    reason: str = Field(default="operator request", min_length=3, max_length=120)


class ResetStopRequest(StrictModel):
    acknowledge: Literal["resume synthetic execution"]


class PlannedAction(StrictModel):
    action_id: str
    kind: Literal["fixture.replay", "stop.enable", "stop.reset"]
    capability: Literal["fixtures.read", "control.stop", "control.reset"]
    risk: RiskTier
    synthetic: bool
    summary: str


class ActionPlan(StrictModel):
    plan_id: str
    actions: list[PlannedAction] = Field(min_length=1, max_length=8)


class GateCheck(StrictModel):
    code: str
    passed: bool


class PolicyDecision(StrictModel):
    allowed: bool
    code: str
    policy_version: Literal["switchyard-policy/1"] = "switchyard-policy/1"
    checks: list[GateCheck]


class DemoSignal(StrictModel):
    label: str
    value: str
    state: Literal["nominal", "watch", "held"]


class DemoResult(StrictModel):
    fixture_id: str
    fixture_version: str
    headline: str
    summary: str
    signals: list[DemoSignal]
    recommended_sequence: list[str]
    disclosure: Literal["Embedded deterministic fixture; no network or live system was contacted."]


class SourceProof(StrictModel):
    source_id: str
    label: str
    captured_at: datetime
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    kind: Literal["embedded_fixture"] = "embedded_fixture"


class AuditReceipt(StrictModel):
    receipt_id: str
    created_at: datetime
    status: ReceiptStatus
    action_kind: str
    capability: str
    policy_code: str
    stop_generation: int = Field(ge=0)
    request_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    result_fingerprint: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    synthetic: bool


class ActionResponse(StrictModel):
    plan: ActionPlan
    policy: PolicyDecision
    result: DemoResult | None = None
    sources: list[SourceProof] = Field(default_factory=list)
    receipt: AuditReceipt


class ControlResponse(StrictModel):
    state: StopState
    policy: PolicyDecision
    receipt: AuditReceipt


class StateResponse(StrictModel):
    mode: Literal["offline-proof"] = "offline-proof"
    stop: StopState
    capabilities: list[str]
    limitations: list[str]


class ReceiptPage(StrictModel):
    receipts: list[AuditReceipt]


class HealthResponse(StrictModel):
    status: Literal["ok"] = "ok"
    mode: Literal["offline-proof"] = "offline-proof"


class ErrorResponse(StrictModel):
    code: str
    detail: str
    request_id: str
