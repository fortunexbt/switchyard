export type StopState = {
  enabled: boolean;
  reason_code: string | null;
  generation: number;
};

export type SystemState = {
  mode: "offline-proof";
  stop: StopState;
  capabilities: string[];
  limitations: string[];
};

export type GateCheck = { code: string; passed: boolean };
export type PolicyDecision = {
  allowed: boolean;
  code: string;
  policy_version: "switchyard-policy/1";
  checks: GateCheck[];
};

export type PlannedAction = {
  action_id: string;
  kind: "fixture.replay" | "stop.enable" | "stop.reset";
  capability: "fixtures.read" | "control.stop" | "control.reset";
  risk: "read_only" | "safety_control" | "write";
  synthetic: boolean;
  summary: string;
};

export type DemoSignal = {
  label: string;
  value: string;
  state: "nominal" | "watch" | "held";
};
export type DemoResult = {
  fixture_id: string;
  fixture_version: string;
  headline: string;
  summary: string;
  signals: DemoSignal[];
  recommended_sequence: string[];
  disclosure: "Embedded deterministic fixture; no network or live system was contacted.";
};

export type SourceProof = {
  source_id: string;
  label: string;
  captured_at: string;
  fingerprint: string;
  kind: "embedded_fixture";
};

export type Receipt = {
  receipt_id: string;
  created_at: string;
  status: "completed" | "blocked" | "stopped" | "failed";
  action_kind: string;
  capability: string;
  policy_code: string;
  stop_generation: number;
  request_fingerprint: string;
  result_fingerprint: string | null;
  synthetic: boolean;
};

export type ActionResponse = {
  plan: { plan_id: string; actions: PlannedAction[] };
  policy: PolicyDecision;
  result: DemoResult | null;
  sources: SourceProof[];
  receipt: Receipt;
};

