# switchyard-guard

A decorator for the Python functions you hand to an agent as tools. Each call is checked against your policy before it runs, any call can be stopped from another thread or task, and each call leaves a receipt that holds fingerprints of the arguments and result instead of the values. No dependencies beyond the standard library, Python 3.11 or newer. [`frontend/src/lib/guard.ts`](../frontend/src/lib/guard.ts) is a TypeScript port with the same behaviour, pinned to this package by shared golden values.

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

1. The arguments are bound to the function's signature, defaults included, and the gate evaluates them. A call passes when the stop is open, the capability is granted, its declared risk is at or below the grant (`read < write < destructive`), its budget has calls left, and every rule that applies returns `True`. A rule that raises counts as a failure.
2. The call takes a stop token, the stop generation at admission. The first `stop()` and every `reset()` move the generation on, so a call admitted before a stop can't finish successfully even if someone resets while it is still running.
3. Sync tools are interrupted at `checkpoint()` and at `commit()`. Async tools are also cancelled at whatever they are awaiting, so a hung socket read ends when the stop lands. Only the cancel that `stop()` sends is turned into `Stopped`. A timeout or task-group cancel stays a `CancelledError`.
4. A tool that finishes after the stop was pressed has its result withheld (`stopped.after-return`). Anything it already changed stays changed, and the receipt code shows which case happened.
5. Each outcome (`completed`, `blocked`, `stopped`, `failed`) writes a receipt.

`Denied` is an `Exception`, so an agent loop can return it to the model as a tool error. `Stopped` is a `BaseException`, like `KeyboardInterrupt`, so a broad `except Exception` in a tool or agent loop doesn't swallow a stop.

## Side effects

Wrap each write in `commit()`:

```python
from switchyard_guard import commit

@guard.gated("fs.write", "write")
def append_lines(path: str, lines: list[str]) -> int:
    with (root / path).open("a") as file:
        for line in lines:
            with commit():
                file.write(line + "\n")
                file.flush()
    return len(lines)
```

The block runs only if the call hasn't been stopped, and a stop pressed while it runs waits for it to finish. So each write either happens before the stop latches or not at all. Keep the block short and don't `await` inside it. In TypeScript the tool gets `ctx.commit(() => ...)`, which refuses a callback that returns a promise.

## Budgets

`Policy(grants, budgets={"bank.transfer": 3})` admits at most three `bank.transfer` calls over the guard's life. The fourth raises `BudgetExhausted`, a `Denied` with code `denied.budget`, before the tool body runs. The check and the count happen under one lock, so concurrent calls can't overspend. Calls refused for another reason don't count, `reset()` doesn't refill a budget, and `guard.spent` shows the counts.

