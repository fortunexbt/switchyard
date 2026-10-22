from __future__ import annotations

import logging

from fastapi.testclient import TestClient

from app.config import Settings
from app.execution import fingerprint
from app.fixtures import FixtureLibrary
from app.schemas import OperatorRequest, StopState


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


def test_fingerprints_match_the_browser_engine_goldens() -> None:
    # frontend/tests/engine.test.ts asserts the same values against the browser port.
    result, sources = FixtureLibrary().load("orbital-relay-recovery")
    assert fingerprint({"result": result, "sources": sources}) == (
        "440cfd9feaf44d014d80d6fd273032e4f1372bf0229f151e2a64fa4d47063b08"
    )
    assert [source.fingerprint for source in sources] == [
        "24c6f4f3cf9c7ad0fb902c81f62be1cf98ced093c2b0fd1abd0abc114100520c",
        "4976a93d332966e49150bb56aa32714b23025ae0f3ce7ee4235aaf64d5259ed8",
        "1f9b4178e36e336fc3f707db5daa3983ef2077d3e571987280b8f43692ac23b9",
    ]
    assert fingerprint(OperatorRequest(command=COMMAND)) == (
        "a5a993fb32cc5363c25005e7c2896151f31a1dfc88cfb2c551cef982559235a3"
    )
    assert fingerprint(OperatorRequest(command='Relay 07 \u2014 drift \u00fc \U0001f6f0 \x7f\n"q"')) == (
        "14265a28e0303defc6db3eadc62b722e81bc00abfb54b46dd1b3954af4fc1d21"
    )
    assert fingerprint(StopState(enabled=True, reason_code="operator-stop", generation=1)) == (
        "b2d06d67ec5fa59585e6911b2e966f9210e940b839c687246136f3c32312b428"
    )


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
