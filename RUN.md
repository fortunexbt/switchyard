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

1. Route the default fixture and confirm a completed receipt.
2. Select **STOP NOW**. The boundary strip must show `LATCHED` and the generation must increase.
3. Attempt another route. The API returns HTTP 423 with a stopped receipt and no result.
4. Select reset, read the browser confirmation, and acknowledge it. Reset creates its own receipt and increments generation again.
5. Route the fixture once more. Previously issued tokens remain invalid even though new work is allowed.

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
