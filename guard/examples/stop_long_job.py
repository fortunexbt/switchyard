"""Stop a long-running tool from another thread.

The tool hashes every file under a directory (by default this Python's own
standard library) and calls checkpoint() between files, so a stop lands within
one file of being pressed.

Run: python examples/stop_long_job.py [directory] [stop-after-seconds]
"""

from __future__ import annotations

import hashlib
import sys
import sysconfig
import threading
from pathlib import Path

from switchyard_guard import Guard, Policy, Stopped, checkpoint


def main() -> None:
    directory = Path(sys.argv[1] if len(sys.argv) > 1 else sysconfig.get_paths()["stdlib"])
    stop_after = float(sys.argv[2]) if len(sys.argv) > 2 else 0.2
    guard = Guard(Policy({"fs.read": "read"}))
    hashed: list[str] = []

    @guard.gated("fs.read", "read")
    def hash_tree(root: str) -> dict[str, str]:
        digests = {}
        for path in sorted(Path(root).rglob("*")):
            checkpoint()
            if path.is_file():
                digests[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
                hashed.append(str(path))
        return digests

    timer = threading.Timer(stop_after, guard.stop, kwargs={"reason": "operator pressed stop"})
    timer.start()
    try:
        digests = hash_tree(str(directory))
        print(f"finished before the stop: {len(digests)} files hashed")
    except Stopped as stopped:
        receipt = stopped.receipt
        print(f"stopped after {len(hashed)} files, {receipt.duration_ms:.0f} ms in")
        print(f"receipt: {receipt.status} {receipt.code}, result fingerprint {receipt.result_fingerprint}")
    finally:
        timer.cancel()

    before = len(hashed)
    try:
        hash_tree(str(directory))
    except Stopped as stopped:
        print(f"next call while latched: {stopped.receipt.code}, {len(hashed) - before} files hashed")
    print(f"stop generation {guard.state.generation}, reason {guard.state.reason!r}")


if __name__ == "__main__":
    main()
