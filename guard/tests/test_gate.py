from __future__ import annotations

import inspect
import sqlite3
from dataclasses import asdict
from pathlib import Path

import pytest

from switchyard_guard import (
    Call,
    Denied,
    Guard,
    MemoryLedger,
    Policy,
    Risk,
    Rule,
    SQLiteLedger,
    Stopped,
    fingerprint,
)

SECRET = "sk-live-4f1c9e-never-store-me"


def make_guard(**grants: str) -> Guard:
    return Guard(Policy({key.replace("_", "."): risk for key, risk in grants.items()}))


def test_an_allowed_call_runs_once_and_leaves_a_body_free_receipt() -> None:
    guard = make_guard(kv_read="read")
    calls = []

    @guard.gated("kv.read", "read")
    def lookup(key: str, default: str = "none") -> str:
        calls.append(key)
        return f"value for {key}"

    assert lookup(SECRET) == f"value for {SECRET}"
    assert calls == [SECRET]
    [receipt] = guard.ledger.recent()
    assert receipt.status == "completed"
    assert receipt.code == "allowed"
    assert receipt.tool == "lookup"
    assert receipt.risk == "read"
    assert receipt.args_fingerprint == fingerprint({"key": SECRET, "default": "none"})
    assert receipt.result_fingerprint == fingerprint(f"value for {SECRET}")
    assert SECRET not in repr(asdict(receipt))


def test_ungranted_capability_is_denied_without_running_the_tool() -> None:
    guard = make_guard(kv_read="read")
    ran = []

    @guard.gated("kv.delete", "destructive")
    def drop(key: str) -> None:
        ran.append(key)

    with pytest.raises(Denied) as denied:
        drop("users")
    assert ran == []
    assert denied.value.decision.code == "denied.capability"
    assert denied.value.receipt.status == "blocked"
    assert denied.value.receipt.result_fingerprint is None


def test_declared_risk_above_the_grant_is_denied() -> None:
    guard = make_guard(kv_write="read")

    @guard.gated("kv.write", Risk.WRITE)
    def put(key: str, value: str) -> None:
        raise AssertionError("must not run")

    with pytest.raises(Denied) as denied:
        put("a", "b")
    assert denied.value.decision.code == "denied.risk"
    checks = {check.code: check.passed for check in denied.value.decision.checks}
    assert checks == {"stop.open": True, "capability.granted": True, "risk.within-grant": False}


