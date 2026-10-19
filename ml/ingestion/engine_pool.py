"""
A small pool of Stockfish processes for parallel, per-game annotation.

Each worker thread owns one single-threaded engine (cheaper and more scalable
than one multi-threaded engine at the shallow depths we use). `map` preserves
input order. Safe on Windows: the Proactor event-loop policy is applied in every
worker thread so chess.engine can spawn the subprocess.
"""
from __future__ import annotations

import asyncio
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Iterable, TypeVar

import chess.engine

from ml.config import STOCKFISH_PATH

T = TypeVar("T")
R = TypeVar("R")


def default_workers() -> int:
    env = os.environ.get("FORKED_SF_WORKERS")
    if env:
        return max(1, int(env))
    return max(1, min(6, (os.cpu_count() or 2) - 2))


class EnginePool:
    def __init__(self, workers: int | None = None, path: Path | None = None,
                 hash_mb: int = 64):
        self.workers = workers or default_workers()
        self.path = str(path or STOCKFISH_PATH)
        self.hash_mb = hash_mb
        self._local = threading.local()
        self._engines: list[chess.engine.SimpleEngine] = []
        self._lock = threading.Lock()
        self._exec = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix="sf")

    def _engine(self) -> chess.engine.SimpleEngine:
        eng = getattr(self._local, "engine", None)
        if eng is None:
            if sys.platform == "win32":
                asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
            eng = chess.engine.SimpleEngine.popen_uci(self.path)
            eng.configure({"Threads": 1, "Hash": self.hash_mb})
            self._local.engine = eng
            with self._lock:
                self._engines.append(eng)
        return eng

    def map(self, fn: Callable[[chess.engine.SimpleEngine, T], R], items: Iterable[T],
            on_done: Callable[[int, R], None] | None = None) -> list[R]:
        items = list(items)
        futures = [self._exec.submit(lambda it=it: fn(self._engine(), it)) for it in items]
        out: list[R] = []
        for i, f in enumerate(futures):
            r = f.result()
            out.append(r)
            if on_done:
                on_done(i, r)
        return out

    def close(self) -> None:
        self._exec.shutdown(wait=True)
        with self._lock:
            for e in self._engines:
                try:
                    e.quit()
                except Exception:
                    pass
            self._engines.clear()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
