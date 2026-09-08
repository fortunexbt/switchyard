# Architecture

Switchyard is deliberately smaller than its interface suggests. The console visualizes a narrow, enforceable backend spine instead of presenting disconnected features as capabilities.

## Invariants

1. **One mutation boundary.** HTTP routes cannot invoke an executor or mutate stop state directly; they call `ActionGateway`.
2. **Plan before admission.** Each action declares a kind, capability, risk tier, synthetic/live status, and body-free summary.
3. **Fail closed.** Unknown capabilities, live executors, writes, and ordinary work while stopped are denied.
4. **Stop tokens survive reset.** Each stop or reset increments a generation. A token issued before either transition can never become valid again.
5. **Receipts, not transcripts.** SQLite stores identifiers, timestamps, policy codes, generation, status, and SHA-256 fingerprints. It has no command, answer, source-body, or free-form log column.
6. **Offline means offline.** The shipped executor reads only a packaged JSON resource. No HTTP client or provider adapter is part of the runtime dependency set.

## Execution sequence

`POST /api/actions` validates a strict Pydantic request, fingerprints it, and creates a deterministic plan. The gateway evaluates every planned action against the policy allowlist and current stop state. An admitted executor receives a generation token and must checkpoint before and after meaningful work. Completed, blocked, stopped, and failed attempts all produce a receipt.

The packaged fixture has a deliberate four-second inspection window before it is loaded. This is synthetic pacing so an operator can stop an in-flight replay; it is not external execution, provider latency, or reported stage progress. A monotonic deadline bounds the window, with sleeps requested for at most 100 ms and token checkpoints before and after each await. Event-loop scheduling can extend a sleep. A stop, including a stop followed immediately by reset, invalidates the in-flight token and prevents fixture loading and result release. The executor checks again around loading and before returning the unchanged deterministic fixture and source fingerprints. Tests can explicitly set a zero-second window without changing the production default.

Stop enablement is always admissible. Reset is a distinct action with a literal acknowledgement. If receipt persistence fails during reset, the gateway re-latches stop so loss of auditability fails safe.

## Components

| Component | Responsibility | Forbidden responsibility |
| --- | --- | --- |
| FastAPI routes | Validation, HTTP status, response models | Executing work or storing bodies |
| `ActionGateway` | Ordering plan → gate → checkpoints → receipt | Provider-specific logic |
| `PolicyEngine` | Exact allowlist checks | Duplicating stop state |
| `StopController` | State, generation, token validation | Persistence or policy |
| `SyntheticExecutor` | Hold an interruptible inspection window, then load the packaged fixture between checkpoints | Network, filesystem writes, subprocesses |
| `ReceiptStore` | Persist reduced receipt schema | Commands, answers, excerpts, exception text |
| React console | Visualize server decisions and send controls | Predicting policy locally |

## Adding a future executor

A provider is not a capability until all of these are true:

- its exact network destinations and scopes are documented and allowlisted;
- it accepts a stop token and checkpoints around every external wait and side effect;
- timeouts, response-size limits, redirect policy, and SSRF controls are tested;
- secrets come from runtime configuration and are never returned to the browser;
- policy evaluates each proposed side effect, not merely the top-level request;
- receipts remain body-free and failures map to stable public codes;
- documentation and UI call the integration experimental until an end-to-end verification test exists.

Write executors need a separate proposal/approval/rollback design. Proof mode intentionally does not contain a dormant write flag.

## Data model

The only persistent table is `audit_receipts`:

```text
receipt_id · created_at · status · action_kind · capability · policy_code
stop_generation · request_fingerprint · result_fingerprint · synthetic
```

Fingerprints support local correlation and repeatability checks. They are not signatures and do not make a tamperable local SQLite database trustworthy.
