from __future__ import annotations

import asyncio
import threading
import time

import pytest

from switchyard_guard import Guard, Policy, Stopped, checkpoint, fingerprint


def make_guard() -> Guard:
    return Guard(Policy({"job.run": "write", "net.read": "read"}))


def test_calls_while_latched_never_run_and_reset_reopens() -> None:
    guard = make_guard()
    ran = []

    @guard.gated("job.run", "write")
    def job() -> str:
        ran.append(1)
        return "done"

    stop = guard.stop("maintenance")
    assert (guard.state.latched, guard.state.reason, guard.state.generation) == (True, "maintenance", 1)
    with pytest.raises(Stopped) as stopped:
        job()
    assert ran == []
    assert (stopped.value.receipt.status, stopped.value.receipt.code) == ("stopped", "denied.stop-active")

    reset = guard.reset()
    assert job() == "done"
    assert (stop.capability, reset.capability, guard.state.generation) == ("control.stop", "control.reset", 2)
    assert [receipt.tool for receipt in guard.ledger.recent()] == ["job", "guard.reset", "job", "guard.stop"]


def test_a_checkpointing_tool_ends_at_the_next_checkpoint_after_stop() -> None:
    guard = make_guard()
    done = []

    @guard.gated("job.run", "write")
    def migrate(rows: int) -> int:
        for row in range(rows):
            checkpoint()
            time.sleep(0.001)
            done.append(row)
        return len(done)

    threading.Timer(0.05, guard.stop).start()
    with pytest.raises(Stopped) as stopped:
        migrate(5_000)
    assert 0 < len(done) < 5_000
    receipt = stopped.value.receipt
    assert (receipt.status, receipt.code, receipt.result_fingerprint) == ("stopped", "stopped.in-flight", None)


def test_a_tool_cannot_swallow_a_stop_with_except_exception() -> None:
    guard = make_guard()

    @guard.gated("job.run", "write")
    def careless() -> str:
        try:
            guard.stop()
            checkpoint()
        except Exception:
            return "kept going"
        return "kept going"

    with pytest.raises(Stopped) as stopped:
        careless()
    assert stopped.value.receipt.code == "stopped.in-flight"


def test_a_result_finished_after_a_stop_is_withheld() -> None:
    guard = make_guard()

    @guard.gated("job.run", "write")
    def ignores_checkpoints() -> str:
        guard.stop()
        return "secret result"

    with pytest.raises(Stopped) as stopped:
        ignores_checkpoints()
    receipt = stopped.value.receipt
    assert (receipt.code, receipt.result_fingerprint) == ("stopped.after-return", None)


def test_a_token_issued_before_stop_stays_invalid_after_reset() -> None:
    guard = make_guard()
    entered, release = threading.Event(), threading.Event()
    outcome: list[object] = []

    @guard.gated("job.run", "write")
    def slow() -> str:
        entered.set()
        release.wait(5)
        return "late"

    def worker() -> None:
        try:
            outcome.append(slow())
        except Stopped as stopped:
            outcome.append(stopped.receipt.code)

    thread = threading.Thread(target=worker)
    thread.start()
    assert entered.wait(5)
    guard.stop()
    guard.reset()  # The gate is open again, but not for the call admitted before the stop.
    release.set()
    thread.join(5)
    assert outcome == ["stopped.after-return"]
    release.clear()
    threading.Timer(0.01, release.set).start()
    assert slow() == "late"


def test_checkpoint_outside_a_gated_call_does_nothing() -> None:
    checkpoint()


def test_stop_receipts_match_the_browser_engine_golden() -> None:
    # frontend/tests/engine.test.ts asserts this hash for the same stop state.
    assert make_guard().stop().result_fingerprint == (
        "b2d06d67ec5fa59585e6911b2e966f9210e940b839c687246136f3c32312b428"
    )
    command = "Trace the safest recovery route for the captured orbital relay incident."
    assert fingerprint({"command": command, "fixture_id": "orbital-relay-recovery"}) == (
        "a5a993fb32cc5363c25005e7c2896151f31a1dfc88cfb2c551cef982559235a3"
    )
    unicode = 'Relay 07 — drift ü \U0001f6f0 \x7f\n"q"'
    assert fingerprint({"command": unicode, "fixture_id": "orbital-relay-recovery"}) == (
        "14265a28e0303defc6db3eadc62b722e81bc00abfb54b46dd1b3954af4fc1d21"
    )


