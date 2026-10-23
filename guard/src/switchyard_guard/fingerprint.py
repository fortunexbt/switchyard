from __future__ import annotations

import dataclasses
import hashlib
import hmac
import json
import math
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from pathlib import PurePath
from typing import Any


def canonical_json(value: Any) -> str:
    """The bytes a fingerprint is taken over: sorted keys, no whitespace, ASCII only.

    It matches canonicalJson in frontend/src/lib/guard.ts for every JSON value, including
    floats (written the way JavaScript writes numbers) and keys outside the BMP (sorted by
    UTF-16 code unit, as JavaScript sorts them). Integers beyond 2**53 have no exact
    JavaScript equivalent.
    """
    if value is None or isinstance(value, bool):
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=True)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _js_number(value)
    if isinstance(value, dict):
        items = sorted(((_key(key), item) for key, item in value.items()), key=lambda pair: _utf16(pair[0]))
        return "{" + ",".join(f"{json.dumps(key)}:{canonical_json(item)}" for key, item in items) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    return canonical_json(_to_data(value))


def fingerprint(value: Any, key: bytes | None = None) -> str:
    """SHA-256 of the canonical JSON, or HMAC-SHA256 when a key is given.

    An unkeyed fingerprint of a low-entropy value (a yes/no flag, a short path)
    can be recovered by guessing. Pass a key when receipts leave the process.
    """
    data = canonical_json(value).encode("ascii")
    if key is None:
        return hashlib.sha256(data).hexdigest()
    return hmac.new(key, data, hashlib.sha256).hexdigest()


def _to_data(value: Any) -> Any:
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


def _key(key: Any) -> str:
    if isinstance(key, str):
        return key
    if key is None or isinstance(key, (bool, int, float)):
        return canonical_json(key).strip('"')
    return f"<{type(key).__qualname__}>"


def _utf16(text: str) -> bytes:
    return text.encode("utf-16-be", "surrogatepass")


def _js_number(value: float) -> str:
    """Number.prototype.toString, which JSON.stringify uses. NaN and infinities become null."""
    if not math.isfinite(value):
        return "null"
    if value == 0:
        return "0"
    if value < 0:
        return "-" + _js_number(-value)
    # repr gives the shortest round-tripping digits, the same digits JavaScript picks.
    sign, digits, exponent = Decimal(repr(value)).normalize().as_tuple()
    text = "".join(map(str, digits))
    k = len(text)
    n = exponent + k  # position of the decimal point relative to the digits
    if k <= n <= 21:
        return text + "0" * (n - k)
    if 0 < n <= 21:
        return f"{text[:n]}.{text[n:]}"
    if -6 < n <= 0:
        return "0." + "0" * -n + text
    e = n - 1
    mantissa = text if k == 1 else f"{text[0]}.{text[1:]}"
    return f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"
