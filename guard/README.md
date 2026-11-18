# switchyard-guard

A decorator for the Python functions you give an agent as tools. Each call is checked against your policy before it runs, can be stopped from another thread or task, and leaves a receipt with fingerprints of its arguments and result instead of the values. It needs Python 3.11 or newer and nothing outside the standard library. [`frontend/src/lib/guard.ts`](../frontend/src/lib/guard.ts) is a TypeScript port held to the same behaviour by shared [golden values](goldens.json).

## Quickstart

```python
# pip install ./guard  (from a clone of this repository)
from pathlib import Path

from switchyard_guard import Guard, Policy, Rule, SQLiteLedger, checkpoint, commit

root = Path("workspace").resolve()
inside = Rule("path.inside-workspace", lambda call: (root / call.args["path"]).resolve().is_relative_to(root))
guard = Guard(Policy({"fs.read": "read", "fs.write": "write"}, [inside]), SQLiteLedger("receipts.db"))


@guard.gated("fs.read", "read")
def read_file(path: str) -> str:
    return (root / path).read_text()


@guard.gated("fs.write", "write")
def append_lines(path: str, lines: list[str]) -> int:
    with (root / path).open("a") as file:
        for line in lines:
            checkpoint()          # a stop lands here
            with commit():        # runs whole or not at all
                file.write(line + "\n")
    return len(lines)
```

`read_file("../.ssh/id_rsa")` raises `Denied` with code `denied.rule.path.inside-workspace` and the body doesn't run. Calling `guard.stop()` from any thread makes a running `append_lines` raise `Stopped` at its next `checkpoint()`, and later gated calls raise `Stopped` until `guard.reset()`.

## How a call runs

The gate binds the arguments to the signature and admits the call if the stop is open, the capability is granted at or above the declared risk (`read < write < destructive`), its budget has calls left and every matching rule returns `True`. A rule that raises counts as a failure.

An admitted call carries the stop generation as its token. A stop or reset moves the generation on, so a call admitted before a stop can't finish successfully even if someone resets while it's running. Sync tools stop at `checkpoint()` and `commit()`, and async tools are also cancelled at whatever they're awaiting. A tool that returns after the stop has its result withheld, though anything it changed outside `commit()` stays changed. `Denied` is an `Exception` an agent loop can hand back to the model, while `Stopped` is a `BaseException` so a broad `except Exception` won't swallow it.

`Policy(grants, budgets={"bank.transfer": 3})` admits three `bank.transfer` calls over the guard's life and raises `BudgetExhausted` on the fourth, before the body runs. There's no warn-only mode. In a [BoundaryBench run](https://github.com/fortunexbt/boundary-bench/tree/311a1b2c49eaa71467232caaec7886d0e0546074/runs/2026-10-23-claude-code-haiku/budget-cap), an MCP server told Claude Code with claude-haiku-5-5 its call budget was spent, and the agent still made one or two more write calls in 5 of 5 runs. The server refused them. That's one model and one client, enough to show it happens but not how often.

## Guarantees

Each of these is a property test in [`tests/test_properties.py`](tests/test_properties.py) (Hypothesis) with a twin in [`frontend/tests/guard.test.ts`](../frontend/tests/guard.test.ts) (fast-check).

1. No side effect commits after the stop latches. A latch waits for a commit in progress.
2. After any stop or reset, a call admitted earlier never commits again and never returns a result.
3. Pressing stop many times, from many threads at once, equals pressing it once.
4. A stopped call halts within one checkpoint gap, or at its current await if it's async.
5. Once a capability's budget is spent, no further call to it runs, under any concurrency.

Each guarantee was checked by breaking the code on purpose (an unlocked commit, a generation that moves on with each press, tokens that ignore it, no cancel on latch, checkpoints that stop checking, budget counted after the call) and watching its test fail. The tests also found one real bug, a stop landing between an async call's admission and its cancel registration, which is fixed and has its own regression test.

## Receipts

Each call writes one receipt with its outcome, its gate or stop code and SHA-256 fingerprints of the canonical JSON arguments and result. `MemoryLedger` is the default and `SQLiteLedger` writes one table with those columns. If a receipt can't be written, the guard latches the stop and re-raises. A plain hash of a short or guessable value can be reversed by trying candidates, so pass `Guard(..., fingerprint_key=secret)` for HMAC-SHA256 when receipts leave the machine.

## Limits

The gate sees the arguments, not what the function does with them, so a rule over `path` won't stop a tool that opens another path internally. A sync tool with no `checkpoint()` runs to the end and the stop only withholds its result. Stop state and budgets live in one process, and receipts on disk aren't signed.

## Examples and tests

[`examples/`](examples/) has three runnable scripts. `workspace_tools.py` denies a path-traversal read and an ungranted delete, `stop_long_job.py` stops a hash of your standard library from a timer thread, and `http_fetch.py` (needs network) denies a host and stops a slow request.

```bash
pip install -e "./guard[test]"
python -m pytest guard/tests -q        # the cross-language test needs node 24 on PATH
cd frontend && npm test
```
