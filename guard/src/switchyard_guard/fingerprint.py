from __future__ import annotations

import dataclasses
import hashlib
import hmac
import json
from datetime import date, datetime
from enum import Enum
from pathlib import PurePath
from typing import Any


def canonical_json(value: Any) -> str:
    """Sorted keys, no whitespace, ASCII only. frontend/src/lib/engine.ts matches this byte for byte."""
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        default=_json_default,
    )


def fingerprint(value: Any, key: bytes | None = None) -> str:
    """SHA-256 of the canonical JSON, or HMAC-SHA256 when a key is given.

    An unkeyed fingerprint of a low-entropy value (a yes/no flag, a short path)
    can be recovered by guessing. Pass a key when receipts leave the process.
    """
    data = canonical_json(value).encode("ascii")
    if key is None:
        return hashlib.sha256(data).hexdigest()
    return hmac.new(key, data, hashlib.sha256).hexdigest()


def _json_default(value: Any) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, PurePath):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"bytes.sha256": hashlib.sha256(value).hexdigest()}
    if isinstance(value, (set, frozenset)):
        return sorted(value, key=canonical_json)
    # Clients, sessions and other live objects are recorded by type, never by repr,
    # because a repr can carry credentials and is not stable across runs.
    return {"opaque": f"{type(value).__module__}.{type(value).__qualname__}"}
