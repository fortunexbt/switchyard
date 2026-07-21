from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.execution import ActionGateway, SyntheticExecutor
from app.policy import PolicyEngine
from app.schemas import OperatorRequest, PlannedAction, RiskTier
from app.stop import StopController, StopRequested
from app.storage import ReceiptStore


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
    executor = SyntheticExecutor(stop, checkpoint_hook=pause_at_checkpoint)
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
