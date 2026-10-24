"""The single Warm-Up configuration (data/warmup_config.json) and helpers to read it.

Bands, time-cap multipliers, tilt thresholds, per-level drill difficulty and session
budgets all live in that one JSON file -- a design hypothesis, tuned by the experiment.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from ml.config import DATA_DIR

CONFIG_PATH = DATA_DIR / "warmup_config.json"
BANK_DB = DATA_DIR / "puzzles" / "warmup_bank.db"
STORE_DB = DATA_DIR / "warmup.db"
TIME_CONTROLS = ("bullet", "blitz", "rapid", "classical")


@lru_cache(maxsize=1)
def _load(mtime: float) -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def cfg() -> dict:
    return _load(Path(CONFIG_PATH).stat().st_mtime)


def band_for(rating: int | None) -> dict:
    r = int(rating or 1200)
    for b in cfg()["bands"]:
        if b["min"] <= r <= b["max"]:
            return b
    return cfg()["bands"][-1]


def band_by_id(band_id: str) -> dict:
    return next((b for b in cfg()["bands"] if b["id"] == band_id), cfg()["bands"][2])


def drill_cfg(drill: str) -> dict:
    return cfg()["drills"][drill]


def level_value(drill: str, key: str, level: int):
    """Per-level setting (levels 1..5)."""
    values = cfg()["drills"][drill]["levels"][key]
    return values[max(1, min(5, int(level))) - 1]


def tc_multiplier(time_control: str) -> float:
    return cfg()["time_controls"].get(time_control, cfg()["time_controls"]["rapid"])["multiplier"]


def cap_ms(drill: str, band: dict, time_control: str) -> int | None:
    """Per-item time cap: base x band multiplier x time-control multiplier."""
    base = cfg()["drills"][drill].get("cap_ms")
    if base is None:
        return None
    return int(base * band["multiplier"] * tc_multiplier(time_control))


def flash_ms(base: int, band: dict, time_control: str) -> int:
    """Flash / show durations scale like caps but never below what's perceivable."""
    return max(250, int(base * band["multiplier"] * tc_multiplier(time_control)))
