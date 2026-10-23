// TypeScript port of guard/src/switchyard_guard: the stop controller, the policy gate and
// gated tool wrappers. guard/goldens.json pins both implementations to the same bytes.

export type Risk = "read" | "write" | "destructive";
const RISK_ORDER: Record<Risk, number> = { read: 1, write: 2, destructive: 3 };

export type StopState = { latched: boolean; reason: string | null; generation: number };

export type Status = "completed" | "blocked" | "stopped" | "failed";

export type Receipt = {
  receipt_id: string;
  created_at: string;
  tool: string;
  capability: string;
  risk: string;
  status: Status;
  code: string;
  stop_generation: number;
  args_fingerprint: string | null;
  result_fingerprint: string | null;
  duration_ms: number | null;
};

/** The stop is latched or was pressed mid-call. */
export class Stopped extends Error {
  readonly receipt: Receipt | null;

  constructor(receipt: Receipt | null = null) {
    super(receipt ? `${receipt.tool} stopped: ${receipt.code}` : "stopped");
    this.name = "Stopped";
    this.receipt = receipt;
  }
}

/** The gate refused the call before it ran. */
export class Denied extends Error {
  readonly receipt: Receipt;
  readonly decision: Decision;

  constructor(receipt: Receipt, decision: Decision) {
    super(`${receipt.tool} denied: ${decision.code}`);
    this.name = "Denied";
    this.receipt = receipt;
    this.decision = decision;
  }
}

/**
 * The stop switch. A token is the generation it was issued at, and it stays valid only while
 * the stop is open and no stop or reset has happened since. JavaScript runs one callback at a
 * time, so a commit block (which must be synchronous) cannot interleave with a latch.
 */
export class StopController {
  private latched: boolean;
  private reason: string | null;
  private generation: number;
  private readonly listeners: ((state: StopState) => void)[] = [];

  constructor({ latched = false }: { latched?: boolean } = {}) {
    this.latched = latched;
    this.reason = latched ? "configured-stop" : null;
    this.generation = latched ? 1 : 0;
  }

  get state(): StopState {
    return { latched: this.latched, reason: this.reason, generation: this.generation };
  }

  token(): number {
    return this.generation;
  }

  valid(token: number): boolean {
    return !this.latched && token === this.generation;
  }

  check(token: number): void {
    if (!this.valid(token)) throw new Stopped();
  }

  /** Run a synchronous side effect only if the token is still valid. */
  commit<T>(token: number, effect: () => T): T {
    this.check(token);
    const result = effect();
    if (result instanceof Promise) throw new TypeError("commit blocks must be synchronous");
    return result;
  }

  /** Latch the stop. Returns false, and changes nothing, if it was already latched. */
  latch(reason = "operator-stop"): boolean {
    if (this.latched) return false;
    this.generation += 1;
    this.latched = true;
    this.reason = reason;
    const state = this.state;
    for (const listener of this.listeners) listener(state);
    return true;
  }

  /** Open the stop. The generation moves on, so no token issued before this call works again. */
  reset(): StopState {
    this.generation += 1;
    this.latched = false;
    this.reason = null;
    return this.state;
  }

  onLatch(listener: (state: StopState) => void): void {
    this.listeners.push(listener);
  }
}

export type Call<A> = { tool: string; capability: string; risk: Risk; args: Readonly<A> };
export type Rule = {
  name: string;
  check: (call: Call<Record<string, unknown>>) => boolean;
  capabilities?: readonly string[];
};
export type Check = { code: string; passed: boolean };
export type Decision = { allowed: boolean; code: string; checks: Check[] };

/**
 * Deny by default: a capability runs only if granted, at or below its granted risk, and while
 * its budget (a maximum number of calls, if one is set) has calls left. A budget is a hard
 * limit enforced before the call runs, with no warning mode.
 */
export class Policy {
  private readonly grants: Map<string, Risk>;
  private readonly rules: readonly Rule[];
  private readonly budgets: Map<string, number>;

  constructor(
    grants: Record<string, Risk>,
    rules: readonly Rule[] = [],
    { budgets = {} }: { budgets?: Record<string, number> } = {},
  ) {
    this.grants = new Map(Object.entries(grants));
    this.rules = rules;
    this.budgets = new Map(Object.entries(budgets));
    if ([...this.budgets.values()].some((limit) => limit < 0)) throw new RangeError("budgets must be non-negative");
  }

