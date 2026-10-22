from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from enum import IntEnum
from typing import Any


class Risk(IntEnum):
    """Ordered: a grant at one level admits calls at that level or below."""

    READ = 1
    WRITE = 2
    DESTRUCTIVE = 3

    @classmethod
    def parse(cls, value: Risk | str) -> Risk:
        return value if isinstance(value, Risk) else cls[value.upper()]

    @property
    def label(self) -> str:
        return self.name.lower()


@dataclass(frozen=True)
class Call:
    """One tool call as the gate sees it, with the arguments it will run with."""

    tool: str
    capability: str
    risk: Risk
    args: Mapping[str, Any]


@dataclass(frozen=True)
class Rule:
    """A predicate over a call's real arguments. Returning False or raising denies the call."""

    name: str
    check: Callable[[Call], bool]
    capabilities: frozenset[str] | None = None

    def applies_to(self, call: Call) -> bool:
        return self.capabilities is None or call.capability in self.capabilities


@dataclass(frozen=True)
class Check:
    code: str
    passed: bool


@dataclass(frozen=True)
class Decision:
    allowed: bool
    code: str
    checks: tuple[Check, ...]


class Policy:
    """Deny by default: a capability runs only if granted, at or below its granted risk."""

    def __init__(self, grants: Mapping[str, Risk | str], rules: Iterable[Rule] = ()) -> None:
        self._grants = {capability: Risk.parse(risk) for capability, risk in grants.items()}
        self._rules = tuple(rules)

    def evaluate(self, call: Call, *, stopped: bool) -> Decision:
        granted = self._grants.get(call.capability)
        checks = [
            Check("stop.open", not stopped),
            Check("capability.granted", granted is not None),
            Check("risk.within-grant", granted is not None and call.risk <= granted),
        ]
        checks += [Check(f"rule.{rule.name}", _passes(rule, call)) for rule in self._rules if rule.applies_to(call)]
        failed = next((check for check in checks if not check.passed), None)
        if failed is None:
            return Decision(True, "allowed", tuple(checks))
        code = {
            "stop.open": "denied.stop-active",
            "capability.granted": "denied.capability",
            "risk.within-grant": "denied.risk",
        }.get(failed.code, f"denied.{failed.code}")
        return Decision(False, code, tuple(checks))


def _passes(rule: Rule, call: Call) -> bool:
    try:
        return rule.check(call) is True
    except Exception:
        return False  # A rule that cannot decide fails closed.
