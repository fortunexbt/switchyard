# Product

<!-- impeccable:product-schema 1 -->

(Inferred from the repository and the showcase brief; no interview was possible in this unattended run.)

## Platform

web

## Users
Python developers who hand functions to an agent as tools and need to deny some calls, stop a run, and keep an audit trail without storing arguments. They use the `guard/` package. The hosted console shows the same pattern to someone opening it cold on a laptop or phone.

## Product Purpose
Switchyard is a local-first operator console. It replays one versioned incident fixture (orbital relay recovery) through a deny-by-default policy gate, lets the operator stop in-flight work by invalidating generation tokens, and records body-free audit receipts (fingerprints, not commands or results). Success: a visitor sees a route planned, gated, executing, and stopped within seconds, and can inspect the receipt.

## Positioning
A stop is token invalidation checked at every checkpoint, not a boolean at route entry. Receipts store SHA-256 fingerprints only. It is an offline proof with no live integrations, and says so.

## Operating Context
Single screen: start a replay, watch the route, press Stop, reset with an explicit acknowledgement, browse the receipt ledger and operating rules.

## Capabilities and Constraints
Three capabilities: fixtures.read, control.stop, control.reset. Writes always denied. Replay has a 4 s inspection window so stop can interrupt it. Hosted demo runs a TypeScript port of the gateway in the browser; local mode uses FastAPI + SQLite.

## Brand Commitments
Name "Switchyard". Plain, exact voice. Limitations labelled in the product.

## Evidence on Hand
Fixture JSON at backend/app/demo_data/orbital-relay-recovery.json is an invented drill and the page says so. The guard package runs on the user's own functions. No customers or benchmarks exist.

## Product Principles
- Make the safety boundary visible.
- Prove with executable evidence, not placeholders.
- Never present an unconfirmed boundary as open.
- Keep the stop control reachable at all times.