export type ControlResponse = {
  state: StopState;
  policy: PolicyDecision;
  receipt: Receipt;
};
export type ReceiptPage = { receipts: Receipt[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFields(
  value: unknown,
  fields: string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function isStopState(value: unknown): value is StopState {
  return (
    hasFields(value, ["enabled", "reason_code", "generation"]) &&
    typeof value.enabled === "boolean" &&
    (value.reason_code === null || typeof value.reason_code === "string") &&
    isGeneration(value.generation)
  );
}

export function isSystemState(value: unknown): value is SystemState {
  return (
    hasFields(value, ["mode", "stop", "capabilities", "limitations"]) &&
    value.mode === "offline-proof" &&
    isStopState(value.stop) &&
    isStrings(value.capabilities) &&
    isStrings(value.limitations)
  );
}

function isPolicyDecision(value: unknown): value is PolicyDecision {
  return (
    hasFields(value, ["allowed", "code", "policy_version", "checks"]) &&
    typeof value.allowed === "boolean" &&
    typeof value.code === "string" &&
    value.policy_version === "switchyard-policy/1" &&
    Array.isArray(value.checks) &&
    value.checks.every(
      (check) =>
        hasFields(check, ["code", "passed"]) &&
        typeof check.code === "string" &&
        typeof check.passed === "boolean",
    )
  );
}

function isPlannedAction(value: unknown): value is PlannedAction {
  return (
    hasFields(value, [
      "action_id",
      "kind",
      "capability",
      "risk",
      "synthetic",
      "summary",
    ]) &&
    typeof value.action_id === "string" &&
    typeof value.summary === "string" &&
    typeof value.synthetic === "boolean" &&
    (value.kind === "fixture.replay" ||
      value.kind === "stop.enable" ||
      value.kind === "stop.reset") &&
    (value.capability === "fixtures.read" ||
      value.capability === "control.stop" ||
      value.capability === "control.reset") &&
    (value.risk === "read_only" ||
      value.risk === "safety_control" ||
      value.risk === "write")
  );
}

function isDemoResult(value: unknown): value is DemoResult {
  return (
    hasFields(value, [
      "fixture_id",
      "fixture_version",
      "headline",
      "summary",
      "signals",
      "recommended_sequence",
      "disclosure",
    ]) &&
    typeof value.fixture_id === "string" &&
    typeof value.fixture_version === "string" &&
    typeof value.headline === "string" &&
    typeof value.summary === "string" &&
    isStrings(value.recommended_sequence) &&
    value.disclosure ===
      "Embedded deterministic fixture; no network or live system was contacted." &&
    Array.isArray(value.signals) &&
    value.signals.every(
      (signal) =>
        hasFields(signal, ["label", "value", "state"]) &&
        typeof signal.label === "string" &&
        typeof signal.value === "string" &&
        (signal.state === "nominal" ||
          signal.state === "watch" ||
          signal.state === "held"),
    )
  );
}

function isSourceProof(value: unknown): value is SourceProof {
  return (
    hasFields(value, [
      "source_id",
      "label",
      "captured_at",
      "fingerprint",
      "kind",
    ]) &&
    typeof value.source_id === "string" &&
    typeof value.label === "string" &&
    isTimestamp(value.captured_at) &&
    isFingerprint(value.fingerprint) &&
    value.kind === "embedded_fixture"
  );
}

export function isReceipt(value: unknown): value is Receipt {
  return (
    hasFields(value, [
      "receipt_id",
      "created_at",
      "status",
      "action_kind",
      "capability",
      "policy_code",
      "stop_generation",
      "request_fingerprint",
      "result_fingerprint",
      "synthetic",
    ]) &&
    typeof value.receipt_id === "string" &&
    isTimestamp(value.created_at) &&
    (value.status === "completed" ||
      value.status === "blocked" ||
      value.status === "stopped" ||
      value.status === "failed") &&
    typeof value.action_kind === "string" &&
    typeof value.capability === "string" &&
    typeof value.policy_code === "string" &&
    isGeneration(value.stop_generation) &&
    isFingerprint(value.request_fingerprint) &&
    (value.result_fingerprint === null ||
      isFingerprint(value.result_fingerprint)) &&
    typeof value.synthetic === "boolean"
  );
}

export function isReceiptPage(value: unknown): value is ReceiptPage {
  return (
    hasFields(value, ["receipts"]) &&
    Array.isArray(value.receipts) &&
    value.receipts.every(isReceipt)
  );
}

export function isControlResponse(value: unknown): value is ControlResponse {
  return (
    hasFields(value, ["state", "policy", "receipt"]) &&
    isStopState(value.state) &&
    isPolicyDecision(value.policy) &&
    isReceipt(value.receipt) &&
    value.receipt.stop_generation === value.state.generation &&
    value.receipt.policy_code === value.policy.code
  );
}

export function isActionResponse(value: unknown): value is ActionResponse {
  return (
    hasFields(value, ["plan", "policy", "result", "sources", "receipt"]) &&
    hasFields(value.plan, ["plan_id", "actions"]) &&
    typeof value.plan.plan_id === "string" &&
    Array.isArray(value.plan.actions) &&
    value.plan.actions.length >= 1 &&
    value.plan.actions.length <= 8 &&
    value.plan.actions.every(isPlannedAction) &&
    isPolicyDecision(value.policy) &&
    (value.result === null || isDemoResult(value.result)) &&
    Array.isArray(value.sources) &&
    value.sources.every(isSourceProof) &&
    isReceipt(value.receipt) &&
    value.receipt.policy_code === value.policy.code &&
    (value.receipt.status === "completed"
      ? value.policy.allowed &&
        value.result !== null &&
        value.receipt.result_fingerprint !== null
      : value.result === null &&
        value.sources.length === 0 &&
        value.receipt.result_fingerprint === null)
  );
}

export function resolveApiBase(
  configured?: string,
  origin = globalThis.location?.origin ?? "http://localhost",
): string {
  if (!configured?.trim()) return "";
  const url = new URL(configured.trim(), origin);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local))
  ) {
    throw new Error(
      "VITE_API_BASE must be an HTTPS or loopback HTTP URL without credentials, query, or fragment",
    );
  }
  return url.href.replace(/\/$/, "");
}

async function readResponse(
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const base = resolveApiBase(import.meta.env?.VITE_API_BASE);
    const response = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
    });
    return { response, payload: (await response.json()) as unknown };
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestJson<T>(
  path: string,
  validate: (value: unknown) => value is T,
  init: RequestInit = {},
): Promise<T> {
  const { response, payload } = await readResponse(path, init);
  if (!response.ok || !validate(payload))
    throw new Error("Invalid control plane response");
  return payload;
}

export async function requestAction(command: string): Promise<ActionResponse> {
  const { response, payload } = await readResponse("/api/actions", {
    method: "POST",
    body: JSON.stringify({ command, fixture_id: "orbital-relay-recovery" }),
  });
  if (!isActionResponse(payload)) throw new Error("Invalid action receipt");
  const expectedHold =
    !payload.policy.allowed &&
    ((response.status === 403 && payload.receipt.status === "blocked") ||
      (response.status === 423 && payload.receipt.status === "stopped"));
  if (!response.ok && !expectedHold) throw new Error("Action request failed");
  return payload;
}
