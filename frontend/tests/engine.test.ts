import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluatePolicy,
  fingerprint,
  Gateway,
  handle,
  type RouteEvent,
} from "../src/lib/engine.ts";
import { isActionResponse, isControlResponse, isReceiptPage, isSystemState } from "../src/lib/api.ts";

// Produced by backend/app/execution.py fingerprint(); the backend suite asserts the same values.
const GOLDEN = {
  result: "440cfd9feaf44d014d80d6fd273032e4f1372bf0229f151e2a64fa4d47063b08",
  sources: [
    "24c6f4f3cf9c7ad0fb902c81f62be1cf98ced093c2b0fd1abd0abc114100520c",
    "4976a93d332966e49150bb56aa32714b23025ae0f3ce7ee4235aaf64d5259ed8",
    "1f9b4178e36e336fc3f707db5daa3983ef2077d3e571987280b8f43692ac23b9",
  ],
  defaultRequest: "a5a993fb32cc5363c25005e7c2896151f31a1dfc88cfb2c551cef982559235a3",
  unicodeRequest: "14265a28e0303defc6db3eadc62b722e81bc00abfb54b46dd1b3954af4fc1d21",
  stopState: "b2d06d67ec5fa59585e6911b2e966f9210e940b839c687246136f3c32312b428",
};
const COMMAND = "Trace the safest recovery route for the captured orbital relay incident.";

const post = (gateway: Gateway, path: string, body: unknown, onEvent?: (event: RouteEvent) => void) =>
  handle(gateway, "POST", path, body, onEvent);

test("fingerprints are byte-compatible with the Python backend", async () => {
  assert.equal(
    await fingerprint({ command: COMMAND, fixture_id: "orbital-relay-recovery" }),
    GOLDEN.defaultRequest,
  );
  assert.equal(
    await fingerprint({ command: 'Relay 07 — drift ü 🛰 \x7f\n"q"', fixture_id: "orbital-relay-recovery" }),
    GOLDEN.unicodeRequest,
  );
  assert.equal(
    await fingerprint({ enabled: true, reason_code: "operator-stop", generation: 1 }),
    GOLDEN.stopState,
  );
});

test("an admitted replay passes every gate check and seals the Python result fingerprint", async () => {
  const gateway = new Gateway(0);
  const events: RouteEvent["stage"][] = [];
  const reply = await post(gateway, "/api/actions", { command: COMMAND }, (event) => events.push(event.stage));
  assert.equal(reply.status, 200);
  assert.ok(isActionResponse(reply.payload));
  const { policy, receipt, sources, plan } = reply.payload;
  assert.deepEqual(events, ["planned", "gated", "executing"]);
  assert.equal(policy.code, "allowed.offline-proof");
  assert.ok(policy.checks.every((check) => check.passed));
  assert.equal(plan.plan_id, `plan_${GOLDEN.defaultRequest.slice(0, 16)}`);
  assert.deepEqual(sources.map((source) => source.fingerprint), GOLDEN.sources);
  assert.equal(receipt.request_fingerprint, GOLDEN.defaultRequest);
  assert.equal(receipt.result_fingerprint, GOLDEN.result);
  assert.equal(receipt.stop_generation, 0);
  const page = (await handle(gateway, "GET", "/api/receipts", undefined)).payload;
  assert.ok(isReceiptPage(page));
  assert.equal(page.receipts.length, 1);
});

test("stop during the inspection window invalidates the token and releases nothing", async () => {
  const gateway = new Gateway(5_000);
  let executing!: () => void;
  const started = new Promise<void>((resolve) => (executing = resolve));
  const pending = post(gateway, "/api/actions", { command: COMMAND }, (event) => {
    if (event.stage === "executing") executing();
  });
  await started;
  const stop = await post(gateway, "/api/stop", { reason: "operator console stop" });
  assert.ok(isControlResponse(stop.payload));
  assert.equal(stop.payload.state.generation, 1);
  const reply = await pending;
  assert.equal(reply.status, 423);
  assert.ok(isActionResponse(reply.payload));
  assert.equal(reply.payload.policy.code, "denied.stop-during-execution");
  assert.deepEqual(reply.payload.policy.checks, [{ code: "stop.token-current", passed: false }]);
  assert.equal(reply.payload.result, null);
  assert.equal(reply.payload.sources.length, 0);
  assert.equal(reply.payload.receipt.result_fingerprint, null);
});

test("the gate denies a replay while the stop is latched, and reset needs the exact acknowledgement", async () => {
  const gateway = new Gateway(0);
  await post(gateway, "/api/stop", {});
  const held = await post(gateway, "/api/actions", { command: COMMAND });
  assert.equal(held.status, 423);
  assert.ok(isActionResponse(held.payload));
  assert.equal(held.payload.policy.code, "denied.stop-active");
  assert.deepEqual(
    held.payload.policy.checks.filter((check) => !check.passed).map((check) => check.code),
    ["stop.open-or-control"],
  );

  assert.equal((await post(gateway, "/api/stop/reset", { acknowledge: "yes" })).status, 422);
  const reset = await post(gateway, "/api/stop/reset", { acknowledge: "resume synthetic execution" });
  assert.ok(isControlResponse(reset.payload));
  assert.deepEqual(reset.payload.state, { enabled: false, reason_code: null, generation: 2 });
  const state = (await handle(gateway, "GET", "/api/state", undefined)).payload;
  assert.ok(isSystemState(state));
  assert.equal(state.stop.generation, 2);
});

test("requests outside the contract are rejected before they reach the gate", async () => {
  const gateway = new Gateway(0);
  for (const body of [{ command: "hi" }, { command: COMMAND, extra: true }, { command: COMMAND, fixture_id: "other" }])
    assert.equal((await post(gateway, "/api/actions", body)).status, 422);
  assert.equal(gateway.receipts.length, 0);
});

test("the policy denies writes, unknown capabilities and live executors", () => {
  const open = { enabled: false, reason_code: null, generation: 0 };
  const base = {
    action_id: "act",
    kind: "fixture.replay" as const,
    capability: "fixtures.read" as const,
    risk: "read_only" as const,
    synthetic: true,
    summary: "",
  };
  assert.equal(evaluatePolicy({ ...base, risk: "write" }, open).code, "denied.capability");
  assert.equal(evaluatePolicy({ ...base, capability: "control.stop" }, open).code, "denied.capability");
  assert.equal(evaluatePolicy({ ...base, synthetic: false }, open).code, "denied.live-executor");
  assert.equal(evaluatePolicy({ ...base, kind: "stop.enable", capability: "control.stop", risk: "safety_control" }, { ...open, enabled: true }).code, "allowed.offline-proof");
});
