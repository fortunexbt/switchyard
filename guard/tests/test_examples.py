from __future__ import annotations

import subprocess
import sys
import sysconfig
from pathlib import Path

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"


def run(*args: str) -> str:
    completed = subprocess.run(
        [sys.executable, *args], capture_output=True, text=True, timeout=60, check=True
    )
    return completed.stdout


def test_workspace_example_denies_traversal_and_delete(tmp_path: Path) -> None:
    out = run(str(EXAMPLES / "workspace_tools.py"), str(tmp_path / "ws"))
    assert "read_file({'path': 'notes/plan.md'}) -> 'rotate the staging key on Friday\\n'" in out
    assert "denied: denied.rule.path.inside-workspace" in out
    assert "delete_file({'path': 'notes/plan.md'}) -> denied: denied.capability" in out
    assert (tmp_path / "ws" / "notes" / "plan.md").exists()
    assert b"staging key" not in (tmp_path / "ws-receipts.db").read_bytes()


def test_long_job_example_is_stopped_from_another_thread() -> None:
    out = run(str(EXAMPLES / "stop_long_job.py"), sysconfig.get_paths()["stdlib"], "0.05")
    assert "receipt: stopped" in out
    assert "next call while latched: denied.stop-active, 0 files hashed" in out


def test_the_readme_quickstart_does_what_the_readme_says(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import re

    from switchyard_guard import Denied, Stopped

    readme = (EXAMPLES.parent / "README.md").read_text(encoding="utf-8")
    code = re.findall(r"```python\n(.*?)```", readme, re.S)[0]
    (tmp_path / "workspace").mkdir()
    monkeypatch.chdir(tmp_path)
    ns: dict = {}
    exec(code, ns)

    try:
        ns["read_file"]("../.ssh/id_rsa")
        raise AssertionError("traversal was admitted")
    except Denied as denied:
        assert denied.decision.code == "denied.rule.path.inside-workspace"
        assert f"`{denied.decision.code}`" in readme
    assert ns["append_lines"]("log.txt", ["one", "two"]) == 2
    assert ns["read_file"]("log.txt") == "one\ntwo\n"
    ns["guard"].stop()
    try:
        ns["append_lines"]("log.txt", ["three"])
        raise AssertionError("ran while stopped")
    except Stopped as stopped:
        assert stopped.receipt.code == "denied.stop-active"
    ns["guard"].reset()
    assert ns["append_lines"]("log.txt", ["three"]) == 1
    assert (tmp_path / "workspace" / "log.txt").read_text() == "one\ntwo\nthree\n"
    ns["guard"].ledger.close()
