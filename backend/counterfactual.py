"""
Feature 4 — Counterfactual Rating.

"If you'd handled this pattern correctly in your last N games, your rating would
be X instead of Y." A simulation, clearly labelled as an estimate.

Algorithm (per the spec):
  For each game in the user's history:
    1. Find every mistake that matched a blindspot cluster (centroid nearest —
       identified by cluster_id, never label).
    2. For the FIRST such mistake per game only: it is "recoverable" if the
       position was not already lost (eval_before >= -50cp from the mover's POV)
       AND playing the best move would have been winning (best_move_eval >= +100cp).
    3. If recoverable, flip that game's result (loss/draw -> win) in the sim.
    4. Recompute Elo via expected-score deltas vs each opponent's rating.

Run per cluster (fixing cluster_id X alone) and cumulatively (all clusters).
Cached in {username}_counterfactual.json; recomputed when mistakes change.

Cluster identity rule: matching is centroid-only; results key on cluster_id.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

from ml.config import DATA_DIR
from ml.ingestion.mistake_extractor import MistakeEvent
from ml.matching import load_match_context, assign_nearest

log = logging.getLogger("forked.counterfactual")

router = APIRouter(prefix="/api/profile")

OUTPUT_DIR = DATA_DIR / "output"
_MISTAKE_FIELDS = set(MistakeEvent.__dataclass_fields__.keys())

# Recoverability thresholds (mover's point of view, centipawns)
NOT_LOST_CP   = -50    # position wasn't already lost
WINNING_CP    = 100    # best move would have been winning
DEFAULT_OPP   = 1500   # fallback opponent rating when unknown
MAX_GAIN      = 400    # sanity ceiling on the estimate (no fantasy ratings)


def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _user_elo(username: str) -> int:
    s = _read_json(OUTPUT_DIR / f"{username}_settings.json", {})
    try:
        return int(s.get("elo") or 1500)
    except Exception:
        return 1500


def _expected_score(user_rating: float, opp_rating: float) -> float:
    return 1.0 / (1.0 + 10 ** ((opp_rating - user_rating) / 400.0))


def _infer_platform(username: str) -> str:
    """Prefer the platform implied by stored game URLs over the settings value
    (settings can be stale / wrong). Falls back to settings, then lichess."""
    meta = _read_json(OUTPUT_DIR / f"{username}_game_meta.json", {})
    chesscom = lichess = 0
    for rec in meta.values():
        url = (rec.get("url") or "").lower()
        if "chess.com" in url:
            chesscom += 1
        elif "lichess" in url:
            lichess += 1
    if chesscom or lichess:
        return "chesscom" if chesscom >= lichess else "lichess"
    return _read_json(OUTPUT_DIR / f"{username}_settings.json", {}).get("platform", "lichess")


def _fetch_chesscom_records(username: str) -> dict:
    """
    Robust chess.com fetch via the archives-list endpoint (avoids the shared
    fetcher's brittle current-month 404). Pulls the most recent month archives
    until ~200 games are collected. Returns {game_id: {result, opp_rating, user_color}}.
    """
    import requests
    from ml.config import REQUEST_HEADERS

    records: dict = {}
    try:
        arch = requests.get(
            f"https://api.chess.com/pub/player/{username.lower()}/games/archives",
            headers=REQUEST_HEADERS, timeout=30,
        )
        arch.raise_for_status()
        months = arch.json().get("archives", [])
    except Exception as exc:
        log.warning("Counterfactual: chess.com archives fetch failed: %s", exc)
        return {}

    for url in reversed(months):           # newest month first
        if len(records) >= 200:
            break
        try:
            resp = requests.get(url, headers=REQUEST_HEADERS, timeout=30)
            resp.raise_for_status()
            games = resp.json().get("games", [])
        except Exception:
            continue
        for g in games:
            white = g.get("white", {})
            black = g.get("black", {})
            wu = (white.get("username") or "").lower()
            uc = "white" if wu == username.lower() else "black"
            me  = white if uc == "white" else black
            opp = black if uc == "white" else white
            # chess.com per-player result codes: "win" | "checkmated" | "agreed" |
            #   "repetition" | "stalemate" | "timeout" | "resigned" | "lose" | …
            code = (me.get("result") or "").lower()
            if code == "win":
                result = "1-0" if uc == "white" else "0-1"
            elif code in ("agreed", "repetition", "stalemate", "insufficient",
                          "50move", "timevsinsufficient"):
                result = "1/2-1/2"
            else:                          # any loss code
                result = "0-1" if uc == "white" else "1-0"

            url_field = g.get("url", "")
            rec = {
                "result":     result,
                "opp_rating": opp.get("rating") or DEFAULT_OPP,
                "user_color": uc,
                "url":        url_field,
            }
            # Index by BOTH uuid and URL-segment so the mistakes file's game_id
            # (which uses the chess.com uuid) joins regardless of which form it took.
            uuid_field = g.get("uuid", "")
            seg = url_field.rstrip("/").split("/")[-1] if url_field else ""
            for key in (uuid_field, seg):
                if key:
                    records[key] = rec
    return records


def _fetch_game_records(username: str) -> dict:
    """
    Re-fetch the user's games to get result + opponent rating per game_id, which
    game_meta.json doesn't store. Best-effort: returns {} on network failure.

    NOTE: game_meta stores chess.com game-IDs as the trailing URL segment, while
    the mistakes file may use the chess.com `uuid`. We index records by BOTH so
    the caller's game_id (from mistakes) resolves either way.
    """
    platform = _infer_platform(username)

    if platform == "chesscom":
        return _fetch_chesscom_records(username)

    # Lichess path (the streaming export is reliable)
    try:
        from ml.ingestion.fetcher import fetch_lichess_games, parse_lichess_game
        import chess.pgn, io
        raw = fetch_lichess_games(username, min_games=200)
        parsed = [parse_lichess_game(g, username) for g in raw]
    except Exception as exc:
        log.warning("Counterfactual: lichess fetch failed: %s", exc)
        return {}

    records: dict = {}
    for g in parsed:
        if not g:
            continue
        gid = g.get("game_id", "")
        if not gid:
            continue
        try:
            pgn_game = chess.pgn.read_game(io.StringIO(g["pgn"]))
            result = pgn_game.headers.get("Result", "*") if pgn_game else "*"
        except Exception:
            result = "*"
        uc = g.get("user_color", "white")
        opp_rating = g.get("black_elo") if uc == "white" else g.get("white_elo")
        records[gid] = {
            "result":     result,
            "opp_rating": opp_rating or DEFAULT_OPP,
            "user_color": uc,
        }
    return records


def _user_score(result: str, user_color: str) -> Optional[float]:
    if result == "1/2-1/2":
        return 0.5
    if result == "1-0":
        return 1.0 if user_color == "white" else 0.0
    if result == "0-1":
        return 1.0 if user_color == "black" else 0.0
    return None   # unknown


def _compute(username: str) -> dict:
    cache_path = OUTPUT_DIR / f"{username}_counterfactual.json"

    clusters = _read_json(OUTPUT_DIR / f"{username}_clusters.json", None)
    if not clusters:
        raise HTTPException(404, "No blindspot profile found. Run analysis first.")
    mistakes_raw = _read_json(OUTPUT_DIR / f"{username}_mistakes.json", [])
    if not mistakes_raw:
        raise HTTPException(404, "No mistakes found.")

    # Cache validity: keyed on mistake count + cluster ids
    cluster_ids = [str(c.get("cluster_id")) for c in clusters]
    sig = f"{len(mistakes_raw)}|{','.join(cluster_ids)}"
    cached = _read_json(cache_path, None)
    if cached and cached.get("_sig") == sig:
        return {k: v for k, v in cached.items() if k != "_sig"}

    ctx = load_match_context(username, OUTPUT_DIR)
    if ctx is None:
        raise HTTPException(503, "Cluster model unavailable.")

    events = [MistakeEvent(**{k: v for k, v in d.items() if k in _MISTAKE_FIELDS})
              for d in mistakes_raw]
    assignments = assign_nearest(events, ctx)   # [(cluster_index, sim)]

    import math

    user_rating  = _user_elo(username)
    game_records = _fetch_game_records(username)

    # First matched mistake per game, with its cluster_id, in move order.
    by_game: dict[str, list] = {}
    for ev, (idx, _sim) in zip(events, assignments):
        if idx < 0:
            continue
        cid = str(ctx.clusters[idx].get("cluster_id"))
        by_game.setdefault(ev.game_id, []).append((ev, cid))

    # recoverable[game_id] = cluster_id  (only first recoverable mistake per game)
    recoverable: dict[str, str] = {}
    for gid, evs in by_game.items():
        evs.sort(key=lambda x: x[0].move_number)
        for ev, cid in evs:
            not_lost = (ev.eval_before_cp is not None and ev.eval_before_cp >= NOT_LOST_CP)
            winning  = (ev.eval_before_cp is not None and ev.eval_before_cp >= WINNING_CP)
            if not_lost and winning:
                recoverable[gid] = cid
                break

    # ── Performance-rating model ───────────────────────────────────────────────
    # We need real results to know the user's score rate. Without them, we cannot
    # honestly estimate a rating gain — gate and report has_result_data=false.
    scored_games = {gid: r for gid, r in game_records.items()
                    if _user_score(r.get("result", "*"), r.get("user_color", "white")) is not None}
    has_data = len(scored_games) >= 10

    def _perf_rating(score_rate: float, avg_opp: float) -> float:
        p = max(0.01, min(0.99, score_rate))
        return avg_opp - 400.0 * math.log10((1.0 - p) / p)

    if not has_data:
        # No usable result data — return a gated, number-free response.
        result = {
            "username":         username,
            "actual_rating":    user_rating,
            "total_gain":       0,
            "potential_rating": user_rating,
            "games_recovered":  0,
            "n_games":          len(by_game),
            "has_result_data":  False,
            "per_cluster":      [],
            "ladder":           [],
        }
    else:
        n           = len(scored_games)
        avg_opp     = sum(r["opp_rating"] for r in scored_games.values()) / n
        actual_pts  = sum(_user_score(r["result"], r["user_color"]) for r in scored_games.values())
        p_actual    = actual_pts / n
        r_actual    = _perf_rating(p_actual, avg_opp)

        def _gain_for(target: Optional[set]) -> tuple[int, int]:
            """Performance-rating gain (bounded) from flipping recoverable non-wins to wins."""
            extra = 0.0
            flipped = 0
            for gid, cid in recoverable.items():
                if target is not None and cid not in target:
                    continue
                rec = scored_games.get(gid)
                if not rec:
                    continue
                actual = _user_score(rec["result"], rec["user_color"])
                if actual is None or actual >= 1.0:
                    continue          # already a win — nothing to recover
                extra += (1.0 - actual)
                flipped += 1
            if flipped == 0:
                return 0, 0
            p_corrected = min(0.99, (actual_pts + extra) / n)
            gain = _perf_rating(p_corrected, avg_opp) - r_actual
            return int(round(max(0.0, min(MAX_GAIN, gain)))), flipped

        per_cluster = []
        for c in clusters:
            g, flipped = _gain_for({str(c.get("cluster_id"))})
            per_cluster.append({
                "cluster_id":      c.get("cluster_id"),
                "cluster_rank":    clusters.index(c) + 1,
                "gain":            g,
                "games_recovered": flipped,
            })

        total_gain, total_flipped = _gain_for(None)

        # Cumulative ladder in rank order
        ladder = []
        seen: set = set()
        running = 0
        for c in clusters:
            seen.add(str(c.get("cluster_id")))
            g, _ = _gain_for(seen)
            ladder.append({
                "cluster_id":   c.get("cluster_id"),
                "cluster_rank": clusters.index(c) + 1,
                "step_gain":    g - running,
                "cumulative":   g,
                "rating_after": user_rating + g,
            })
            running = g

        result = {
            "username":         username,
            "actual_rating":    user_rating,
            "total_gain":       total_gain,
            "potential_rating": user_rating + total_gain,
            "games_recovered":  total_flipped,
            "n_games":          n,
            "has_result_data":  True,
            "per_cluster":      per_cluster,
            "ladder":           ladder,
        }
    try:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as fh:
            json.dump({**result, "_sig": sig}, fh, indent=2, default=str)
    except Exception:
        pass
    return result


@router.get("/{username}/counterfactual")
async def counterfactual(username: str):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: _compute(username))
