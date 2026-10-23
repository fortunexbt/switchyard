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
    """Deny by default: a capability runs only if granted, at or below its granted risk, and
    while its budget (a maximum number of calls, if one is set) has calls left.

    A budget is a hard limit enforced before the call runs. There is no warning mode: an
    agent told its budget is spent may call again anyway (see guard/README.md).
    """

    def __init__(
        self,
        grants: Mapping[str, Risk | str],
        rules: Iterable[Rule] = (),
        *,
        budgets: Mapping[str, int] | None = None,
    ) -> None:
        self._grants = {capability: Risk.parse(risk) for capability, risk in grants.items()}
        self._rules = tuple(rules)
        self._budgets = dict(budgets or {})
        if any(limit < 0 for limit in self._budgets.values()):
            raise ValueError("budgets must be non-negative")

    def evaluate(self, call: Call, *, stopped: bool, spent: Mapping[str, int] | None = None) -> Decision:
        """Decide one call. `spent` is how many calls each capability has already been admitted."""
        granted = self._grants.get(call.capability)
        checks = [
            Check("stop.open", not stopped),
            Check("capability.granted", granted is not None),
            Check("risk.within-grant", granted is not None and call.risk <= granted),
        ]
        limit = self._budgets.get(call.capability)
        if limit is not None:
            checks.append(Check("budget.remaining", (spent or {}).get(call.capability, 0) < limit))
        checks += [Check(f"rule.{rule.name}", _passes(rule, call)) for rule in self._rules if rule.applies_to(call)]
        failed = next((check for check in checks if not check.passed), None)
        if failed is None:
            return Decision(True, "allowed", tuple(checks))
        code = {
            "stop.open": "denied.stop-active",
            "capability.granted": "denied.capability",
            "risk.within-grant": "denied.risk",
            "budget.remaining": "denied.budget",
        }.get(failed.code, f"denied.{failed.code}")
        return Decision(False, code, tuple(checks))


def _passes(rule: Rule, call: Call) -> bool:
    try:
        return rule.check(call) is True
    except Exception:
        return False  # A rule that cannot decide fails closed.
