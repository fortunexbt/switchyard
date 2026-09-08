import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  isActionResponse,
  isControlResponse,
  isReceiptPage,
  isSystemState,
  requestAction,
  requestJson,
  resolveApiBase,
} from "../src/lib/api.ts";

const fingerprint = "a".repeat(64);
const receipt = {
  receipt_id: "rcpt_example",
  created_at: "2026-09-08T12:00:00Z",
  status: "completed",
  action_kind: "fixture.replay",
  capability: "fixtures.read",
  policy_code: "allowed.offline-proof",
  stop_generation: 0,
  request_fingerprint: fingerprint,
  result_fingerprint: fingerprint,
  synthetic: true,
};
const system = {
  mode: "offline-proof",
  stop: { enabled: false, reason_code: null, generation: 0 },
  capabilities: ["fixtures.read", "control.stop", "control.reset"],
  limitations: ["No live integrations."],
};
const action = {
  plan: {
    plan_id: "plan_example",
    actions: [
      {
        action_id: "act_example",
        kind: "fixture.replay",
        capability: "fixtures.read",
        risk: "read_only",
        synthetic: true,
        summary: "Replay embedded evidence.",
      },
    ],
  },
  policy: {
    allowed: true,
    code: "allowed.offline-proof",
    policy_version: "switchyard-policy/1",
    checks: [{ code: "capability.allowlisted", passed: true }],
  },
  result: {
    fixture_id: "orbital-relay-recovery",
    fixture_version: "2026.07.1",
    headline: "Captured evidence",
    summary: "Replay complete.",
    signals: [{ label: "Relay", value: "Nominal", state: "nominal" }],
    recommended_sequence: ["Review evidence."],
    disclosure:
      "Embedded deterministic fixture; no network or live system was contacted.",
  },
  sources: [
    {
      source_id: "source_example",
      label: "Captured source",
      captured_at: "2026-07-01T00:00:00Z",
      fingerprint,
      kind: "embedded_fixture",
    },
  ],
  receipt,
};

function held(status: "blocked" | "stopped") {
  const code =
    status === "stopped" ? "denied.stop-active" : "denied.capability";
  return {
    ...action,
    policy: { ...action.policy, allowed: false, code },
    result: null,
    sources: [],
    receipt: {
      ...receipt,
      status,
      policy_code: code,
      result_fingerprint: null,
    },
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("validates the complete state and receipt page, including enum, date and hash boundaries", () => {
  assert.equal(isSystemState(system), true);
  assert.equal(isReceiptPage({ receipts: [receipt] }), true);
  for (const stop of [
    null,
    [],
    { enabled: "false", reason_code: null, generation: 0 },
    { ...system.stop, generation: -1 },
    { ...system.stop, generation: 0.5 },
    { ...system.stop, generation: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.equal(isSystemState({ ...system, stop }), false);
  }
  assert.equal(isSystemState({ ...system, capabilities: [42] }), false);
  assert.equal(isSystemState({ ...system, limitations: [null] }), false);
  assert.equal(isSystemState({ ...system, undeclared: true }), false);
  for (const change of [
    { status: "ready" },
    { created_at: "invalid-date" },
    { request_fingerprint: "short" },
    { result_fingerprint: 123 },
    { synthetic: "yes" },
    { capability: undefined },
  ]) {
    assert.equal(
      isReceiptPage({ receipts: [{ ...receipt, ...change }] }),
      false,
    );
  }
});

test("rejects malformed nested action data before the UI can render it", () => {
  assert.equal(isActionResponse(action), true);
  assert.equal(isActionResponse(held("stopped")), true);
  assert.equal(isActionResponse(held("blocked")), true);
  const malformed = [
    { ...action, plan: { plan_id: "p", actions: [] } },
    {
      ...action,
      plan: {
        plan_id: "p",
        actions: [{ ...action.plan.actions[0], risk: "imaginary" }],
      },
    },
    {
      ...action,
      policy: { ...action.policy, checks: [{ code: "gate", passed: "yes" }] },
    },
    {
      ...action,
      result: {
        ...action.result,
        signals: [{ label: "Relay", value: 3, state: "nominal" }],
      },
    },
    { ...action, result: { ...action.result, recommended_sequence: [null] } },
    {
      ...action,
      result: { ...action.result, disclosure: "Live verified output." },
    },
    {
      ...action,
      sources: [{ ...action.sources[0], fingerprint: "not-a-hash" }],
    },
    { ...action, receipt: { ...receipt, policy_code: "different.decision" } },
    { ...action, result: null },
    { ...held("blocked"), result: action.result },
  ];
  for (const value of malformed) assert.equal(isActionResponse(value), false);
});

test("control response requires consistent receipt generation and policy", () => {
  const control = { state: system.stop, policy: action.policy, receipt };
  assert.equal(isControlResponse(control), true);
  assert.equal(
    isControlResponse({ ...control, state: { ...system.stop, generation: 1 } }),
    false,
  );
  assert.equal(
    isControlResponse({
      ...control,
      policy: { ...action.policy, code: "mismatched" },
    }),
    false,
  );
});

test("accepts the documented blocked/stopped HTTP responses as actual receipts", async () => {
  for (const [status, body] of [
    [200, action],
    [403, held("blocked")],
    [423, held("stopped")],
  ] as const) {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), { status });
    assert.deepEqual(await requestAction("Replay this fixture"), body);
  }
});

test("rejects arbitrary errors even when their bodies resemble a valid receipt", async () => {
  for (const [status, body] of [
    [500, action],
    [409, held("stopped")],
    [403, action],
    [423, held("blocked")],
    [422, { code: "request.invalid" }],
  ] as const) {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), { status });
    await assert.rejects(requestAction("Replay this fixture"));
  }
  globalThis.fetch = async () => new Response("not JSON", { status: 200 });
  await assert.rejects(requestAction("Replay this fixture"));
});

test("every request omits credentials, referrers and cache and serializes the fixed fixture contract", async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/actions");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      command: "Replay the fixture",
      fixture_id: "orbital-relay-recovery",
    });
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(JSON.stringify(action));
  };
  await requestAction("Replay the fixture");
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.deepEqual(init?.headers, { "Content-Type": "application/json" });
    return new Response(JSON.stringify(system));
  };
  await requestJson("/api/state", isSystemState, {
    credentials: "include",
    referrerPolicy: "unsafe-url",
    headers: { Authorization: "should-not-leak" },
  });
});

test("API URL configuration admits HTTPS and loopback HTTP without embedded credentials", () => {
  assert.equal(resolveApiBase(), "");
  assert.equal(
    resolveApiBase(" http://127.0.0.1:8000/ "),
    "http://127.0.0.1:8000",
  );
  assert.equal(resolveApiBase("http://[::1]:8000"), "http://[::1]:8000");
  assert.equal(
    resolveApiBase("https://example.com/api/"),
    "https://example.com/api",
  );
  for (const url of [
    "http://example.com",
    "ftp://localhost",
    "https://user:password@example.com",
    "https://example.com?token=secret",
    "https://example.com#secret",
    "javascript:alert(1)",
  ]) {
    assert.throws(() => resolveApiBase(url));
  }
});