  /** Decide one call. `spent` is how many calls each capability has already been admitted. */
  evaluate(
    call: Call<Record<string, unknown>>,
    { stopped, spent = {} }: { stopped: boolean; spent?: Readonly<Record<string, number>> },
  ): Decision {
    const granted = this.grants.get(call.capability);
    const limit = this.budgets.get(call.capability);
    const checks: Check[] = [
      { code: "stop.open", passed: !stopped },
      { code: "capability.granted", passed: granted !== undefined },
      {
        code: "risk.within-grant",
        passed: granted !== undefined && RISK_ORDER[call.risk] <= RISK_ORDER[granted],
      },
      ...(limit === undefined ? [] : [{ code: "budget.remaining", passed: (spent[call.capability] ?? 0) < limit }]),
      ...this.rules
        .filter((rule) => rule.capabilities === undefined || rule.capabilities.includes(call.capability))
        .map((rule) => ({ code: `rule.${rule.name}`, passed: passes(rule, call) })),
    ];
    const failed = checks.find((check) => !check.passed);
    if (failed === undefined) return { allowed: true, code: "allowed", checks };
    const named: Record<string, string> = {
      "stop.open": "denied.stop-active",
      "capability.granted": "denied.capability",
      "risk.within-grant": "denied.risk",
      "budget.remaining": "denied.budget",
    };
    return { allowed: false, code: named[failed.code] ?? `denied.${failed.code}`, checks };
  }
}

function passes(rule: Rule, call: Call<Record<string, unknown>>): boolean {
  try {
    return rule.check(call) === true;
  } catch {
    return false; // A rule that cannot decide fails closed.
  }
}

function asciiJson(text: string): string {
  return text.replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Sorted keys, no whitespace, ASCII only. Matches canonical_json in the Python package. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return asciiJson(JSON.stringify(value) ?? "null");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${asciiJson(JSON.stringify(key))}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** SHA-256 of the canonical JSON, or HMAC-SHA256 when a key is given. */
export async function fingerprint(value: unknown, key?: Uint8Array<ArrayBuffer>): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(value));
  if (key === undefined) return hex(await crypto.subtle.digest("SHA-256", data));
  const hmacKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", hmacKey, data));
}

export interface Ledger {
  append(receipt: Receipt): void;
  recent(limit?: number): Receipt[];
}

export class MemoryLedger implements Ledger {
  private readonly rows: Receipt[] = [];

  append(receipt: Receipt): void {
    this.rows.push(receipt);
  }

  recent(limit = 50): Receipt[] {
    return this.rows.slice().reverse().slice(0, limit);
  }
}

/** What a gated tool receives besides its arguments. */
export type ToolContext = {
  /** Aborted the moment the stop latches. Pass it to fetch and other abortable waits. */
  signal: AbortSignal;
  /** Throws Stopped if this call has been stopped. Call it between units of work. */
  checkpoint(): void;
  /** Runs a synchronous side effect only if this call has not been stopped. */
  commit<T>(effect: () => T): T;
};

/** The capability's call budget is spent. Thrown before the call runs, like any denial. */
export class BudgetExhausted extends Denied {
  constructor(receipt: Receipt, decision: Decision) {
    super(receipt, decision);
    this.name = "BudgetExhausted";
  }
}

/** Gates tool calls against a policy, lets any of them be stopped, and writes a receipt per call. */
export class Guard {
  readonly policy: Policy;
  readonly ledger: Ledger;
  readonly controller: StopController;
  private readonly key: Uint8Array<ArrayBuffer> | undefined;
  private readonly inFlight = new Set<AbortController>();
  private readonly spentCalls: Record<string, number> = {};

  constructor(
    policy: Policy,
    { ledger, stop, fingerprintKey }: { ledger?: Ledger; stop?: StopController; fingerprintKey?: Uint8Array<ArrayBuffer> } = {},
  ) {
    this.policy = policy;
    this.ledger = ledger ?? new MemoryLedger();
    this.controller = stop ?? new StopController();
    this.key = fingerprintKey;
    this.controller.onLatch(() => {
      for (const call of this.inFlight) call.abort(new Stopped());
    });
  }

  get state(): StopState {
    return this.controller.state;
  }

  /** Calls admitted so far per capability, which is what budgets count. */
  get spent(): Record<string, number> {
    return { ...this.spentCalls };
  }

