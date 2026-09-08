# Operator runbook

## Local development

From the repository root:

```bash
python -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-dev.txt
(cd frontend && npm ci)
./scripts/dev.sh
```

The API listens on `127.0.0.1:8000`; Vite listens on `127.0.0.1:5173` and proxies `/api`. Runtime receipts go to the ignored `switchyard.db` file unless the database URL is overridden.

The app runs without `.env`. [.env.example](.env.example) is intentionally comment-only so copying it cannot introduce an empty invalid value or a credential-shaped placeholder.

## Containers

```bash
docker compose up --build
```

The frontend is available at `127.0.0.1:3000`; the API is also published at `127.0.0.1:8000` for inspection. Containers bind all interfaces only inside their private network namespace; Compose publishes both ports on host loopback. The backend root filesystem is read-only except for the named `/data` receipt volume and `/tmp`.

## Stop drill

1. Select **Replay incident**. The embedded fixture deliberately waits about four seconds before releasing its result, giving you time to test the stop boundary. This is an inspection window, not live provider work or stage progress.
2. While that replay is pending, select **Stop execution**. Confirm the boundary is latched and the generation increases.
3. Confirm the interrupted replay produces a **stopped** receipt, policy code `denied.stop-during-execution`, and no result or result fingerprint. The API response is HTTP 423; the fixture was never loaded.
4. Select **Reset stop** (or **Review reset**), read the dialog, then select **Acknowledge & reset**. Reset creates its own receipt and increments generation again. It does not revive the interrupted replay.
5. Select **Replay incident** again and leave the inspection window uninterrupted. Confirm the result, source evidence, and **completed** receipt appear.

New actions submitted through the API while stop is latched also return HTTP 423 with a stopped receipt and no result. Tokens issued before stop or reset remain invalid even after new work is allowed.

## Configuration

All settings use the `SWITCHYARD_` prefix:

| Variable | Safe default | Meaning |
| --- | --- | --- |
| `SWITCHYARD_HOST` | `127.0.0.1` | API bind address |
| `SWITCHYARD_PORT` | `8000` | API port |
| `SWITCHYARD_DATABASE_URL` | `sqlite:///./switchyard.db` | Receipt metadata database |
| `SWITCHYARD_CORS_ORIGINS` | two Vite loopback origins | Exact comma-separated allowlist |
| `SWITCHYARD_TRUSTED_HOSTS` | loopback, localhost, testserver | Exact Host allowlist |
| `SWITCHYARD_INITIAL_STOP` | `false` | Start fail-closed after a restart |
| `SWITCHYARD_RECEIPT_LIMIT` | `50` | Maximum ledger rows returned |
| `SWITCHYARD_MAX_CONTENT_LENGTH` | `16384` | Declared request-size ceiling |

Do not change the host to `0.0.0.0` outside an isolated container without implementing the controls listed in [SECURITY.md](SECURITY.md).

## Verification

```bash
./scripts/check.sh
```

For a focused backend run:

```bash
PYTHONPATH=backend .venv/bin/python -m pytest -c backend/pytest.ini backend/tests -q
```

For the console:

```bash
cd frontend
npm run typecheck
npm run build
npm audit --audit-level=high
```
