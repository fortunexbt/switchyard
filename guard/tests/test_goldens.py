from __future__ import annotations

import json
from pathlib import Path

import pytest

from switchyard_guard import Call, Policy, Risk, StopController, canonical_json, fingerprint

GOLDENS = json.loads((Path(__file__).resolve().parents[1] / "goldens.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", GOLDENS["fingerprints"], ids=lambda case: case["name"])
def test_fingerprint_goldens(case: dict) -> None:
    assert canonical_json(case["value"]) == case["canonical"]
    assert fingerprint(case["value"]) == case["sha256"]
    assert fingerprint(case["value"], GOLDENS["hmac_key"].encode()) == case["hmac_sha256"]


def test_policy_goldens() -> None:
    policy = Policy(GOLDENS["policy"]["grants"], budgets=GOLDENS["policy"]["budgets"])
    for case in GOLDENS["policy"]["cases"]:
        call = Call("tool", case["capability"], Risk.parse(case["risk"]), {})
        decision = policy.evaluate(call, stopped=case["stopped"], spent=case["spent"])
        assert (decision.allowed, decision.code) == (case["allowed"], case["code"]), case
        assert [[check.code, check.passed] for check in decision.checks] == case["checks"]


def test_stop_goldens() -> None:
    controller = StopController()
    first = controller.token()
    for step in GOLDENS["stop"]:
        kind, _, reason = step["op"].partition(":")
        changed = controller.latch(reason) if kind == "latch" else (controller.reset(), True)[1]
        state = controller.state
        assert changed == step["changed"], step
        assert {"latched": state.latched, "reason": state.reason, "generation": state.generation} == step["state"]
        assert controller.valid(first) == step["first_token_valid"]
        assert controller.valid(controller.token()) == step["fresh_token_valid"]