  /** Latch the stop now. The returned promise resolves once the receipt is written. */
  stop(reason = "operator-stop"): Promise<Receipt> {
    const latchedNow = this.controller.latch(reason);
    return this.recordControl("guard.stop", "control.stop", latchedNow ? "allowed" : "allowed.already-latched");
  }

  /** Reopen the gate for new calls. Calls admitted before the reset stay invalid. */
  reset(): Promise<Receipt> {
    this.controller.reset();
    return this.recordControl("guard.reset", "control.reset", "allowed");
  }

  gated<A extends Record<string, unknown>, R>(
    capability: string,
    risk: Risk,
    tool: (args: A, context: ToolContext) => R | Promise<R>,
    { name = tool.name || "anonymous" }: { name?: string } = {},
  ): (args: A) => Promise<R> {
    return async (args: A) => {
      const call: Call<A> = { tool: name, capability, risk, args: Object.freeze({ ...args }) };
      const token = this.controller.token();
      const started = performance.now();
      // Deciding and spending budget happen in one synchronous step, so no other call can be
      // admitted in between and overspend.
      const decision = this.policy.evaluate(call, { stopped: !this.controller.valid(token), spent: this.spentCalls });
      if (decision.allowed) this.spentCalls[capability] = (this.spentCalls[capability] ?? 0) + 1;
      else {
        const stopped = decision.code === "denied.stop-active";
        const receipt = await this.record(call, stopped ? "stopped" : "blocked", decision.code, null, started);
        if (stopped) throw new Stopped(receipt);
        throw decision.code === "denied.budget" ? new BudgetExhausted(receipt, decision) : new Denied(receipt, decision);
      }
      const abort = new AbortController();
      this.inFlight.add(abort);
      const context: ToolContext = {
        signal: abort.signal,
        checkpoint: () => this.controller.check(token),
        commit: (effect) => this.controller.commit(token, effect),
      };
      let result: R;
      try {
        result = await tool(call.args as A, context);
      } catch (error) {
        // Only this call's own signal is aborted by a stop, so any rejection after it is a stop.
        if (error instanceof Stopped || abort.signal.aborted)
          throw new Stopped(await this.record(call, "stopped", "stopped.in-flight", null, started));
        await this.record(call, "failed", "failed.exception", null, started);
        throw error;
      } finally {
        this.inFlight.delete(abort);
      }
      // A stop pressed while the tool ran withholds the result even if the tool finished.
      if (!this.controller.valid(token))
        throw new Stopped(await this.record(call, "stopped", "stopped.after-return", null, started));
      const resultHash = await fingerprint(result, this.key);
      await this.record(call, "completed", "allowed", resultHash, started, token);
      return result;
    };
  }

  private async record(
    call: Call<Record<string, unknown>>,
    status: Status,
    code: string,
    resultFingerprint: string | null,
    started: number,
    generation = this.controller.token(),
  ): Promise<Receipt> {
    return this.append({
      receipt_id: `rcpt_${crypto.randomUUID().replaceAll("-", "")}`,
      created_at: new Date().toISOString(),
      tool: call.tool,
      capability: call.capability,
      risk: call.risk,
      status,
      code,
      stop_generation: generation,
      args_fingerprint: await fingerprint(call.args, this.key),
      result_fingerprint: resultFingerprint,
      duration_ms: Math.round((performance.now() - started) * 1000) / 1000,
    });
  }

  private async recordControl(tool: string, capability: string, code: string): Promise<Receipt> {
    const state = this.controller.state;
    return this.append({
      receipt_id: `rcpt_${crypto.randomUUID().replaceAll("-", "")}`,
      created_at: new Date().toISOString(),
      tool,
      capability,
      risk: "control",
      status: "completed",
      code,
      stop_generation: state.generation,
      args_fingerprint: null,
      result_fingerprint: await fingerprint(
        { enabled: state.latched, reason_code: state.reason, generation: state.generation },
        this.key,
      ),
      duration_ms: null,
    });
  }

  private append(receipt: Receipt): Receipt {
    try {
      this.ledger.append(receipt);
    } catch (error) {
      // Losing the audit trail fails safe: nothing else runs until someone resets.
      this.controller.latch("ledger-write-failed");
      throw error;
    }
    return receipt;
  }
}
