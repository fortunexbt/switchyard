"""An async HTTP tool with a host allowlist, stopped while a request is in flight.

Needs network access. Run: python examples/http_fetch.py

stop() cancels an async gated call at whatever it is awaiting, so the slow
request below ends when the stop lands rather than when the server answers.
"""

from __future__ import annotations

import asyncio
import time
from urllib.parse import urlsplit

from switchyard_guard import Call, Denied, Guard, Policy, Rule, Stopped

ALLOWED_HOSTS = frozenset({"www.python.org", "httpbin.org"})


def host_allowed(call: Call) -> bool:
    parts = urlsplit(call.args["url"])
    return parts.scheme == "https" and parts.hostname in ALLOWED_HOSTS


guard = Guard(Policy({"http.get": "read"}, [Rule("http.host-allowlisted", host_allowed)]))


@guard.gated("http.get", "read")
async def http_get(url: str) -> tuple[int, int]:
    """Fetch a URL over HTTPS and return (status, body bytes)."""
    parts = urlsplit(url)
    reader, writer = await asyncio.open_connection(parts.hostname, 443, ssl=True)
    try:
        path = parts.path or "/"
        writer.write(f"GET {path} HTTP/1.1\r\nHost: {parts.hostname}\r\nConnection: close\r\n\r\n".encode())
        await writer.drain()
        response = await reader.read()
    finally:
        writer.close()
    status = int(response.split(b" ", 2)[1])
    return status, len(response.partition(b"\r\n\r\n")[2])


async def main() -> None:
    for url in ("https://www.python.org/", "https://example.com/"):
        try:
            print(f"GET {url} -> {await http_get(url)}")
        except Denied as denied:
            print(f"GET {url} -> denied: {denied.decision.code}")

    # httpbin waits five seconds before answering. Stop after half a second.
    asyncio.get_running_loop().call_later(0.5, guard.stop)
    started = time.monotonic()
    try:
        await http_get("https://httpbin.org/delay/5")
    except Stopped as stopped:
        print(f"GET https://httpbin.org/delay/5 -> {stopped.receipt.code} after {time.monotonic() - started:.2f} s")

    print("\nreceipts, newest first:")
    for receipt in guard.ledger.recent():
        print(f"  {receipt.status:<9} {receipt.tool:<10} {receipt.code}")


if __name__ == "__main__":
    asyncio.run(main())
