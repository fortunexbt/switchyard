# Security policy and threat model

## Supported release

Only the current `main` branch is intended to receive security fixes. Do not include secrets, private command bodies, database files, or exploit payloads in a public issue. Use GitHub's private vulnerability reporting feature if it is enabled for the repository.

## Security posture

Switchyard is a **single-user, loopback-only demonstration**, not a remotely deployable control plane. Its default environment has no credentials and makes no network request. The useful security property is structural: execution/control mutations cross one policy and stop boundary and leave reduced receipts.

The revival removed these concrete hazards from the earlier prototype:

- wildcard credentialed CORS became an exact, non-credentialed loopback allowlist;
- the default server bind moved from all interfaces to `127.0.0.1`;
- raw exception strings and validation inputs no longer reach clients;
- conversation, retrieval, answer, source-body, and free-form audit storage were removed;
- live search, voice, and direct plan routes that bypassed the stop boundary were removed;
- stop/reset now invalidate issued generation tokens and are themselves audited;
- the skipped async stop test now has an explicit `pytest-asyncio` dependency;
- unverified integration and voice claims were removed from code, UI, and docs;
- security headers, strict request schemas, declared body limits, non-root containers, and loopback-only published ports were added.

## Threats considered

| Threat | Mitigation |
| --- | --- |
| Remote browser calls | Loopback bind, exact CORS, no credentialed cross-origin requests |
| Host-header abuse | Exact trusted-host middleware |
| Accidental execution after stop | Generation tokens checked around executor work |
| Reset making an old task valid | Reset increments generation; old tokens stay invalid |
| Sensitive text in receipts | SHA-256 fingerprints and fixed enumerated fields only |
| Raw failure disclosure | Stable public errors and exception-type-only server logging |
| Supply-chain drift | Exact direct dependency pins, npm lockfile, CI audits, Dependabot |
| Secret accidentally committed | Ignore rules, blank/comment-only env example, CI pattern scan |
| Misleading capability claims | Offline fixture disclosure and explicit limitation list |

## Known risks

- There is **no authentication or authorization**. Any process or user able to reach the loopback port can replay the fixture, stop, reset, and read receipt metadata. Never bind this build to a LAN or public interface.
- CORS and trusted-host checks are browser/request-routing defenses, not identity controls.
- Stop state is in memory and scoped to one process. Restarting the process resets it unless `SWITCHYARD_INITIAL_STOP=true`; multiple workers would not share state. The run configurations intentionally use one worker.
- Cancellation is cooperative. The shipped synthetic executor checkpoints correctly; a future adapter could violate the contract if it is added without the required tests.
- SQLite is neither encrypted nor append-only. Local administrators can read or alter receipts. Fingerprints are correlators, not cryptographic attestations.
- A SHA-256 fingerprint of low-entropy input can be guessed by dictionary attack. Do not treat hashing as anonymization.
- The content-length check relies on the declared HTTP header. Pydantic also limits command length, but a hardened remote service would need an upstream byte limit.
- Container image and CI action tags are not digest-pinned yet. Dependency audits reduce, but do not remove, supply-chain risk.
- Browser confirmation protects reset from a casual click, not a malicious local caller.

## Before expanding scope

Add authentication, shared durable stop state, signed append-only receipts, request rate limits, reverse-proxy byte limits, CSRF analysis, and a deployment-specific trust model before any non-loopback deployment. Live network adapters also need destination allowlists, SSRF/redirect defenses, strict timeouts/size limits, and stop checkpoints around every I/O boundary.
