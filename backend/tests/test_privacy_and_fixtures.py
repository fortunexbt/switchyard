from __future__ import annotations

import logging

from fastapi.testclient import TestClient

from app.config import Settings


COMMAND = "Trace the safest recovery route for the captured orbital relay incident."


def test_default_is_loopback_and_offline() -> None:
    settings = Settings(_env_file=None)
    assert settings.host == "127.0.0.1"
    assert settings.database_url.endswith("switchyard.db")
    assert all("*" not in origin for origin in settings.allowed_origins)


def test_fixture_output_and_source_hashes_are_deterministic(client: TestClient) -> None:
    first = client.post("/api/actions", json={"command": COMMAND}).json()
    second = client.post("/api/actions", json={"command": COMMAND}).json()

    assert first["result"] == second["result"]
    assert first["sources"] == second["sources"]
    assert first["receipt"]["result_fingerprint"] == second["receipt"]["result_fingerprint"]
    assert first["plan"] == second["plan"]


def test_raw_exception_is_hidden_from_response_and_logs(
    client: TestClient,
    caplog,
) -> None:  # type: ignore[no-untyped-def]
    private_exception = "PROVIDER-SECRET-ERROR-61ca"

    async def fail_safely(*_args, **_kwargs):  # type: ignore[no-untyped-def]
        raise RuntimeError(private_exception)

    client.app.state.gateway.executor.run = fail_safely
    with caplog.at_level(logging.ERROR):
        response = client.post("/api/actions", json={"command": COMMAND})

    assert response.status_code == 500
    assert response.json()["code"] == "request.failed"
    assert private_exception not in response.text
    assert private_exception not in caplog.text
    assert "RuntimeError" in caplog.text


def test_state_names_real_limitations(client: TestClient) -> None:
    payload = client.get("/api/state").json()
    joined = " ".join(payload["limitations"]).lower()
    assert payload["mode"] == "offline-proof"
    assert "no network" in joined
    assert "voice" in joined
