from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient


COMMAND = "Trace the safest recovery route for the captured orbital relay incident."


def test_every_execution_emits_body_free_receipt(client: TestClient, database_path: Path) -> None:
    private_marker = "PRIVATE-OPERATOR-BODY-9f49"
    response = client.post(
        "/api/actions",
        json={"command": f"{COMMAND} {private_marker}", "fixture_id": "orbital-relay-recovery"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["result"]["disclosure"].startswith("Embedded deterministic fixture")
    assert payload["receipt"]["status"] == "completed"
    assert len(payload["receipt"]["request_fingerprint"]) == 64
    assert private_marker.encode() not in database_path.read_bytes()
    assert payload["result"]["headline"].encode() not in database_path.read_bytes()

    ledger = client.get("/api/receipts").json()["receipts"]
    assert ledger[0] == payload["receipt"]
    assert "command" not in ledger[0]
    assert "result" not in ledger[0]


def test_stop_is_explicit_audited_and_fail_closed(client: TestClient) -> None:
    stopped = client.post("/api/stop", json={"reason": "operator safety drill"})
    assert stopped.status_code == 200
    assert stopped.json()["state"]["enabled"] is True
    assert stopped.json()["receipt"]["action_kind"] == "stop.enable"

    blocked = client.post("/api/actions", json={"command": COMMAND})
    assert blocked.status_code == 423
    assert blocked.json()["receipt"]["status"] == "stopped"
    assert blocked.json()["result"] is None

    accidental_reset = client.post("/api/stop/reset", json={"acknowledge": "yes"})
    assert accidental_reset.status_code == 422
    assert client.get("/api/state").json()["stop"]["enabled"] is True

    reset = client.post(
        "/api/stop/reset",
        json={"acknowledge": "resume synthetic execution"},
    )
    assert reset.status_code == 200
    assert reset.json()["state"]["enabled"] is False
    assert reset.json()["receipt"]["action_kind"] == "stop.reset"
    assert client.post("/api/actions", json={"command": COMMAND}).status_code == 200


def test_cors_is_exact_and_never_credentialed(client: TestClient) -> None:
    allowed = client.options(
        "/api/actions",
        headers={
            "Origin": "http://127.0.0.1:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert allowed.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
    assert "access-control-allow-credentials" not in allowed.headers

    denied = client.options(
        "/api/actions",
        headers={
            "Origin": "https://attacker.invalid",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert "access-control-allow-origin" not in denied.headers


def test_removed_bypass_routes_are_not_registered(client: TestClient) -> None:
    paths = client.get("/openapi.json").json()["paths"]
    assert "/search" not in paths
    assert "/voice" not in paths
    assert "/kill" not in paths
    assert "/plan" not in paths


def test_validation_does_not_echo_input(client: TestClient) -> None:
    private_marker = "PRIVATE-VALIDATION-MARKER"
    response = client.post("/api/actions", json={"command": private_marker * 40})
    assert response.status_code == 422
    assert private_marker not in response.text
    assert response.json()["code"] == "request.invalid"


def test_security_headers_are_present(client: TestClient) -> None:
    response = client.get("/health")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["cache-control"] == "no-store"
    assert "microphone=()" in response.headers["permissions-policy"]
