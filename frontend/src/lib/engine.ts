// Browser port of backend/app (policy.py, stop.py, fixtures.py, execution.py).
// The hosted demo has no server, so the same gate, stop tokens and receipts run
// here. Fingerprints are byte-compatible with the Python implementation.
import fixture from "../../../backend/app/demo_data/orbital-relay-recovery.json" with { type: "json" };
import type {
  ActionResponse,
  ControlResponse,
  DemoResult,
  GateCheck,
  PlannedAction,
  PolicyDecision,
  Receipt,
  SourceProof,
  StopState,
  SystemState,
} from "./api.ts";

export type RouteEvent =
  | { stage: "planned"; action: PlannedAction }
  | { stage: "gated"; policy: PolicyDecision; generation: number }
  | { stage: "executing"; inspectionMs: number };

export type EngineReply = { status: number; payload: unknown };

const POLICY_VERSION = "switchyard-policy/1";
// Same pacing as backend/app/execution.py: a 4 s window, token checked every 100 ms.
export const INSPECTION_MS = 4_000;
export const CHECKPOINT_MS = 100;
const RECEIPT_LIMIT = 50;
const ALLOWED: Record<string, [PlannedAction["capability"], PlannedAction["risk"]]> = {
  "fixture.replay": ["fixtures.read", "read_only"],
  "stop.enable": ["control.stop", "safety_control"],
  "stop.reset": ["control.reset", "safety_control"],
};

class StopRequested extends Error {}

