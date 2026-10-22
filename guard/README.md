# switchyard-guard

A decorator for the Python functions you hand to an agent as tools. Each call is checked against your policy before it runs, any call can be stopped from another thread or task, and each call leaves a receipt that holds fingerprints of the arguments and result instead of the values. No dependencies beyond the standard library, Python 3.11 or newer.

## Quickstart

```bash
pip install ./guard          # from a clone of this repository
```

```python
from pathlib import Path

from switchyard_guard import Denied, Guard, Policy, Rule, SQLiteLedger, Stopped, checkpoint

root = Path("workspace").resolve()
inside = Rule("path.inside-workspace", lambda call: (root / call.args["path"]).resolve().is_relative_to(root))
guard = Guard(Policy({"fs.read": "read", "fs.write": "write"}, [inside]), SQLiteLedger("receipts.db"))


@guard.gated("fs.read", "read")
def read_file(path: str) -> str:
    return (root / path).read_text()


@guard.gated("fs.delete", "destructive")  # not granted above, so every call is denied
def delete_file(path: str) -> None:
    (root / path).unlink()


@guard.gated("fs.read", "read")
def index_tree(path: str) -> int:
    count = 0
    for file in (root / path).rglob("*"):
        checkpoint()  # a stop lands here, between files
        count += 1
    return count
```

`read_file("../.ssh/id_rsa")` raises `Denied` with `decision.code == "denied.rule.path.inside-workspace"`, and the function body never runs. `guard.stop()` from any thread makes the running `index_tree` raise `Stopped` at its next `checkpoint()`, and every later gated call raises `Stopped` until `guard.reset()`.

## What happens on a call

1. The arguments are bound to the function's signature, defaults included, and the gate evaluates them. A call passes when the stop is open, the capability is granted, its declared risk is at or below the grant (`read < write < destructive`), and every rule that applies returns `True`. A rule that raises counts as a failure.
2. The call takes a stop token. `stop()` and `reset()` each bump a generation counter, so a call admitted before a stop can't finish successfully even if someone resets while it is still running.
3. Sync tools are interrupted at `checkpoint()`. Async tools are also cancelled at whatever they are awaiting, so a hung socket read ends when the stop lands. Only the cancel that `stop()` sends is turned into `Stopped`. A timeout or task-group cancel stays a `CancelledError`.
4. A tool that finishes after the stop was pressed has its result withheld (`stopped.after-return`). Anything it already changed stays changed, and the receipt code shows which case happened.
5. Each outcome (`completed`, `blocked`, `stopped`, `failed`) writes a receipt.

`Denied` is an `Exception`, so an agent loop can return it to the model as a tool error. `Stopped` is a `BaseException`, like `KeyboardInterrupt`, so a broad `except Exception` in a tool or agent loop doesn't swallow a stop.

## Receipts

| Field | Contents |
| --- | --- |
| `receipt_id`, `created_at` | `rcpt_` plus 32 hex characters, ISO 8601 UTC |
| `tool`, `capability`, `risk` | function name, granted capability, declared risk |
| `status`, `code` | outcome and the gate or stop code, such as `denied.capability` or `stopped.in-flight` |
| `stop_generation` | the stop counter when the receipt was written |
| `args_fingerprint`, `result_fingerprint` | SHA-256 of the canonical JSON, result `null` unless completed |
| `duration_ms` | time from admission to the receipt |

`MemoryLedger` is the default. `SQLiteLedger` writes one table with exactly these columns. If a receipt can't be written, the guard latches the stop and re-raises, so calls don't keep running without an audit trail.

Fingerprints use sorted keys, compact separators and ASCII escapes, the same bytes as `frontend/src/lib/engine.ts` produces for JSON values. Objects that aren't data (clients, sessions, `self`) are fingerprinted by type name only, never by `repr`. An unkeyed hash of a short or guessable value can be reversed by trying candidates, so pass `Guard(..., fingerprint_key=secret)` to get HMAC-SHA256 when receipts leave the machine.

## Examples

All three call real code. `python examples/workspace_tools.py` runs file tools in a temporary directory and shows a path-traversal read and an ungranted delete being denied. `python examples/stop_long_job.py` hashes your Python standard library and stops it from a timer thread. `python examples/http_fetch.py` needs network access. It fetches python.org, is denied example.com by a host rule, and stops a five-second httpbin request after half a second.

## Limits

- The gate sees the arguments the function is called with. It doesn't see what the function does with them, so a rule over `path` doesn't stop a tool that opens a different path internally.
- A sync tool without `checkpoint()` calls runs to the end, after which the stop withholds its result and blocks later calls.
- Receipts on local disk are not signed, so whoever can write the file can rewrite them.

## Tests

```bash
pip install -e ./guard pytest
python -m pytest guard/tests -q
```
