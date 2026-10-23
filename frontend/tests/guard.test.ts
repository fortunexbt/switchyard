import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import goldens from "../../guard/goldens.json" with { type: "json" };
import {
  BudgetExhausted,
  canonicalJson,
  Denied,
  fingerprint,
  Guard,
  Policy,
  StopController,
  Stopped,
  type Risk,
  type ToolContext,
} from "../src/lib/guard.ts";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    // A "wait forever" timer must not keep Node alive if a broken stop leaves it pending.
    if (ms > 10_000) timer.unref();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Fail instead of hanging if a stop never lands. */
function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still running ${ms} ms after the stop`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const swallowStop = (error: unknown) => {
  if (!(error instanceof Stopped)) throw error;
};

const makeGuard = () => new Guard(new Policy({ "job.run": "write" }));

test("fingerprint goldens match the Python package", async () => {
  const key = new TextEncoder().encode(goldens.hmac_key);
  for (const golden of goldens.fingerprints) {
    assert.equal(canonicalJson(golden.value), golden.canonical, golden.name);
    assert.equal(await fingerprint(golden.value), golden.sha256, golden.name);
    assert.equal(await fingerprint(golden.value, key), golden.hmac_sha256, golden.name);
  }
});

test("policy goldens match the Python package", () => {
  const policy = new Policy(goldens.policy.grants as Record<string, Risk>, [], { budgets: goldens.policy.budgets });
  for (const golden of goldens.policy.cases) {
    const call = { tool: "tool", capability: golden.capability, risk: golden.risk as Risk, args: {} };
    const decision = policy.evaluate(call, { stopped: golden.stopped, spent: golden.spent as Record<string, number> });
    assert.deepEqual([decision.allowed, decision.code], [golden.allowed, golden.code]);
    assert.deepEqual(decision.checks.map((check) => [check.code, check.passed]), golden.checks);
  }
});

test("stop controller goldens match the Python package", () => {
  const controller = new StopController();
  const first = controller.token();
  for (const golden of goldens.stop) {
    const [kind, reason] = golden.op.split(":");
    const changed = kind === "latch" ? controller.latch(reason) : (controller.reset(), true);
    assert.equal(changed, golden.changed, golden.op);
    assert.deepEqual(controller.state, golden.state);
    assert.equal(controller.valid(first), golden.first_token_valid);
    assert.equal(controller.valid(controller.token()), golden.fresh_token_valid);
  }
});

test("a denied call never runs, and an allowed one leaves a body-free receipt", async () => {
  const guard = new Guard(new Policy({ "fs.read": "read" }));
  let ran = 0;
  const remove = guard.gated("fs.delete", "destructive", async () => void ran++, { name: "remove" });
  const read = guard.gated("fs.read", "read", async ({ path }: { path: string }) => `contents of ${path}`, {
    name: "read",
  });
  await assert.rejects(remove({ path: "x" }), (error: unknown) => error instanceof Denied && error.decision.code === "denied.capability");
  assert.equal(ran, 0);
  assert.equal(await read({ path: "private-notes.md" }), "contents of private-notes.md");
  const [receipt] = guard.ledger.recent();
  assert.equal(receipt?.args_fingerprint, await fingerprint({ path: "private-notes.md" }));
  assert.ok(!JSON.stringify(guard.ledger.recent()).includes("private-notes"));
});

test("a commit block must be synchronous", () => {
  const controller = new StopController();
  assert.throws(() => controller.commit(controller.token(), () => Promise.resolve()), TypeError);
});

// Guarantee 1: no side effect commits after the stop latches.
test("property: no side effect commits after the stop latches", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 1, max: 20 }),
      fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 5 }),
      fc.integer({ min: 0, max: 15 }),
      fc.boolean(),
      fc.boolean(),
      async (workers, units, delays, stopAfter, signalAware, resetAfter) => {
        const guard = makeGuard();
        const log: string[] = [];
        const job = guard.gated(
          "job.run",
          "write",
          async ({ worker }: { worker: number }, ctx: ToolContext) => {
            for (let unit = 0; unit < units; unit++) {
              ctx.checkpoint();
              await sleep(delays[unit % delays.length]!, signalAware ? ctx.signal : undefined);
              ctx.commit(() => log.push(`commit ${worker}.${unit}`));
            }
            return worker;
          },
          { name: "job" },
        );
        const runs = Array.from({ length: workers }, (_, worker) => job({ worker }).catch(swallowStop));
        await sleep(stopAfter);
        const receipt = guard.stop();
        log.push("stopped");
        if (resetAfter) void guard.reset();
        await within(Promise.all([...runs, receipt]));
        assert.deepEqual(log.slice(log.indexOf("stopped")).filter((event) => event.startsWith("commit")), []);
      },
    ),
    { numRuns: 60 },
  );
});

// Guarantee 2: a stale generation cannot resurrect a run.
test("property: a stale generation never commits or returns", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom("stop", "reset", "admit"), { minLength: 1, maxLength: 8 }),
      fc.integer({ min: 0, max: 4 }),
      async (ops, gap) => {
        const guard = makeGuard();
        type Event = { kind: "transition"; generation: number } | { kind: "commit"; call: number; token: number; seen: number };
        const log: Event[] = [];
        const tokens = new Map<number, number>();
        const outcomes = new Map<number, string>();
        let finished = false;
        const job = guard.gated(
          "job.run",
          "write",
          async ({ call }: { call: number }, ctx: ToolContext) => {
            const token = guard.state.generation; // no await between admission and here
            tokens.set(call, token);
            while (!finished) {
              ctx.checkpoint();
              ctx.commit(() => log.push({ kind: "commit", call, token, seen: guard.state.generation }));
              await sleep(1);
            }
            return call;
          },
          { name: "job" },
        );
        const runs: Promise<void>[] = [];
        for (const [index, op] of [...ops, "admit"].entries()) {
          if (op === "admit")
            runs.push(
              job({ call: index }).then(
                () => void outcomes.set(index, "returned"),
                (error: unknown) => {
                  swallowStop(error);
                  outcomes.set(index, (error as Stopped).receipt?.code ?? "stopped");
                },
              ),
            );
          else if (op === "stop") void guard.stop();
          else void guard.reset();
          log.push({ kind: "transition", generation: guard.state.generation });
          await sleep(gap);
        }
        finished = true;
        await within(Promise.all(runs));

        let newest = 0;
        for (const event of log) {
          if (event.kind === "transition") newest = Math.max(newest, event.generation);
          else assert.ok(event.seen === event.token && event.token >= newest, JSON.stringify({ event, newest }));
        }
        const final = guard.state;
        for (const [call, outcome] of outcomes)
          if (outcome === "returned") assert.ok(tokens.get(call) === final.generation && !final.latched);
      },
    ),
    { numRuns: 40 },
  );
});

// Guarantee 3: pressing stop many times equals pressing it once.
test("property: double stop is idempotent", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 8 }),
      fc.integer({ min: 0, max: 4 }),
      async (pressDelays, calls) => {
        const guard = makeGuard();
        const latches: number[] = [];
        guard.controller.onLatch((state) => latches.push(state.generation));
        const wait = guard.gated("job.run", "write", (_: { call: number }, ctx: ToolContext) => sleep(3_600_000, ctx.signal), {
          name: "wait",
        });
        const runs = Array.from({ length: calls }, (_, call) => wait({ call }).catch(swallowStop));
        await sleep(1);
        const receipts = await Promise.all(pressDelays.map(async (delay, press) => {
          await sleep(delay);
          return guard.stop(`press-${press}`);
        }));
        await within(Promise.all(runs));
        assert.deepEqual([guard.state.latched, guard.state.generation], [true, 1]);
        assert.deepEqual(latches, [1]);
        assert.deepEqual(
          receipts.map((receipt) => receipt.code).sort(),
          ["allowed", ...Array(pressDelays.length - 1).fill("allowed.already-latched")],
        );
        const stopped = guard.ledger.recent(1000).filter((receipt) => receipt.tool === "wait");
        assert.equal(stopped.length, calls);
        assert.ok(stopped.every((receipt) => receipt.code === "stopped.in-flight"));
      },
    ),
    { numRuns: 60 },
  );
});

// Guarantee 4: a stopped call halts at the first checkpoint it reaches after the latch, so
// within one checkpoint gap. Measured against the gaps the tool actually had, not a fixed
// slack, so a loaded machine slows both sides alike.
test("property: time to halt is bounded by the checkpoint gap", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 40 }), async (gap, stopAfter) => {
      const guard = makeGuard();
      const stamps: number[] = []; // when each checkpoint was reached
      let haltedAt: number | undefined;
      const job = guard.gated(
        "job.run",
        "write",
        async (_: Record<string, never>, ctx: ToolContext) => {
          const giveUp = performance.now() + 1_000; // so a stop that never lands fails instead of hanging
          while (performance.now() < giveUp) {
            stamps.push(performance.now());
            try {
              ctx.checkpoint();
            } catch (error) {
              haltedAt = stamps.at(-1);
              throw error;
            }
            await sleep(gap); // ignores the signal, so only the checkpoint can end it
          }
        },
        { name: "job" },
      );
      const run = job({}).catch(swallowStop);
      await sleep(stopAfter);
      void guard.stop(); // latches synchronously
      const latchedAt = performance.now();
      await within(run);
      assert.ok(haltedAt !== undefined, "the call never halted at a checkpoint");
      // At most one checkpoint is reached after the latch: the one that throws.
      assert.ok(stamps.filter((stamp) => stamp >= latchedAt).length <= 1);
      const longestGap = Math.max(...stamps.slice(1).map((stamp, index) => stamp - stamps[index]!), 0);
      assert.ok(haltedAt - latchedAt <= longestGap, `halted ${haltedAt - latchedAt} ms after stop, longest gap ${longestGap} ms`);
    }),
    { numRuns: 30 },
  );
});

test("property: a call waiting on its signal halts before any timer runs", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 40 }), async (stopAfter) => {
      const guard = makeGuard();
      let abortedAt: number | undefined;
      const hang = guard.gated(
        "job.run",
        "write",
        async (_: Record<string, never>, ctx: ToolContext) => {
          try {
            await sleep(3_600_000, ctx.signal);
          } catch (error) {
            abortedAt = performance.now();
            throw error;
          }
        },
        { name: "hang" },
      );
      const run = hang({}).catch(swallowStop);
      await sleep(stopAfter);
      void guard.stop();
      // The abort reaches the tool in microtasks, before the event loop gets to this timer.
      const timerAt = await new Promise<number>((resolve) => setTimeout(() => resolve(performance.now()), 0));
      await within(run);
      assert.ok(abortedAt !== undefined && abortedAt <= timerAt);
    }),
    { numRuns: 30 },
  );
});

// Guarantee 5: once a capability's budget is spent, no call to it executes.
test("property: no call executes once the budget is spent", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 8 }),
      fc.integer({ min: 1, max: 8 }),
      fc.array(fc.integer({ min: -3, max: 50 }), { minLength: 1, maxLength: 6 }),
      fc.boolean(),
      async (budget, callers, amounts, stopAndReset) => {
        const positive = { name: "amount.positive", check: (call: { args: Record<string, unknown> }) => (call.args.amount as number) > 0 };
        const guard = new Guard(new Policy({ "bank.transfer": "write" }, [positive], { budgets: { "bank.transfer": budget } }));
        const executed: number[] = [];
        const transfer = guard.gated(
          "bank.transfer",
          "write",
          async ({ amount }: { amount: number }) => {
            executed.push(amount);
            await sleep(0);
            return amount;
          },
          { name: "transfer" },
        );
        const outcomes: [boolean, string][] = [];
        await Promise.all(
          Array.from({ length: callers }, async () => {
            for (const amount of amounts) {
              try {
                await transfer({ amount });
                outcomes.push([amount > 0, "ran"]);
              } catch (error) {
                if (error instanceof BudgetExhausted) outcomes.push([amount > 0, "budget"]);
                else if (error instanceof Denied) outcomes.push([amount > 0, error.decision.code]);
                else throw error;
              }
            }
          }),
        );
        const valid = outcomes.filter(([isValid]) => isValid).map(([, code]) => code);
        const invalid = outcomes.filter(([isValid]) => !isValid).map(([, code]) => code);
        assert.equal(executed.length, Math.min(budget, valid.length));
        assert.equal(valid.filter((code) => code === "ran").length, executed.length);
        assert.equal(valid.filter((code) => code === "budget").length, valid.length - executed.length);
        assert.ok(invalid.every((code) => code === "denied.rule.amount.positive" || code === "budget"));
        assert.equal(guard.spent["bank.transfer"] ?? 0, executed.length);
        if (stopAndReset) {
          await guard.stop();
          await guard.reset(); // Reopening the stop does not refill the budget.
        }
        if (executed.length === budget) {
          await assert.rejects(transfer({ amount: 1 }), BudgetExhausted);
          assert.equal(executed.length, budget);
        }
      },
    ),
    { numRuns: 60 },
  );
});