There is deliberately no mode that warns the agent and lets the call through. In a BoundaryBench run where an MCP server answered that the call budget was spent, Claude Code with claude-haiku-5-5 made one or two more write calls in 5 of 5 runs (95% Wilson interval 57 to 100%). The server refused every one of them, which is the point: an agent's next call can't be relied on to respect a refusal it was told about, so the gate has to refuse it. The traces are in the [findings log](https://github.com/fortunexbt/boundary-bench/tree/311a1b2c49eaa71467232caaec7886d0e0546074/runs/2026-10-23-claude-code-haiku/budget-cap). That's n=5 with one model and one client. It shows the failure happens and says little about how often.

## Guarantees

Terms used below. A call is admitted when the gate allows it. Its token is the generation at that moment. A commit is a `commit()` block (`ctx.commit` in TypeScript). The stop latches when a `stop()` call finds it open.

| | Guarantee | Python test | TypeScript test |
| --- | --- | --- | --- |
| 1 | No side effect commits after the stop latches. A latch waits for a commit in progress, and no commit of a call admitted before the latch starts after it. | `test_no_side_effect_commits_after_the_stop_latches` | `property: no side effect commits after the stop latches` |
| 2 | A stale generation can't resurrect a run. After any stop or reset, a call admitted earlier never commits again and never returns a result, whatever stops and resets follow. | `test_a_stale_generation_never_commits_or_returns` | `property: a stale generation never commits or returns` |
| 3 | Pressing stop many times, from any number of threads at once, equals pressing it once. The generation moves on by exactly one, the first reason is kept, latch listeners run once, each async call is cancelled once, and each call in flight gets one `stopped` receipt. Each press still writes its own receipt (`allowed`, then `allowed.already-latched`). | `test_double_stop_is_idempotent`, `test_double_stop_cancels_each_async_call_once` | `property: double stop is idempotent` |
| 4 | A stopped call halts at the first checkpoint it reaches after the latch, so within one checkpoint gap, meaning the longest stretch of its code between `checkpoint()` calls, commit blocks included. An async Python tool is cancelled at its current await instead. A TypeScript tool that passes `ctx.signal` to its waits is aborted before the event loop runs another timer. | `test_time_to_halt_is_bounded_by_the_checkpoint_gap`, `test_an_async_call_halts_at_its_current_await` | `property: time to halt is bounded by the checkpoint gap`, `property: a call waiting on its signal halts before any timer runs` |
| 5 | Once a capability's budget is spent, no call to it executes, under any concurrency. | `test_no_call_executes_once_the_budget_is_spent` | `property: no call executes once the budget is spent` |

The Python tests are in `tests/test_properties.py` and use Hypothesis to pick thread counts, unit counts, timings and stop and reset sequences. The TypeScript tests are in `frontend/tests/guard.test.ts` and use fast-check to pick interleavings of concurrent async calls. The halt tests timestamp every checkpoint and compare against the gaps the tool actually had, so a loaded machine doesn't fail them. Each guarantee was checked by breaking the code on purpose: a commit that doesn't hold the lock, a latch that moves the generation on every press, tokens that ignore the generation, no cancel or abort on latch, checkpoints that stop checking, and budget counted after the call instead of at admission. Each break made the matching test fail. The property tests also found one real bug, now fixed with its own regression test: a stop landing between an async call's admission and its registration for cancellation left that call waiting forever.

For a sync tool that never calls `checkpoint()`, guarantee 4 gives no bound and the stop only withholds the result once the tool returns. Side effects made outside `commit()` fall under guarantees 2 and 4 alone.

## API

Python, `import switchyard_guard`:

| Name | Purpose |
| --- | --- |
| `Guard(policy, ledger=None, *, stop=None, fingerprint_key=None)` | `.gated(capability, risk)`, `.stop(reason)`, `.reset()`, `.state`, `.spent`, `.ledger`, `.controller` |
| `Policy(grants, rules=(), *, budgets=None)`, `Rule(name, check, capabilities=None)`, `Risk` | the gate. `Policy.evaluate(call, stopped=..., spent=...)` is pure |
| `StopController(*, latched=False)` | `.token()`, `.valid(token)`, `.check(token)`, `.commit(token)`, `.latch(reason)`, `.reset()`, `.on_latch(listener)`, `.state` |
| `checkpoint()`, `commit()` | for use inside a gated tool |
| `Denied`, `BudgetExhausted`, `Stopped` | `Stopped` is a `BaseException` |
| `MemoryLedger`, `SQLiteLedger`, `Receipt` | receipts |
| `canonical_json(value)`, `fingerprint(value, key=None)` | the hashed bytes and the hash |

TypeScript, `frontend/src/lib/guard.ts`: the same names in camelCase. A tool is `guard.gated(capability, risk, (args, ctx) => ...)` and receives `ctx.signal`, `ctx.checkpoint()` and `ctx.commit(effect)`. `stop()` latches synchronously and returns a promise for its receipt.

[`goldens.json`](goldens.json) holds canonical JSON, SHA-256 and HMAC values (floats and keys outside the Basic Multilingual Plane included), policy decisions including budgets, and a stop and reset sequence. Both test suites check it, and a Hypothesis test sends random JSON values through both implementations and compares the bytes.

## Receipts

| Field | Contents |
| --- | --- |
| `receipt_id`, `created_at` | `rcpt_` plus 32 hex characters, ISO 8601 UTC |
| `tool`, `capability`, `risk` | function name, granted capability, declared risk |
| `status`, `code` | outcome and the gate or stop code, such as `denied.budget` or `stopped.in-flight` |
| `stop_generation` | the generation a completed call ran under, or the one that refused or ended it |
| `args_fingerprint`, `result_fingerprint` | SHA-256 of the canonical JSON, result `null` unless completed |
| `duration_ms` | time from admission to the receipt |

`MemoryLedger` is the default. `SQLiteLedger` writes one table with exactly these columns. If a receipt can't be written, the guard latches the stop and re-raises, so calls don't keep running without an audit trail.

Fingerprints are taken over canonical JSON with sorted keys, no whitespace and ASCII escapes, with numbers written the way JavaScript writes them. Integers beyond 2^53 have no exact JavaScript equivalent. Objects that aren't data (clients, sessions, `self`) are fingerprinted by type name only, never by `repr`. An unkeyed hash of a short or guessable value can be reversed by trying candidates, so pass `Guard(..., fingerprint_key=secret)` to get HMAC-SHA256 when receipts leave the machine.

## Examples

All three call real code. `python examples/workspace_tools.py` runs file tools in a temporary directory and shows a path-traversal read and an ungranted delete being denied. `python examples/stop_long_job.py` hashes your Python standard library and stops it from a timer thread. `python examples/http_fetch.py` needs network access. It fetches python.org, is denied example.com by a host rule, and stops a five-second httpbin request after half a second.

## Limits

- The gate sees the arguments the function is called with. It doesn't see what the function does with them, so a rule over `path` doesn't stop a tool that opens a different path internally.
- A sync tool without `checkpoint()` calls runs to the end, after which the stop withholds its result and blocks later calls.
- Budgets and stop state live in the process. Two processes sharing a tool need a shared controller, which this package doesn't provide.
- Receipts on local disk are not signed, so whoever can write the file can rewrite them.

## Tests

```bash
pip install -e "./guard[test]"
python -m pytest guard/tests -q        # needs node 24 on PATH for the cross-language test
cd frontend && npm test
```
