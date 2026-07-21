from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def database_path(tmp_path: Path) -> Path:
    return tmp_path / "receipts.db"


@pytest.fixture
def client(database_path: Path) -> Iterator[TestClient]:
    settings = Settings(
        database_url=f"sqlite:///{database_path}",
        cors_origins="http://127.0.0.1:5173,http://localhost:5173",
        trusted_hosts="127.0.0.1,localhost,testserver",
    )
    app = create_app(settings)
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client