def test_rules_judge_the_real_arguments(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    (root / "notes.txt").write_text("ok", encoding="utf-8")
    inside = Rule(
        "path.inside-root",
        lambda call: (root / call.args["path"]).resolve().is_relative_to(root),
        frozenset({"fs.read"}),
    )
    guard = Guard(Policy({"fs.read": "read"}, [inside]))

    @guard.gated("fs.read")
    def read(path: str) -> str:
        return (root / path).read_text(encoding="utf-8")

    assert read("notes.txt") == "ok"
    for escape in ("../outside.txt", "/etc/passwd", "sub/../../x"):
        with pytest.raises(Denied) as denied:
            read(escape)
        assert denied.value.decision.code == "denied.rule.path.inside-root"


def test_a_rule_that_raises_fails_closed() -> None:
    guard = Guard(Policy({"kv.read": "read"}, [Rule("needs-tenant", lambda call: call.args["tenant"] == "a")]))

    @guard.gated("kv.read")
    def get(key: str) -> str:
        return key

    with pytest.raises(Denied) as denied:
        get("k")  # no "tenant" argument, so the rule raises KeyError
    assert denied.value.decision.code == "denied.rule.needs-tenant"


def test_rules_scoped_to_other_capabilities_do_not_apply() -> None:
    never = Rule("never", lambda call: False, frozenset({"fs.write"}))
    guard = Guard(Policy({"fs.read": "read"}, [never]))

    @guard.gated("fs.read")
    def read() -> int:
        return 1

    assert read() == 1
    [receipt] = guard.ledger.recent()
    assert receipt.code == "allowed"


def test_tool_errors_propagate_and_the_message_stays_out_of_the_receipt() -> None:
    guard = make_guard(kv_read="read")

    @guard.gated("kv.read")
    def boom() -> None:
        raise RuntimeError(SECRET)

    with pytest.raises(RuntimeError, match=SECRET):
        boom()
    [receipt] = guard.ledger.recent()
    assert (receipt.status, receipt.code) == ("failed", "failed.exception")
    assert SECRET not in repr(asdict(receipt))


def test_the_wrapper_keeps_the_signature_agent_frameworks_read() -> None:
    guard = make_guard(kv_read="read")

    def search(query: str, limit: int = 10) -> list[str]:
        """Search the index."""
        return []

    wrapped = guard.gated("kv.read")(search)
    assert wrapped.__name__ == "search"
    assert wrapped.__doc__ == "Search the index."
    assert inspect.signature(wrapped) == inspect.signature(search)


def test_methods_can_be_gated_and_self_is_fingerprinted_by_type() -> None:
    guard = make_guard(kv_read="read")

    class Client:
        token = SECRET

        @guard.gated("kv.read")
        def get(self, key: str) -> str:
            return key.upper()

    assert Client().get("a") == "A"
    [receipt] = guard.ledger.recent()
    assert receipt.tool == "Client.get"
    assert receipt.args_fingerprint == fingerprint({"self": {"opaque": f"{__name__}.{Client.__qualname__}"}, "key": "a"})


def test_denied_is_an_exception_but_stopped_is_not() -> None:
    # An agent loop that turns tool exceptions into model feedback must not swallow a stop.
    assert issubclass(Denied, Exception)
    assert not issubclass(Stopped, Exception)
    assert issubclass(Stopped, BaseException)


def test_sqlite_ledger_has_no_column_a_body_could_go_in(tmp_path: Path) -> None:
    path = tmp_path / "receipts.db"
    guard = Guard(Policy({"kv.read": "read"}), SQLiteLedger(path))

    @guard.gated("kv.read")
    def echo(text: str) -> str:
        return text

    echo(SECRET)
    guard.stop()
    guard.ledger.close()

    columns = [row[1] for row in sqlite3.connect(path).execute("PRAGMA table_info(receipts)")]
    assert columns == [
        "receipt_id", "created_at", "tool", "capability", "risk", "status", "code",
        "stop_generation", "args_fingerprint", "result_fingerprint", "duration_ms",
    ]
    assert SECRET.encode() not in path.read_bytes()
    reopened = SQLiteLedger(path)
    assert [receipt.tool for receipt in reopened.recent()] == ["guard.stop", "echo"]
    reopened.close()


def test_a_failed_receipt_write_latches_the_stop() -> None:
    class BrokenLedger(MemoryLedger):
        def append(self, receipt):  # type: ignore[no-untyped-def]
            raise OSError("disk full")

    guard = Guard(Policy({"kv.read": "read"}), BrokenLedger())

    @guard.gated("kv.read")
    def get() -> int:
        return 1

    with pytest.raises(OSError):
        get()
    assert guard.state.latched
    assert guard.state.reason == "ledger-write-failed"


def test_keyed_fingerprints_are_hmac_and_differ_from_plain_ones() -> None:
    import hashlib
    import hmac

    from switchyard_guard import canonical_json

    key = b"receipt-key"
    value = {"path": "notes.txt"}
    expected = hmac.new(key, canonical_json(value).encode(), hashlib.sha256).hexdigest()
    assert fingerprint(value, key) == expected
    assert fingerprint(value, key) != fingerprint(value)

    guard = Guard(Policy({"fs.read": "read"}), fingerprint_key=key)

    @guard.gated("fs.read")
    def read(path: str) -> str:
        return path

    read("notes.txt")
    assert guard.ledger.recent()[0].args_fingerprint == expected


def test_call_args_are_read_only_inside_rules() -> None:
    def tamper(call: Call) -> bool:
        call.args["path"] = "elsewhere"  # type: ignore[index]
        return True

    guard = Guard(Policy({"fs.read": "read"}, [Rule("tamper", tamper)]))
    seen = []

    @guard.gated("fs.read")
    def read(path: str) -> None:
        seen.append(path)

    with pytest.raises(Denied):
        read("here")
    assert seen == []
