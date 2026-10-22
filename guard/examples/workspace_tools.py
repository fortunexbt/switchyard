"""File tools an agent might be given, gated to one workspace directory.

Run: python examples/workspace_tools.py [workspace-dir]
Without an argument it works in a fresh temporary directory.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from switchyard_guard import Call, Denied, Guard, Policy, Rule, SQLiteLedger


def inside(root: Path) -> Rule:
    def check(call: Call) -> bool:
        target = (root / call.args["path"]).resolve()
        return target.is_relative_to(root)

    return Rule("path.inside-workspace", check, frozenset({"fs.read", "fs.write", "fs.delete"}))


def build(root: Path, ledger: SQLiteLedger) -> tuple[Guard, dict]:
    # fs.delete is not granted, so delete_file is denied however it is called.
    guard = Guard(Policy({"fs.read": "read", "fs.write": "write"}, [inside(root)]), ledger)

    @guard.gated("fs.read", "read")
    def read_file(path: str) -> str:
        return (root / path).read_text(encoding="utf-8")

    @guard.gated("fs.read", "read")
    def list_dir(path: str = ".") -> list[str]:
        return sorted(entry.name for entry in (root / path).iterdir())

    @guard.gated("fs.write", "write")
    def write_file(path: str, text: str) -> int:
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        return target.write_text(text, encoding="utf-8")

    @guard.gated("fs.delete", "destructive")
    def delete_file(path: str) -> None:
        (root / path).unlink()

    tools = {"read_file": read_file, "list_dir": list_dir, "write_file": write_file, "delete_file": delete_file}
    return guard, tools


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="workspace-")).resolve()
    ledger = SQLiteLedger(root.parent / f"{root.name}-receipts.db")
    guard, tools = build(root, ledger)

    # The calls a model might ask for, in order. Two of them should never run.
    requests = [
        ("write_file", {"path": "notes/plan.md", "text": "rotate the staging key on Friday\n"}),
        ("list_dir", {"path": "notes"}),
        ("read_file", {"path": "notes/plan.md"}),
        ("read_file", {"path": "../../../etc/passwd"}),
        ("delete_file", {"path": "notes/plan.md"}),
    ]
    for tool, args in requests:
        try:
            print(f"{tool}({args}) -> {tools[tool](**args)!r}")
        except Denied as denied:
            print(f"{tool}({args}) -> denied: {denied.decision.code}")

    print("\nreceipts, newest first:")
    for receipt in ledger.recent():
        print(f"  {receipt.status:<9} {receipt.tool:<12} {receipt.code:<36} args {receipt.args_fingerprint[:12]}")
    print(f"\nworkspace: {root}\nledger: {root.parent / f'{root.name}-receipts.db'}")


if __name__ == "__main__":
    main()
