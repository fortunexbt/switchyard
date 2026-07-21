from __future__ import annotations

import hashlib
import json
from importlib.resources import files

from pydantic import BaseModel, ConfigDict

from .schemas import DemoResult, DemoSignal, SourceProof


class _FixtureSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_id: str
    label: str
    captured_at: str
    content: str


class _FixtureDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fixture_id: str
    fixture_version: str
    headline: str
    summary: str
    signals: list[DemoSignal]
    recommended_sequence: list[str]
    sources: list[_FixtureSource]


class FixtureLibrary:
    _known = {"orbital-relay-recovery": "orbital-relay-recovery.json"}

    def load(self, fixture_id: str) -> tuple[DemoResult, list[SourceProof]]:
        filename = self._known.get(fixture_id)
        if filename is None:
            raise LookupError("unknown fixture identifier")
        raw = files("app.demo_data").joinpath(filename).read_text(encoding="utf-8")
        document = _FixtureDocument.model_validate(json.loads(raw))
        result = DemoResult(
            fixture_id=document.fixture_id,
            fixture_version=document.fixture_version,
            headline=document.headline,
            summary=document.summary,
            signals=document.signals,
            recommended_sequence=document.recommended_sequence,
            disclosure="Embedded deterministic fixture; no network or live system was contacted.",
        )
        sources = [
            SourceProof(
                source_id=source.source_id,
                label=source.label,
                captured_at=source.captured_at,
                fingerprint=hashlib.sha256(source.content.encode("utf-8")).hexdigest(),
            )
            for source in document.sources
        ]
        return result, sources
