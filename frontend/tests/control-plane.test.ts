import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createElement, act } from "react";
import { create } from "react-test-renderer";
import { useControlPlane } from "../src/hooks/useControlPlane.ts";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
let interval: (() => void) | null;
let plane: ReturnType<typeof useControlPlane>;
let renderer: ReturnType<typeof create>;
let pending: {
  path: string;
  reply: (body: unknown, status?: number) => void;
  fail: () => void;
}[];
const hash = "a".repeat(64);
const policy = {
  allowed: true,
  code: "allowed.offline-proof",
  policy_version: "switchyard-policy/1",
  checks: [],
};
const state = (enabled = false, generation = 0) => ({
  mode: "offline-proof",
  stop: { enabled, generation, reason_code: enabled ? "operator-stop" : null },
  capabilities: ["fixtures.read", "control.stop", "control.reset"],
  limitations: ["Embedded fixture only."],
});
function receipt(kind = "fixture.replay", generation = 0) {
  return {
    receipt_id: `receipt_${kind}_${generation}`,
    created_at: "2026-09-08T12:00:00Z",
    status: "completed",
    action_kind: kind,
    capability: kind === "stop.enable" ? "control.stop" : "fixtures.read",
    policy_code: policy.code,
    stop_generation: generation,
    request_fingerprint: hash,
    result_fingerprint: hash,
    synthetic: true,
  };
}
function take(path: string) {
  const index = pending.findIndex((request) => request.path === path);
  assert.notEqual(
    index,
    -1,
    `Expected pending ${path}; found ${pending.map((request) => request.path)}`,
  );
  return pending.splice(index, 1)[0]!;
}
async function replyReads(nextState = state(), receipts: unknown[] = []) {
  await act(async () => {
    take("/api/state").reply(nextState);
    take("/api/receipts").reply({ receipts });
  });
}
async function connect() {
  await act(async () => {
    renderer = create(
      createElement(function Probe() {
        plane = useControlPlane();
        return null;
      }),
    );
  });
  await replyReads();
  assert.equal(plane.connection, "connected");
}
beforeEach(() => {
  pending = [];
  interval = null;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Only the browser's recurring timer is controlled. React and the hook run normally.
  globalThis.window = {
    setInterval(callback: () => void) {
      interval = callback;
      return 1;
    },
    clearInterval() {
      interval = null;
    },
  };
  globalThis.fetch = (path: string) =>
    new Promise<Response>((resolve, reject) => {
      pending.push({
        path,
        reply: (body, status = 200) =>
          resolve(new Response(JSON.stringify(body), { status })),
        fail: () => reject(new Error("Offline")),
      });
    });
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
    for (const request of pending.splice(0)) request.fail();
  });
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
});

test("slow refresh settles control locks even when the polling timer fires while it is pending", async () => {
  await connect();
  let operation: Promise<void>;
  await act(async () => {
    operation = plane.stopNow();
  });
  assert.equal(plane.controlBusy, true);
  const stopReceipt = receipt("stop.enable", 1);
  await act(async () => {
    take("/api/stop").reply({
      state: state(true, 1).stop,
      policy,
      receipt: stopReceipt,
    });
  });
  assert.equal(plane.system?.stop.enabled, true);
  assert.equal(plane.controlBusy, true);
  // This models a response taking longer than the six-second polling interval.
  await act(async () => {
    interval!();
    interval!();
  });
  await replyReads(state(true, 1), [stopReceipt]);
  assert.equal(
    pending.length,
    0,
    "An ordinary timer tick must not queue another read behind the active refresh",
  );
  assert.equal(
    plane.controlBusy,
    false,
    "A confirmed stop must release its control lock",
  );
  await operation!;
});

test("duplicate replay is ignored, stop remains available, and a stale read cannot reopen the boundary", async () => {
  await connect();
  let execution: Promise<void>;
  let control: Promise<void>;
  await act(async () => {
    execution = plane.dispatch("Replay captured fixture");
    void plane.dispatch("Replay captured fixture");
  });
  assert.equal(
    pending.filter((request) => request.path === "/api/actions").length,
    1,
  );
  assert.equal(plane.busy, true);
  await act(async () => {
    interval!();
    control = plane.stopNow();
  });
  assert.equal(
    pending.filter((request) => request.path === "/api/stop").length,
    1,
  );
  const stopReceipt = receipt("stop.enable", 1);
  const heldReceipt = {
    ...receipt(),
    receipt_id: "receipt_held",
    status: "stopped",
    policy_code: "denied.stop-during-execution",
    stop_generation: 1,
    result_fingerprint: null,
  };
  await act(async () => {
    take("/api/stop").reply({
      state: state(true, 1).stop,
      policy,
      receipt: stopReceipt,
    });
    take("/api/actions").reply(
      {
        plan: {
          plan_id: "plan_held",
          actions: [
            {
              action_id: "action_held",
              kind: "fixture.replay",
              capability: "fixtures.read",
              risk: "read_only",
              synthetic: true,
              summary: "Replay fixture",
            },
          ],
        },
        policy: {
          ...policy,
          allowed: false,
          code: heldReceipt.policy_code,
          checks: [{ code: "stop.token-current", passed: false }],
        },
        result: null,
        sources: [],
        receipt: heldReceipt,
      },
      423,
    );
  });
  assert.equal(plane.system?.stop.enabled, true);
  await replyReads(state(false, 0));
  assert.equal(
    plane.system?.stop.enabled,
    true,
    "A pre-stop read must not overwrite the acknowledged control state",
  );
  await replyReads(state(true, 1), [heldReceipt, stopReceipt]);
  await Promise.all([execution!, control!]);
  assert.equal(plane.busy, false);
  assert.equal(plane.controlBusy, false);
  assert.equal(plane.outcome?.receipt.status, "stopped");
  assert.equal(plane.receipts.length, 2);
});

test("initial network failure prevents replay and a fresh read recovers the connection", async () => {
  await act(async () => {
    renderer = create(
      createElement(function Probe() {
        plane = useControlPlane();
        return null;
      }),
    );
  });
  await act(async () => {
    take("/api/state").fail();
    take("/api/receipts").fail();
  });
  assert.equal(plane.connection, "unavailable");
  await act(async () => {
    await plane.dispatch("Replay incident");
  });
  assert.equal(pending.length, 0);
  let refresh: Promise<void>;
  await act(async () => {
    refresh = plane.refresh();
  });
  await replyReads();
  await refresh!;
  assert.equal(plane.connection, "connected");
  assert.equal(plane.system?.stop.enabled, false);
});

test("unmount clears the recurring poll and pending reads cannot schedule another", async () => {
  await connect();
  await act(async () => {
    interval!();
    renderer.unmount();
  });
  assert.equal(interval, null);
  await replyReads();
  assert.equal(pending.length, 0);
});
