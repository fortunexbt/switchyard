from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app import execution
from app.execution import ActionGateway, SyntheticExecutor, fingerprint
from app.fixtures import FixtureLibrary
from app.policy import PolicyEngine
from app.schemas import OperatorRequest, PlannedAction, ResetStopRequest, RiskTier, StopRequest
from app.stop import StopController, StopRequested
from app.storage import ReceiptStore


@pytest.mark.asyncio
@pytest.mark.parametrize("reset_before_resume", [False, True])
async def test_default_inspection_window_stops_before_fixture_load(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    reset_before_resume: bool,
) -> None:
    entered_window = asyncio.Event()
    release = asyncio.Event()
    real_sleep = asyncio.sleep
    loaded: list[str] = []
    real_load = FixtureLibrary.load

    async def hold_inspection_sleep(delay: float) -> None:
        if delay > 0:
            entered_window.set()
            await release.wait()
        else:
            await real_sleep(0)

    def track_load(library: FixtureLibrary, fixture_id: str):
        loaded.append(fixture_id)
        return real_load(library, fixture_id)

    monkeypatch.setattr(execution.asyncio, "sleep", hold_inspection_sleep)
    monkeypatch.setattr(FixtureLibrary, "load", track_load)
    stop = StopController()
    store = ReceiptStore(f"sqlite:///{tmp_path / 'inspection.db'}")
    store.initialize()
    # Exercise the production constructor path: no pacing override or checkpoint hook.
    gateway = ActionGateway(stop, PolicyEngine(), store)
    task = asyncio.create_task(gateway.execute(OperatorRequest(command="Replay the relay fixture.")))
    try:
        await asyncio.wait_for(entered_window.wait(), timeout=1)
        assert not task.done()
        assert loaded == []
        await gateway.enable_stop(StopRequest(reason="test-stop"))
        if reset_before_resume:
            await gateway.reset_stop(ResetStopRequest(acknowledge="resume synthetic execution"))
            assert stop.state.enabled is False
        release.set()
        outcome = await asyncio.wait_for(task, timeout=1)

        assert outcome.receipt.status.value == "stopped"
        assert outcome.policy.code == "denied.stop-during-execution"
        assert outcome.result is None
        assert outcome.sources == []
        assert outcome.receipt.result_fingerprint is None
        assert loaded == []
        assert store.recent(1)[0].receipt_id == outcome.receipt.receipt_id
    finally:
        release.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        store.dispose()


@pytest.mark.asyncio
async def test_default_inspection_window_is_bounded_and_preserves_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    elapsed = 0.0
    waits: list[float] = []

    async def advance_clock(delay: float) -> None:
        nonlocal elapsed
        waits.append(delay)
        elapsed += delay

    monkeypatch.setattr(execution, "monotonic", lambda: elapsed)
    monkeypatch.setattr(execution.asyncio, "sleep", advance_clock)
    stop = StopController()
    store = ReceiptStore(f"sqlite:///{tmp_path / 'completed.db'}")
    store.initialize()
    gateway = ActionGateway(stop, PolicyEngine(), store)
    request = OperatorRequest(command="Replay the relay fixture.")
    expected_result, expected_sources = FixtureLibrary().load(request.fixture_id)
    try:
        outcome = await gateway.execute(request)

        assert elapsed == pytest.approx(4.0)
        assert all(0 <= delay <= 0.1 for delay in waits)
        assert outcome.receipt.status.value == "completed"
        assert outcome.result == expected_result
        assert outcome.sources == expected_sources
        assert outcome.receipt.result_fingerprint == fingerprint(
            {"result": expected_result, "sources": expected_sources}
        )
    finally:
        store.dispose()


@pytest.mark.parametrize("inspection_seconds", [-0.1, float("inf"), float("nan")])
def test_inspection_window_rejects_invalid_duration(inspection_seconds: float) -> None:
    with pytest.raises(ValueError, match="finite and non-negative"):
        SyntheticExecutor(StopController(), inspection_seconds=inspection_seconds)


@pytest.mark.asyncio
async def test_stop_invalidates_in_flight_action(tmp_path: Path) -> None:
    started = asyncio.Event()
    release = asyncio.Event()

    async def pause_at_checkpoint() -> None:
        started.set()
        await release.wait()

    stop = StopController()
    store = ReceiptStore(f"sqlite:///{tmp_path / 'stop.db'}")
    store.initialize()
    executor = SyntheticExecutor(stop, checkpoint_hook=pause_at_checkpoint, inspection_seconds=0)
    gateway = ActionGateway(stop, PolicyEngine(), store, executor)

    task = asyncio.create_task(gateway.execute(OperatorRequest(command="Replay the relay fixture.")))
    await asyncio.wait_for(started.wait(), timeout=1)
    stop.enable("test-stop")
    release.set()
    outcome = await asyncio.wait_for(task, timeout=1)

    assert outcome.receipt.status.value == "stopped"
    assert outcome.policy.code == "denied.stop-during-execution"
    assert store.recent(1)[0].receipt_id == outcome.receipt.receipt_id
    store.dispose()


def test_old_token_stays_invalid_after_stop_reset() -> None:
    stop = StopController()
    old_token = stop.snapshot()
    stop.enable("test-stop")
    stop.reset()
    with pytest.raises(StopRequested):
        stop.checkpoint(old_token)


def test_policy_denies_live_and_write_paths() -> None:
    policy = PolicyEngine()
    stop = StopController().state
    live = PlannedAction(
        action_id="live",
        kind="fixture.replay",
        capability="fixtures.read",
        risk=RiskTier.READ_ONLY,
        synthetic=False,
        summary="A deliberately invalid live path.",
    )
    write = PlannedAction(
        action_id="write",
        kind="fixture.replay",
        capability="fixtures.read",
        risk=RiskTier.WRITE,
        synthetic=True,
        summary="A deliberately invalid write path.",
    )
    assert policy.evaluate(live, stop).code == "denied.live-executor"
    assert policy.evaluate(write, stop).allowed is False
