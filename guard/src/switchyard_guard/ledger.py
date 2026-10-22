from __future__ import annotations

import sqlite3
import threading
from dataclasses import astuple, dataclass, fields
from pathlib import Path
from typing import Literal, Protocol

Status = Literal["completed", "blocked", "stopped", "failed"]


@dataclass(frozen=True)
class Receipt:
    """What a call leaves behind. Arguments and results appear only as fingerprints."""

    receipt_id: str
    created_at: str
    tool: str
    capability: str
    risk: str
    status: Status
    code: str
    stop_generation: int
    args_fingerprint: str | None
    result_fingerprint: str | None
    duration_ms: float | None


class Ledger(Protocol):
    def append(self, receipt: Receipt) -> None: ...

    def recent(self, limit: int = 50) -> list[Receipt]: ...


class MemoryLedger:
    def __init__(self) -> None:
        self._rows: list[Receipt] = []
        self._lock = threading.Lock()

    def append(self, receipt: Receipt) -> None:
        with self._lock:
            self._rows.append(receipt)

    def recent(self, limit: int = 50) -> list[Receipt]:
        with self._lock:
            return self._rows[::-1][:limit]


_COLUMNS = tuple(field.name for field in fields(Receipt))


class SQLiteLedger:
    """One table with exactly the receipt fields. There is no column a body could go in."""

    def __init__(self, path: str | Path) -> None:
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock, self._db:
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS receipts ("
                "receipt_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, tool TEXT NOT NULL, "
                "capability TEXT NOT NULL, risk TEXT NOT NULL, status TEXT NOT NULL, "
                "code TEXT NOT NULL, stop_generation INTEGER NOT NULL, args_fingerprint TEXT, "
                "result_fingerprint TEXT, duration_ms REAL)"
            )

    def append(self, receipt: Receipt) -> None:
        placeholders = ",".join("?" * len(_COLUMNS))
        with self._lock, self._db:
            self._db.execute(f"INSERT INTO receipts ({','.join(_COLUMNS)}) VALUES ({placeholders})", astuple(receipt))

    def recent(self, limit: int = 50) -> list[Receipt]:
        with self._lock:
            rows = self._db.execute(
                f"SELECT {','.join(_COLUMNS)} FROM receipts ORDER BY rowid DESC LIMIT ?", (limit,)
            ).fetchall()
        return [Receipt(*row) for row in rows]

    def close(self) -> None:
        with self._lock:
            self._db.close()
