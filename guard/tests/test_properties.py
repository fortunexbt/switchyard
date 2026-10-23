"""Property-based attempts to break the guarantees listed in guard/README.md.

Each test drives real threads (or a real event loop) with hypothesis-chosen worker counts,
unit counts, timings and stop/reset sequences, then checks the guarantee against an
ordered event log.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import threading
import time
from pathlib import Path

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from switchyard_guard import (
    BudgetExhausted,
    Denied,
    Guard,
    Policy,
    Rule,
    Stopped,
    canonical_json,
    checkpoint,
    commit,
)
from switchyard_guard.stop import _active

PROPERTY = settings(max_examples=40, deadline=None, suppress_health_check=[HealthCheck.too_slow])


class Log:
    def __init__(self) -> None:
        self.events: list[tuple] = []
        self._lock = threading.Lock()

    def add(self, *event: object) -> None:
        with self._lock:
            self.events.append(event)


def _make() -> Guard:
    return Guard(Policy({"job.run": "write"}))


class Workers:
    """Threads whose gated calls are all admitted once `admitted.wait()` returns in the test.
    Anything a worker raises other than Stopped is kept, and `join` re-raises it."""

    def __init__(self, guard: Guard, count: int, body) -> None:  # type: ignore[no-untyped-def]
        self.admitted = threading.Barrier(count + 1)
        self.errors: list[BaseException] = []

        @guard.gated("job.run", "write")
        def job(worker: int) -> int:
            self.admitted.wait()
            return body(worker)

        def target(worker: int) -> None:
            try:
                job(worker)
            except Stopped:
                pass
            except BaseException as error:
                self.errors.append(error)

        self.threads = [threading.Thread(target=target, args=(worker,), daemon=True) for worker in range(count)]
        for thread in self.threads:
            thread.start()

    def join(self) -> None:
        for thread in self.threads:
            thread.join(10)
            assert not thread.is_alive(), "a worker never halted"
        if self.errors:
            raise self.errors[0]


# Guarantee 1: no side effect commits after the stop latches.
@PROPERTY
@given(
    workers=st.integers(1, 6),
    units=st.integers(1, 30),
    unit_s=st.floats(0, 0.002),
    commit_s=st.floats(0, 0.002),
    stop_after_s=st.floats(0, 0.02),
    reset_after=st.booleans(),
)
def test_no_side_effect_commits_after_the_stop_latches(
    workers: int, units: int, unit_s: float, commit_s: float, stop_after_s: float, reset_after: bool
) -> None:
    guard = _make()
    log = Log()

    def body(worker: int) -> int:
        token = _active.get()[1]  # type: ignore[index]
        for unit in range(units):
            checkpoint()
            time.sleep(unit_s)
            with commit():
                time.sleep(commit_s)
                # Still holding the commit, so the state cannot have moved under it.
                assert guard.controller.valid(token)
                log.add("commit", worker, unit)
        return worker

    pool = Workers(guard, workers, body)
    pool.admitted.wait()
    time.sleep(stop_after_s)
    guard.stop()
    log.add("stopped")
    if reset_after:
        guard.reset()  # Must not let the calls admitted before the stop commit again.
    pool.join()

    marker = log.events.index(("stopped",))
    assert [event for event in log.events[marker + 1 :] if event[0] == "commit"] == []


# Guarantee 2: a stale generation cannot resurrect a run.
@PROPERTY
@given(
    ops=st.lists(st.sampled_from(["stop", "reset", "admit"]), min_size=1, max_size=8),
    gap_s=st.floats(0, 0.004),
    unit_s=st.floats(0, 0.001),
)
def test_a_stale_generation_never_commits_or_returns(ops: list[str], gap_s: float, unit_s: float) -> None:
    guard = _make()
    log = Log()
    outcomes: dict[int, str] = {}
    threads: list[threading.Thread] = []
    stop_all = threading.Event()

    @guard.gated("job.run", "write")
    def job(call_id: int, admitted: threading.Event) -> int:
        token = _active.get()[1]  # type: ignore[index]
        log.add("admitted", call_id, token)
        admitted.set()
        while not stop_all.is_set():
            checkpoint()
            with commit():
                log.add("commit", call_id, token, guard.controller.state.generation)
            time.sleep(unit_s)
        return call_id

    def admit(call_id: int) -> None:
        admitted = threading.Event()

        def target() -> None:
            try:
                job(call_id, admitted)
                outcomes[call_id] = "returned"
            except Stopped as stopped:
                outcomes[call_id] = stopped.receipt.code  # type: ignore[union-attr]
            except BaseException as error:
                outcomes[call_id] = f"error: {error!r}"

        thread = threading.Thread(target=target)
        thread.start()
        threads.append(thread)
        admitted.wait(0.2)  # A call made while latched is refused and never sets this.

    for index, op in enumerate([*ops, "admit"]):
        if op == "admit":
            admit(index)
        elif op == "stop":
            guard.stop()
        else:
            guard.reset()
        log.add("transition", guard.controller.state.generation)
        time.sleep(gap_s)
    stop_all.set()
    for thread in threads:
        thread.join(10)

    assert all(thread.is_alive() is False for thread in threads)
    assert not [outcome for outcome in outcomes.values() if outcome.startswith("error")]
    newest = 0
    for event in log.events:
        if event[0] == "transition":
            newest = max(newest, event[1])
        elif event[0] == "commit":
            _, call_id, token, generation_seen = event
            # Committed under its own generation, and never after a later one was announced.
            assert generation_seen == token and token >= newest, (call_id, token, generation_seen, newest)
    final = guard.state
    tokens = {event[1]: event[2] for event in log.events if event[0] == "admitted"}
    for call_id, outcome in outcomes.items():
        if outcome == "returned":
            assert tokens[call_id] == final.generation and not final.latched, (call_id, tokens[call_id], final)


# Guarantee 3: pressing stop many times, from many threads at once, equals pressing it once.
@PROPERTY
@given(presses=st.integers(1, 8), workers=st.integers(0, 4))
def test_double_stop_is_idempotent(presses: int, workers: int) -> None:
    guard = _make()
    latches: list[int] = []
    guard.controller.on_latch(lambda state: latches.append(state.generation))

    def body(worker: int) -> int:
        # Bounded, so a stop that never lands fails the test instead of hanging it.
        for _ in range(4000):
            checkpoint()
            time.sleep(0.0005)
        return worker

    pool = Workers(guard, workers, body)
    pool.admitted.wait()
    go = threading.Barrier(presses)
    receipts = []

    def press(index: int) -> None:
        go.wait()
        receipts.append(guard.stop(f"press-{index}"))

    pressers = [threading.Thread(target=press, args=(index,)) for index in range(presses)]
    for thread in pressers:
        thread.start()
    for thread in pressers:
        thread.join(10)
    pool.join()

    state = guard.state
    assert state.latched and state.generation == 1
    assert state.reason in {f"press-{index}" for index in range(presses)}
    assert latches == [1]
    assert sorted(receipt.code for receipt in receipts) == ["allowed"] + ["allowed.already-latched"] * (presses - 1)
    stopped = [r for r in guard.ledger.recent(1000) if r.tool == "job"]
    assert len(stopped) == workers and all(r.code == "stopped.in-flight" for r in stopped)


@settings(max_examples=25, deadline=None)
@given(presses=st.integers(1, 6), calls=st.integers(1, 4))
def test_double_stop_cancels_each_async_call_once(presses: int, calls: int) -> None:
    async def scenario() -> None:
        guard = _make()

        @guard.gated("job.run", "write")
        async def wait_forever(call_id: int) -> int:
            await asyncio.sleep(3600)
            return call_id

        async def caller(call_id: int) -> int:
            try:
                await wait_forever(call_id)
            except Stopped:
                pass
            # The caller's own task must come out with no cancel left pending.
            return asyncio.current_task().cancelling()  # type: ignore[union-attr]

        tasks = [asyncio.create_task(caller(index)) for index in range(calls)]
        await asyncio.sleep(0.01)
        pressers = [threading.Thread(target=guard.stop) for _ in range(presses)]
        for thread in pressers:
            thread.start()
        async with asyncio.timeout(2):
            pending = await asyncio.gather(*tasks)
        for thread in pressers:
            thread.join(2)
        assert pending == [0] * calls
        stopped = [r for r in guard.ledger.recent(1000) if r.tool == "wait_forever"]
        assert len(stopped) == calls and {r.code for r in stopped} == {"stopped.in-flight"}
        assert guard.state.generation == 1

    asyncio.run(scenario())


# Guarantee 4: a stopped call halts at the first checkpoint it reaches after the latch, so
# within one checkpoint gap. Measured against the gaps the worker actually had, not a fixed
# slack, so a loaded machine slows both sides alike.
@settings(max_examples=30, deadline=None)
@given(gap_s=st.floats(0.001, 0.03), commit_share=st.floats(0, 1), stop_after_s=st.floats(0, 0.05))
def test_time_to_halt_is_bounded_by_the_checkpoint_gap(gap_s: float, commit_share: float, stop_after_s: float) -> None:
    guard = _make()
    began: list[float] = []
    stamps: list[float] = []  # when each checkpoint or commit was reached; both can halt the call
    halted: list[float] = []
    commit_s = gap_s * commit_share

    def reach() -> None:
        stamps.append(time.monotonic())

    def body(worker: int) -> int:
        began.append(time.monotonic())
        give_up = began[0] + 1  # so a stop that never lands fails instead of hanging
        try:
            while time.monotonic() < give_up:
                reach()
                checkpoint()
                time.sleep(gap_s - commit_s)
                reach()
                with commit():
                    time.sleep(commit_s)
        except Stopped:
            halted.append(stamps[-1])
            raise
        return worker

    pool = Workers(guard, 1, body)
    pool.admitted.wait()
    time.sleep(stop_after_s)
    guard.stop()
    returned = time.monotonic()
    pool.join()
    assert halted, "the call never halted at a checkpoint or commit"
    # At most one halt point is reached once stop() has returned: the one that raises.
    assert sum(1 for stamp in stamps if stamp >= returned) <= 1
    # And it comes no later than one gap after the latch, or after the call started running.
    points = began + stamps
    longest_gap = max(later - earlier for earlier, later in zip(points, points[1:]))
    assert halted[0] - max(returned, began[0]) <= longest_gap


@settings(max_examples=20, deadline=None)
@given(stop_after_s=st.floats(0, 0.05))
def test_an_async_call_halts_at_its_current_await(stop_after_s: float) -> None:
    async def scenario() -> Stopped:
        guard = _make()

        @guard.gated("job.run", "write")
        async def hang() -> None:
            await asyncio.Event().wait()  # never checkpoints, never finishes on its own

        threading.Timer(stop_after_s, guard.stop).start()
        with pytest.raises(Stopped) as stopped:
            async with asyncio.timeout(2):  # a cancel that never comes fails here
                await hang()
        return stopped.value

    receipt = asyncio.run(scenario()).receipt
    # Stopped where it was waiting, or refused at the gate if the stop came first.
    assert receipt is not None and receipt.code in {"stopped.in-flight", "stopped.before-start", "denied.stop-active"}


# Fingerprints agree with the TypeScript port on arbitrary JSON.
json_values = st.recursive(
    st.none()
    | st.booleans()
    | st.integers(-(2**53) + 1, 2**53 - 1)
    | st.floats(allow_nan=False, allow_infinity=False)
    | st.text(st.characters(exclude_categories=())),
    lambda children: st.lists(children, max_size=4)
    | st.dictionaries(st.text(st.characters(exclude_categories=()), max_size=6), children, max_size=4),
    max_leaves=12,
)
GUARD_TS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "guard.ts"
NODE_SCRIPT = f"""
import {{ canonicalJson }} from {json.dumps(GUARD_TS.as_uri())};
let input = "";
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify(JSON.parse(input).map(canonicalJson)));
"""


@settings(max_examples=8, deadline=None)
@given(values=st.lists(json_values, min_size=50, max_size=50))
def test_canonical_json_matches_the_typescript_port(values: list) -> None:
    node = shutil.which("node")
    assert node is not None, "node 24 is needed to run the TypeScript side"
    payload = json.dumps(values, ensure_ascii=True)
    completed = subprocess.run(
        [node, "--input-type=module", "-e", NODE_SCRIPT],
        input=payload, capture_output=True, text=True, timeout=30, check=True,
    )
    assert json.loads(completed.stdout) == [canonical_json(value) for value in values]


# Guarantee 5: once a capability's budget is spent, no call to it executes.
@PROPERTY
@given(
    budget=st.integers(0, 8),
    threads=st.integers(1, 8),
    amounts=st.lists(st.integers(-3, 50), min_size=1, max_size=6),
    stop_and_reset=st.booleans(),
)
def test_no_call_executes_once_the_budget_is_spent(
    budget: int, threads: int, amounts: list[int], stop_and_reset: bool
) -> None:
    positive = Rule("amount.positive", lambda call: call.args["amount"] > 0)
    guard = Guard(Policy({"bank.transfer": "write"}, [positive], budgets={"bank.transfer": budget}))
    executed = Log()
    outcomes = Log()

    @guard.gated("bank.transfer", "write")
    def transfer(amount: int) -> int:
        executed.add(amount)
        time.sleep(0.0002)
        return amount

    start = threading.Barrier(threads)

    def caller() -> None:
        start.wait()
        for amount in amounts:
            try:
                transfer(amount)
                outcomes.add(amount > 0, "ran")
            except BudgetExhausted:
                outcomes.add(amount > 0, "budget")
            except Denied as denied:
                outcomes.add(amount > 0, denied.decision.code)

    pool = [threading.Thread(target=caller) for _ in range(threads)]
    for thread in pool:
        thread.start()
    for thread in pool:
        thread.join(10)

    valid = [code for is_valid, code in outcomes.events if is_valid]
    invalid = [code for is_valid, code in outcomes.events if not is_valid]
    ran = len(executed.events)
    # Exactly the budget runs (or every valid call, if there are fewer), whatever the interleaving.
    assert ran == min(budget, len(valid)) == valid.count("ran")
    assert valid.count("budget") == len(valid) - ran
    # A call refused for another reason never runs and does not spend budget. When it fails
    # both checks it reports the budget, which comes first in the check order.
    assert set(invalid) <= {"denied.rule.amount.positive", "budget"}
    assert guard.spent.get("bank.transfer", 0) == ran

    if stop_and_reset:
        guard.stop()
        guard.reset()  # Reopening the stop does not refill the budget.
    if ran == budget:
        with pytest.raises(BudgetExhausted):
            transfer(1)
        assert len(executed.events) == ran
