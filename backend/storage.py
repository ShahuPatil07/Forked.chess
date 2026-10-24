"""
Tiny file-backed storage helpers shared by the auth service, the game library,
coach chat history and drill stats.

Forked is deliberately file-backed (no database server): every per-user record
is a JSON file under data/. These helpers make that safe enough for a
single-process FastAPI app with worker threads:

  * writes are atomic (write to a temp file in the same directory, then
    os.replace), so a crash never leaves half a JSON file behind;
  * one re-entrant lock per path serialises read-modify-write cycles
    (`locked_update`), so two requests can't lose each other's changes.

Scaling note: this is a per-process lock. Running several API processes
against the same data/ directory needs a real store (see PLANS.md).
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()

_SAFE = re.compile(r"[^A-Za-z0-9_.\-]")


def safe_name(value: str, max_len: int = 80) -> str:
    """A filesystem-safe version of a user-supplied key (usernames, ids)."""
    cleaned = _SAFE.sub("_", (value or "").strip())[:max_len]
    return cleaned or "_"


def lock_for(path: Path) -> threading.RLock:
    key = str(Path(path).resolve())
    with _locks_guard:
        lk = _locks.get(key)
        if lk is None:
            lk = _locks[key] = threading.RLock()
        return lk


def read_json(path: Path, default: Any = None) -> Any:
    path = Path(path)
    if not path.exists():
        return default
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def write_json(path: Path, data: Any, *, indent: int | None = None) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with lock_for(path):
        fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=indent, default=str, ensure_ascii=False)
            # Windows briefly refuses to replace a file another process has open
            for attempt in range(8):
                try:
                    os.replace(tmp, path)
                    break
                except PermissionError:
                    if attempt == 7:
                        raise
                    time.sleep(0.04 * (attempt + 1))
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


@contextmanager
def locked(path: Path) -> Iterator[None]:
    with lock_for(path):
        yield


def locked_update(path: Path, default: Any, fn: Callable[[Any], Any], *, indent: int | None = None) -> Any:
    """Read → transform → write under the path's lock. `fn` may mutate and/or
    return the new value (None means "use the mutated value")."""
    with lock_for(path):
        current = read_json(path, default)
        result = fn(current)
        value = current if result is None else result
        write_json(path, value, indent=indent)
        return value