function asciiJson(text: string): string {
  return text.replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return asciiJson(JSON.stringify(value));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${asciiJson(JSON.stringify(key))}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fingerprint(payload: unknown): Promise<string> {
  return sha256(canonicalJson(payload));
}

export function evaluatePolicy(action: PlannedAction, stop: StopState): PolicyDecision {
  const expected = ALLOWED[action.kind];
  const allowlisted =
    expected !== undefined && expected[0] === action.capability && expected[1] === action.risk;
  const stopOk = action.kind === "stop.enable" || action.kind === "stop.reset" || !stop.enabled;
  const checks: GateCheck[] = [
    { code: "capability.allowlisted", passed: allowlisted },
    { code: "executor.synthetic", passed: action.synthetic },
    { code: "stop.open-or-control", passed: stopOk },
    { code: "writes.denied", passed: action.risk !== "write" },
  ];
  const code = !stopOk
    ? "denied.stop-active"
    : !allowlisted
      ? "denied.capability"
      : !action.synthetic
        ? "denied.live-executor"
        : action.risk === "write"
          ? "denied.write"
          : "allowed.offline-proof";
  return {
    allowed: checks.every((check) => check.passed),
    code,
    policy_version: POLICY_VERSION,
    checks,
  };
}

export class StopController {
  private enabled = false;
  private reasonCode: string | null = null;
  private generation = 0;

  get state(): StopState {
    return { enabled: this.enabled, reason_code: this.reasonCode, generation: this.generation };
  }

  snapshot(): number {
    return this.generation;
  }

  enable(reasonCode = "operator-stop"): StopState {
    this.generation += 1;
    this.enabled = true;
    this.reasonCode = reasonCode;
    return this.state;
  }

  reset(): StopState {
    this.generation += 1;
    this.enabled = false;
    this.reasonCode = null;
    return this.state;
  }

  checkpoint(token: number): void {
    if (this.enabled || token !== this.generation)
      throw new StopRequested("execution invalidated by stop boundary");
  }
}

async function loadFixture(): Promise<{ result: DemoResult; sources: SourceProof[] }> {
  const result: DemoResult = {
    fixture_id: fixture.fixture_id,
    fixture_version: fixture.fixture_version,
    headline: fixture.headline,
    summary: fixture.summary,
    signals: fixture.signals as DemoResult["signals"],
    recommended_sequence: fixture.recommended_sequence,
    disclosure: "Embedded deterministic fixture; no network or live system was contacted.",
  };
  const sources = await Promise.all(
    fixture.sources.map(async (source): Promise<SourceProof> => ({
      source_id: source.source_id,
      label: source.label,
      captured_at: source.captured_at,
      fingerprint: await sha256(source.content),
      kind: "embedded_fixture",
    })),
  );
  return { result, sources };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function plannedAction(
  kind: PlannedAction["kind"],
  requestHash: string,
): { plan: ActionResponse["plan"]; action: PlannedAction } {
  const suffix = requestHash.slice(0, 16);
  const capability = ALLOWED[kind]![0];
  const action: PlannedAction = {
    action_id: `act_${suffix}`,
    kind,
    capability,
    risk: kind === "fixture.replay" ? "read_only" : "safety_control",
    synthetic: true,
    summary:
      kind === "fixture.replay"
        ? "Replay the embedded relay-recovery evidence bundle."
        : kind === "stop.enable"
          ? "Latch the stop boundary."
          : "Explicitly reset the local stop boundary.",
  };
  return { plan: { plan_id: `plan_${suffix}`, actions: [action] }, action };
}

export class Gateway {
  readonly stop = new StopController();
  private readonly ledger: Receipt[] = [];

  private readonly inspectionMs: number;

  constructor(inspectionMs = INSPECTION_MS) {
    this.inspectionMs = inspectionMs;
  }

  get receipts(): Receipt[] {
    return this.ledger.slice(0, RECEIPT_LIMIT);
  }

  async execute(
    request: { command: string; fixture_id: string },
    onEvent?: (event: RouteEvent) => void,
  ): Promise<ActionResponse> {
    const requestHash = await fingerprint(request);
    const { plan, action } = plannedAction("fixture.replay", requestHash);
    onEvent?.({ stage: "planned", action });
    const token = this.stop.snapshot();
    const decision = evaluatePolicy(action, this.stop.state);
    onEvent?.({ stage: "gated", policy: decision, generation: token });
    if (!decision.allowed) {
      const status = this.stop.state.enabled ? "stopped" : "blocked";
      const receipt = this.record(action, decision.code, status, requestHash, null);
      return { plan, policy: decision, result: null, sources: [], receipt };
    }
    try {
      this.stop.checkpoint(token);
      const { result, sources } = await this.run(token, onEvent);
      this.stop.checkpoint(token);
      const resultHash = await fingerprint({ result, sources });
      const receipt = this.record(action, decision.code, "completed", requestHash, resultHash);
      return { plan, policy: decision, result, sources, receipt };
    } catch (error) {
      if (!(error instanceof StopRequested)) {
        this.record(action, "failed.executor", "failed", requestHash, null);
        throw error;
      }
      const held: PolicyDecision = {
        allowed: false,
        code: "denied.stop-during-execution",
        policy_version: POLICY_VERSION,
        checks: [{ code: "stop.token-current", passed: false }],
      };
      const receipt = this.record(action, held.code, "stopped", requestHash, null);
      return { plan, policy: held, result: null, sources: [], receipt };
    }
  }

  async control(kind: "stop.enable" | "stop.reset", request: object): Promise<ControlResponse> {
    const requestHash = await fingerprint(request);
    const { action } = plannedAction(kind, requestHash);
    const decision = evaluatePolicy(action, this.stop.state);
    if (!decision.allowed) {
      const receipt = this.record(action, decision.code, "blocked", requestHash, null);
      return { state: this.stop.state, policy: decision, receipt };
    }
    const state = kind === "stop.enable" ? this.stop.enable("operator-stop") : this.stop.reset();
    const receipt = this.record(action, decision.code, "completed", requestHash, await fingerprint(state));
    return { state, policy: decision, receipt };
  }

  private async run(token: number, onEvent?: (event: RouteEvent) => void) {
    this.stop.checkpoint(token);
    await pause(0);
    this.stop.checkpoint(token);
    onEvent?.({ stage: "executing", inspectionMs: this.inspectionMs });
    // Deliberate pacing gives the operator time to exercise stop, as in the backend.
    const deadline = performance.now() + this.inspectionMs;
    let remaining: number;
    while ((remaining = deadline - performance.now()) > 0) {
      this.stop.checkpoint(token);
      await pause(Math.min(remaining, CHECKPOINT_MS));
      this.stop.checkpoint(token);
    }
    this.stop.checkpoint(token);
    const loaded = await loadFixture();
    this.stop.checkpoint(token);
    await pause(0);
    this.stop.checkpoint(token);
    return loaded;
  }

  private record(
    action: PlannedAction,
    policyCode: string,
    status: Receipt["status"],
    requestHash: string,
    resultHash: string | null,
  ): Receipt {
    const receipt: Receipt = {
      receipt_id: `rcpt_${crypto.randomUUID().replaceAll("-", "")}`,
      created_at: new Date().toISOString(),
      status,
      action_kind: action.kind,
      capability: action.capability,
      policy_code: policyCode,
      stop_generation: this.stop.state.generation,
      request_fingerprint: requestHash,
      result_fingerprint: resultHash,
      synthetic: action.synthetic,
    };
    this.ledger.unshift(receipt);
    return receipt;
  }
}

const LIMITATIONS = [
  "No network providers or live integrations are implemented.",
  "This hosted demo runs the policy gate and stop controller in your browser. Receipts live in this tab's memory.",
  "Receipts prove local processing metadata, not external-world truth.",
];

function invalid(): EngineReply {
  return {
    status: 422,
    payload: { code: "request.invalid", detail: "Request validation failed.", request_id: crypto.randomUUID().replaceAll("-", "") },
  };
}

function hasOnly(body: unknown, allowed: string[]): body is Record<string, unknown> {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.keys(body).every((key) => allowed.includes(key))
  );
}

function textBetween(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && [...value].length >= min && [...value].length <= max;
}

// Mirrors the FastAPI routes in backend/app/main.py, including request
// validation and the 403/423 status codes for held actions.
export async function handle(
  gateway: Gateway,
  method: string,
  path: string,
  body: unknown,
  onEvent?: (event: RouteEvent) => void,
): Promise<EngineReply> {
  if (method === "GET" && path === "/api/state") {
    const payload: SystemState = {
      mode: "offline-proof",
      stop: gateway.stop.state,
      capabilities: ["fixtures.read", "control.stop", "control.reset"],
      limitations: LIMITATIONS,
    };
    return { status: 200, payload };
  }
  if (method === "GET" && path === "/api/receipts")
    return { status: 200, payload: { receipts: gateway.receipts } };
  if (method === "POST" && path === "/api/actions") {
    if (!hasOnly(body, ["command", "fixture_id"]) || !textBetween(body.command, 3, 500)) return invalid();
    const fixtureId = body.fixture_id ?? "orbital-relay-recovery";
    if (fixtureId !== "orbital-relay-recovery") return invalid();
    const payload = await gateway.execute({ command: body.command, fixture_id: fixtureId }, onEvent);
    const status = payload.receipt.status === "stopped" ? 423 : payload.receipt.status === "blocked" ? 403 : 200;
    return { status, payload };
  }
  if (method === "POST" && path === "/api/stop") {
    if (!hasOnly(body, ["reason"])) return invalid();
    const reason = body.reason ?? "operator request";
    if (!textBetween(reason, 3, 120)) return invalid();
    return { status: 200, payload: await gateway.control("stop.enable", { reason }) };
  }
  if (method === "POST" && path === "/api/stop/reset") {
    if (!hasOnly(body, ["acknowledge"]) || body.acknowledge !== "resume synthetic execution") return invalid();
    return { status: 200, payload: await gateway.control("stop.reset", { acknowledge: body.acknowledge }) };
  }
  return { status: 404, payload: { detail: "Not Found" } };
}