async def _silent_server() -> tuple[asyncio.Server, int]:
    """A real TCP server that accepts and never answers, like a hung upstream."""

    async def hold(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.read()
        writer.close()

    server = await asyncio.start_server(hold, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


def _gated_reader(guard: Guard):  # type: ignore[no-untyped-def]
    @guard.gated("net.read", "read")
    async def fetch(port: int) -> bytes:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        try:
            writer.write(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            await writer.drain()
            return await reader.read(1)
        finally:
            writer.close()

    return fetch


def test_stop_cancels_an_async_call_blocked_on_a_socket() -> None:
    async def scenario() -> None:
        guard = make_guard()
        fetch = _gated_reader(guard)
        server, port = await _silent_server()
        async with server:
            asyncio.get_running_loop().call_later(0.05, guard.stop)
            started = time.monotonic()
            with pytest.raises(Stopped) as stopped:
                async with asyncio.timeout(2):  # Fail rather than hang if the stop never lands.
                    await fetch(port)
            assert time.monotonic() - started < 1
            assert stopped.value.receipt.code == "stopped.in-flight"
            # The cancel was absorbed: the caller's task is not left half-cancelled.
            assert asyncio.current_task().cancelling() == 0  # type: ignore[union-attr]
            await asyncio.sleep(0.01)

    asyncio.run(scenario())


def test_stop_from_another_thread_reaches_an_async_call() -> None:
    async def scenario() -> None:
        guard = make_guard()
        fetch = _gated_reader(guard)
        server, port = await _silent_server()
        async with server:
            threading.Timer(0.05, guard.stop).start()
            with pytest.raises(Stopped) as stopped:
                async with asyncio.timeout(2):  # Fail rather than hang if the stop never lands.
                    await fetch(port)
            assert stopped.value.receipt.code == "stopped.in-flight"

    asyncio.run(scenario())


def test_a_cancel_that_is_not_a_stop_is_recorded_and_propagates() -> None:
    async def scenario() -> None:
        guard = make_guard()
        fetch = _gated_reader(guard)
        server, port = await _silent_server()
        async with server:
            task = asyncio.create_task(fetch(port))
            await asyncio.sleep(0.05)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        [receipt] = guard.ledger.recent()
        assert (receipt.status, receipt.code) == ("failed", "failed.cancelled")
        assert not guard.state.latched

    asyncio.run(scenario())


def test_nested_async_calls_each_get_a_stopped_receipt() -> None:
    async def scenario() -> None:
        guard = make_guard()
        fetch = _gated_reader(guard)

        @guard.gated("job.run", "write")
        async def crawl(port: int) -> bytes:
            return await fetch(port)

        server, port = await _silent_server()
        async with server:
            asyncio.get_running_loop().call_later(0.05, guard.stop)
            with pytest.raises(Stopped):
                async with asyncio.timeout(2):
                    await crawl(port)
            assert asyncio.current_task().cancelling() == 0  # type: ignore[union-attr]
        calls = [(r.tool, r.code) for r in guard.ledger.recent() if r.capability != "control.stop"]
        assert calls == [("crawl", "stopped.in-flight"), ("fetch", "stopped.in-flight")]

    asyncio.run(scenario())


def test_async_calls_that_finish_are_released() -> None:
    async def scenario() -> None:
        guard = make_guard()

        @guard.gated("net.read", "read")
        async def answer(question: str) -> int:
            await asyncio.sleep(0)
            return 42

        assert await answer("life") == 42
        [receipt] = guard.ledger.recent()
        assert (receipt.status, receipt.result_fingerprint) == ("completed", fingerprint(42))

    asyncio.run(scenario())


def test_a_timeout_around_a_gated_call_stays_a_timeout() -> None:
    async def scenario() -> None:
        guard = make_guard()
        fetch = _gated_reader(guard)
        server, port = await _silent_server()
        async with server:
            with pytest.raises(TimeoutError):
                async with asyncio.timeout(0.05):
                    await fetch(port)
        [receipt] = guard.ledger.recent()
        assert receipt.code == "failed.cancelled"

    asyncio.run(scenario())


def test_pressing_stop_twice_cancels_once() -> None:
    async def scenario() -> None:
        guard = make_guard()
        fetch = _gated_reader(guard)
        server, port = await _silent_server()
        async with server:
            loop = asyncio.get_running_loop()
            loop.call_later(0.05, guard.stop)
            loop.call_later(0.05, guard.stop)
            with pytest.raises(Stopped):
                async with asyncio.timeout(2):
                    await fetch(port)
            assert asyncio.current_task().cancelling() == 0  # type: ignore[union-attr]

    asyncio.run(scenario())


def test_a_tool_that_swallows_the_cancel_still_has_its_result_withheld() -> None:
    async def scenario() -> None:
        guard = make_guard()

        @guard.gated("job.run", "write")
        async def stubborn() -> str:
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                pass
            return "finished anyway"

        asyncio.get_running_loop().call_later(0.05, guard.stop)
        with pytest.raises(Stopped) as stopped:
            async with asyncio.timeout(2):
                await stubborn()
        assert stopped.value.receipt.code == "stopped.after-return"
        assert asyncio.current_task().cancelling() == 0  # type: ignore[union-attr]

    asyncio.run(scenario())


def test_a_stop_between_admission_and_tracking_still_halts_the_async_call() -> None:
    # Found by the property test: a latch here saw no task to cancel and the call hung.
    async def scenario() -> None:
        guard = make_guard()
        track = guard._track

        def latch_then_track(task, token):  # type: ignore[no-untyped-def]
            guard.stop()
            track(task, token)

        guard._track = latch_then_track  # type: ignore[method-assign]

        @guard.gated("job.run", "write")
        async def hang() -> None:
            await asyncio.Event().wait()

        with pytest.raises(Stopped) as stopped:
            async with asyncio.timeout(1):
                await hang()
        assert stopped.value.receipt.code == "stopped.before-start"
        assert asyncio.current_task().cancelling() == 0  # type: ignore[union-attr]

    asyncio.run(scenario())
