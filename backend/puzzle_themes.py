"""
Puzzle Themes: Lichess-style themed puzzle training (lichess.org/training/themes),
plus the parts Lichess doesn't do.

Same taxonomy as Lichess (recommended / phases / motifs / advanced / mates /
mate patterns / special moves / goals / lengths / origin / openings), served from
a balanced, quality-filtered sample of the full public puzzle DB
(data/puzzles/themes.db, built by scripts/build_theme_index.py), with the live
Lichess puzzle API as a fallback. On top of that:

  - Forked sub-themes (knight / pawn / queen / royal forks, queen & exchange
    sacrifices, opposition, breakthroughs, material endgames) - ml/puzzles/subthemes.py
  - a Glicko-2 puzzle rating seeded from the player's real rating, AND a rating
    per theme, so "normal" difficulty means normal *for you in that theme*
  - puzzles built from the player's own missed tactics (angle=game)
  - a spaced-repetition queue of failed puzzles (angle=review)
  - an auto "weak spots" mix from blindspot families + lowest theme ratings
  - theme-filtered Rush (3 min) and Streak runs
  - a deterministic "why it works" explanation (ml/puzzles/explain.py)

Endpoints (prefix /api/themes):
  GET  /catalog      categories, counts, example boards, per-theme user stats, focus picks
  GET  /next         one puzzle for an angle (theme | opening | mix | custom | game | review | weak)
  GET  /run          an ascending-difficulty list for Rush / Streak
  POST /attempt      record a result -> rating, theme ratings, review queue, activity
  POST /run-result   save a Rush / Streak score
  GET  /stats        the player's theme dashboard
  POST /explain      "why it works" for a puzzle line
  POST /check-move   engine check of an alternative move (own-game puzzles)

Own-game angles: `game` (everything), `game-blunders` (positions where YOU went
wrong: find the move you should have played), `game-missed` (tactics you missed).
"""
from __future__ import annotations

import bisect
import json
import logging
import math
import random
import re
import sqlite3
import threading
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Literal, Optional

import chess
import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ml.config import DATA_DIR, REQUEST_HEADERS

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/themes", tags=["puzzle-themes"])

DB_PATH = DATA_DIR / "puzzles" / "themes.db"
CATALOG_PATH = DATA_DIR / "puzzle_themes.json"
OUTPUT_DIR = DATA_DIR / "output"
LICHESS = "https://lichess.org"

DIFFICULTY = {"easiest": -600, "easier": -300, "normal": 0, "harder": 300, "hardest": 600}
WINDOWS = (60, 120, 250, 500, 1000, 3000)
SEEN_KEEP = 5000
HISTORY_KEEP = 600
REVIEW_STEPS_DAYS = (1, 3, 7, 21)          # successes needed to graduate = len(...)
GAME_ANGLES = {"game", "game-blunders", "game-missed"}
GENERIC = {"mix", "review", "weak", "custom"} | GAME_ANGLES

# own-game threat_type -> Lichess theme
THREAT_THEME = {
    "fork": "fork", "hanging_piece": "hangingPiece", "pin": "pin", "skewer": "skewer",
    "discovered_attack": "discoveredAttack", "back_rank": "backRankMate",
    "removing_defender": "capturingDefender", "deflection": "deflection",
    "trapped_piece": "trappedPiece", "passed_pawn": "advancedPawn", "king_attack": "exposedKing",
}

_user_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


# ── catalog + db ────────────────────────────────────────────────────────────

_catalog_cache: dict = {"mtime": None, "data": None}


def _catalog() -> dict:
    mtime = CATALOG_PATH.stat().st_mtime
    if _catalog_cache["mtime"] != mtime:
        _catalog_cache["data"] = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        _catalog_cache["mtime"] = mtime
    return _catalog_cache["data"]


def _db() -> Optional[sqlite3.Connection]:
    if not DB_PATH.exists():
        return None
    con = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def _theme_name(key: str) -> str:
    t = _catalog()["themes"].get(key)
    if t:
        return t["name"]
    return key.replace("_", " ")          # opening tags: Sicilian_Defense -> Sicilian Defense


HINT_CATEGORY_ORDER = ("forkedTactics", "forkedEndgames", "matePatterns", "motifs", "advanced",
                       "special", "mates", "goals", "phases", "lengths", "origin", "recommended")


def _hint_for(themes: list[str], angle: str) -> dict:
    """The most specific theme of this puzzle and its nudge (hint ladder step 1):
    sub-types of the trained theme first, then the theme itself, then the most
    specific other motif (sub-types > mate patterns > motifs > ...)."""
    cat = _catalog()
    skip = set(cat.get("hint_skip", []))
    by_id = {c["id"]: c["themes"] for c in cat["categories"]}
    order = [t for cid in HINT_CATEGORY_ORDER for t in by_id.get(cid, [])]
    rank = {k: i for i, k in enumerate(order)}
    children = set(cat["themes"].get(angle, {}).get("sub", []))
    cands = [t for t in themes if t in cat["themes"] and t not in skip]         or [t for t in themes if t in cat["themes"]] or ["mix"]
    cands.sort(key=lambda t: (0 if t in children else 1 if t == angle else 2, rank.get(t, 999)))
    key = cands[0]
    return {"theme": key, "name": _theme_name(key), "text": cat["themes"].get(key, cat["themes"]["mix"])["hint"]}


def _row_to_puzzle(row: sqlite3.Row | dict, source: str, angle: str) -> dict:
    themes = row["themes"].split() if isinstance(row["themes"], str) else list(row["themes"])
    return {
        "id": row["id"], "fen": row["fen"], "moves": row["moves"], "rating": int(row["rating"]),
        "rd": int(row["rd"] or 80) if "rd" in row.keys() else 80,
        "plays": int(row["plays"] or 0) if "plays" in row.keys() else 0,
        "popularity": int(row["popularity"] or 0) if "popularity" in row.keys() else 0,
        "themes": themes, "game_url": row["game_url"] if "game_url" in row.keys() else None,
        "opening": (row["opening"] or "") if "opening" in row.keys() else "",
        "color": row["color"] if "color" in row.keys() else _solver(row["fen"]),
        "source": source, "angle": angle, "rated": True,
        "hint": _hint_for(themes, angle),
    }


def _solver(fen: str) -> str:
    return "b" if fen.split()[1] == "w" else "w"


# ── per-user state ──────────────────────────────────────────────────────────

def _safe_user(username: str) -> str:
    u = (username or "").strip() or "Guest"
    if not re.fullmatch(r"[A-Za-z0-9_\-]{1,40}", u):
        raise HTTPException(400, "invalid username")
    return u


def _lock(username: str) -> threading.Lock:
    with _locks_guard:
        return _user_locks.setdefault(username, threading.Lock())


def _state_path(username: str) -> Path:
    return OUTPUT_DIR / f"{username}_puzzle_themes.json"


def _new_state(elo: Optional[int]) -> dict:
    seeded = bool(elo and 400 <= elo <= 3200)
    return {
        "rating": float(min(max(elo, 600), 2500)) if seeded else 1500.0,
        "rd": 200.0 if seeded else 300.0, "vol": 0.06,
        "themes": {}, "history": [], "seen": [], "review": {}, "runs": {"rush": {}, "streak": {}},
        "days": {}, "created": time.time(), "seeded_from": elo if seeded else None,
    }


def _load_state(username: str, elo: Optional[int] = None) -> dict:
    p = _state_path(username)
    if p.exists():
        try:
            st = json.loads(p.read_text(encoding="utf-8"))
            for k, v in _new_state(None).items():
                st.setdefault(k, v)
            return st
        except Exception:
            log.warning("corrupt puzzle-theme state for %s, starting fresh", username)
    st = _new_state(elo)
    if st["seeded_from"] and username != "Guest":
        with _lock(username):          # persist the seed so every later call agrees on it
            if not p.exists():
                _save_state(username, st)
    return st


def _save_state(username: str, st: dict) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    st["seen"] = st["seen"][-SEEN_KEEP:]
    st["history"] = st["history"][-HISTORY_KEEP:]
    tmp = _state_path(username).with_suffix(".tmp")
    tmp.write_text(json.dumps(st, separators=(",", ":")), encoding="utf-8")
    tmp.replace(_state_path(username))


# ── Glicko-2 (Glickman 2012), one game per period like Lichess puzzles ──────

_S = 173.7178


def glicko2(r: float, rd: float, vol: float, opp_r: float, opp_rd: float, score: float,
            tau: float = 0.75) -> tuple[float, float, float]:
    mu, phi = (r - 1500) / _S, rd / _S
    mu_j, phi_j = (opp_r - 1500) / _S, max(opp_rd, 40) / _S
    g = 1 / math.sqrt(1 + 3 * phi_j ** 2 / math.pi ** 2)
    e = 1 / (1 + math.exp(-g * (mu - mu_j)))
    v = 1 / (g ** 2 * e * (1 - e))
    delta = v * g * (score - e)
    a = math.log(vol ** 2)

    def f(x: float) -> float:
        ex = math.exp(x)
        return ex * (delta ** 2 - phi ** 2 - v - ex) / (2 * (phi ** 2 + v + ex) ** 2) - (x - a) / tau ** 2

    A = a
    if delta ** 2 > phi ** 2 + v:
        B = math.log(delta ** 2 - phi ** 2 - v)
    else:
        k = 1
        while f(a - k * tau) < 0:
            k += 1
        B = a - k * tau
    fA, fB = f(A), f(B)
    for _ in range(100):
        if abs(B - A) <= 1e-6:
            break
        C = A + (A - B) * fA / (fB - fA)
        fC = f(C)
        if fC * fB <= 0:
            A, fA = B, fB
        else:
            fA /= 2
        B, fB = C, fC
    new_vol = math.exp(A / 2)
    phi_star = math.sqrt(phi ** 2 + new_vol ** 2)
    phi_new = 1 / math.sqrt(1 / phi_star ** 2 + 1 / v)
    mu_new = mu + phi_new ** 2 * g * (score - e)
    return 1500 + _S * mu_new, min(max(_S * phi_new, 60.0), 350.0), new_vol


def _theme_entry(st: dict, theme: str) -> dict:
    return st["themes"].setdefault(theme, {
        "r": st["rating"], "rd": 250.0, "vol": 0.06, "n": 0, "w": 0, "h": 0, "ms": 0, "last": 0,
    })


def _target(st: dict, angle: str, difficulty: str) -> int:
    base = st["rating"]
    t = st["themes"].get(angle)
    if t and t["n"] >= 4:
        base = t["r"]
    return int(base + DIFFICULTY.get(difficulty, 0))


# ── candidate selection ─────────────────────────────────────────────────────

def _candidates(con: sqlite3.Connection, themes: list[str], match: str, lo: int, hi: int,
                color: Optional[str]) -> list[tuple[str, int]]:
    params: list = []
    col = " AND color = ?" if color in ("w", "b") else ""
    if len(themes) == 1:
        sql = f"SELECT id, rating FROM puzzle_theme WHERE theme = ? AND rating BETWEEN ? AND ?{col}"
        params = [themes[0], lo, hi] + ([color] if col else [])
    else:
        qs = ",".join("?" * len(themes))
        having = f" HAVING COUNT(*) = {len(themes)}" if match == "all" else ""
        sql = (f"SELECT id, MIN(rating) FROM puzzle_theme WHERE theme IN ({qs}) AND rating BETWEEN ? AND ?{col}"
               f" GROUP BY id{having}")
        params = list(themes) + [lo, hi] + ([color] if col else [])
    return [(r[0], r[1]) for r in con.execute(sql, params).fetchall()]


def _pick_local(themes: list[str], match: str, target: int, color: Optional[str],
                seen: set[str]) -> Optional[sqlite3.Row]:
    con = _db()
    if con is None:
        return None
    try:
        for w in WINDOWS:
            cands = [c for c in _candidates(con, themes, match, target - w, target + w, color) if c[0] not in seen]
            if cands:
                pid = random.choice(cands)[0]
                return con.execute("SELECT * FROM puzzles WHERE id = ?", (pid,)).fetchone()
        return None
    finally:
        con.close()


# ── Lichess API (fallback + daily) ──────────────────────────────────────────

def _lichess_angle(theme: str) -> str:
    """Forked-only sub-themes have no Lichess angle; ask for the parent."""
    t = _catalog()["themes"].get(theme, {})
    return t.get("parent", theme) if t.get("forked") else theme


def _from_lichess(obj: dict, source: str, angle: str) -> Optional[dict]:
    try:
        game, pz = obj["game"], obj["puzzle"]
        board = chess.Board()
        sans = game["pgn"].split()
        for san in sans[:-1]:
            board.push_san(san)
        fen = board.fen()
        trigger = board.parse_san(sans[-1]).uci()
        row = {
            "id": pz["id"], "fen": fen, "moves": " ".join([trigger] + pz["solution"]),
            "rating": pz["rating"], "rd": 80, "plays": pz.get("plays", 0), "popularity": 0,
            "themes": " ".join(pz.get("themes", [])), "game_url": f"{LICHESS}/training/{pz['id']}",
            "opening": "", "color": _solver(fen),
        }
        from ml.puzzles.subthemes import detect
        subs = detect(row["fen"], row["moves"], set(row["themes"].split()))
        row["themes"] = " ".join(sorted(set(row["themes"].split()) | subs))
        return _row_to_puzzle(row, source, angle)
    except Exception as exc:
        log.warning("could not convert Lichess puzzle: %s", exc)
        return None


def _lichess_batch(angle: str, target: int, color: Optional[str], seen: set[str]) -> Optional[dict]:
    """Closest-rated unseen puzzle from a Lichess batch (anonymous: difficulty is
    relative to 1500, so pick the nearest band and then the nearest rating)."""
    rel = target - 1500
    diff = min(DIFFICULTY, key=lambda k: abs(DIFFICULTY[k] - rel))
    lich_angle = _lichess_angle(angle)
    try:
        r = requests.get(f"{LICHESS}/api/puzzle/batch/{lich_angle}", params={"nb": 15, "difficulty": diff},
                         headers=REQUEST_HEADERS, timeout=12)
        r.raise_for_status()
        items = r.json().get("puzzles", [])
    except Exception as exc:
        log.warning("Lichess puzzle batch failed for %s: %s", lich_angle, exc)
        return None
    puzzles = [p for p in (_from_lichess(o, "lichess", angle) for o in items) if p]
    puzzles = [p for p in puzzles if p["id"] not in seen and (not color or p["color"] == color)]
    if angle != lich_angle:
        puzzles = [p for p in puzzles if angle in p["themes"]]
    if not puzzles:
        return None
    return min(puzzles, key=lambda p: abs(p["rating"] - target))




# ── puzzles from the player's own games ─────────────────────────────────────

_game_cache: dict[str, tuple[tuple, list[dict]]] = {}


def _cut_line(board: chess.Board, line: list[str], mate: Optional[int]) -> list[str]:
    """Trim an engine PV to a puzzle solution that ends on the solver's move once
    the gain is banked (mate, or >= 2 points still up after the reply)."""
    from ml.classifier.verifier import _material_diff
    pov = board.turn
    if mate and 0 < mate <= 4 and len(line) >= 2 * mate - 1:
        return line[: 2 * mate - 1]
    start = _material_diff(board, pov)
    b = board.copy(stack=False)
    for k, uci in enumerate(line[:7]):
        try:
            mv = chess.Move.from_uci(uci)
        except ValueError:
            break
        if mv not in b.legal_moves:
            break
        b.push(mv)
        if b.is_checkmate():
            return line[: k + 1]
        if k % 2 == 1 and _material_diff(b, pov) - start >= 2:
            return line[:k]
    return line[:1]


def _length_theme(n_solver: int) -> str:
    return {1: "oneMove", 2: "short", 3: "long"}.get(n_solver, "veryLong")


def _game_puzzles(username: str) -> list[dict]:
    """The player's own real-game mistakes as Lichess-format puzzles, newest first.

    game.kind:
      "blunder"     your mistake/blunder that ALLOWED something (or was a quiet slip):
                    the puzzle is the position you faced, the solution Stockfish's move
      "mistake"     a tactic you missed (missed / both)
      "opportunity" a winning tactic you didn't play (no big eval drop, still a miss)
    Any move Stockfish rates within ~5% expected score of best is accepted (/check-move).
    """
    mpath = OUTPUT_DIR / f"{username}_mistakes.json"
    opath = OUTPUT_DIR / f"{username}_opportunities.json"
    key = tuple(p.stat().st_mtime if p.exists() else 0 for p in (mpath, opath))
    hit = _game_cache.get(username)
    if hit and hit[0] == key:
        return hit[1]

    from ml.classifier.verifier import verify
    from ml.puzzles.subthemes import detect

    records: list[tuple[dict, str]] = []
    for path, kind in ((mpath, "mistake"), (opath, "opportunity")):
        if not path.exists():
            continue
        try:
            for r in json.loads(path.read_text(encoding="utf-8")):
                records.append((r, kind))
        except Exception:
            continue

    base_rating = _load_state(username)["rating"]
    out: dict[str, dict] = {}
    for r, kind in records:
        if r.get("side") != "user" or not r.get("best_line") or not r.get("prev_fen") or not r.get("prev_move_uci"):
            continue
        if kind == "opportunity" and r.get("found"):
            continue
        sub = kind
        if kind == "mistake":
            if (r.get("es_loss") or 0) < 0.10 or r.get("cascade"):
                continue
            if r.get("direction") not in ("missed", "both"):
                # your own slip: only real mistakes / blunders, not inaccuracies
                if r.get("judgement") not in ("mistake", "blunder"):
                    continue
                sub = "blunder"
        try:
            prev = chess.Board(r["prev_fen"])
            trig = chess.Move.from_uci(r["prev_move_uci"])
            if trig not in prev.legal_moves:
                continue
            board = prev.copy(stack=False)
            board.push(trig)
        except ValueError:
            continue
        if board.board_fen() in out:
            continue
        line = _cut_line(board, r["best_line"], r.get("mate") or r.get("mate_missed"))
        if not line:
            continue
        themes: set[str] = set(verify(board, line, r["prev_move_uci"], prev))
        for m, p in (r.get("motif_probs") or {}).items():
            if p >= 0.35 and m in _catalog()["themes"]:
                themes.add(m)
        tt = r.get("threat_missed") or r.get("threat_type")
        if tt in THREAT_THEME:
            themes.add(THREAT_THEME[tt])
        b2 = board.copy(stack=False)
        for u in line:
            b2.push_uci(u)
        n_solver = (len(line) + 1) // 2
        if b2.is_checkmate():
            themes |= {"mate", f"mateIn{min(n_solver, 5)}"}
        phase = r.get("game_phase")
        if phase in ("opening", "middlegame", "endgame"):
            themes.add(phase)
        themes.add(_length_theme(n_solver))
        moves = " ".join([r["prev_move_uci"]] + line)
        themes |= detect(r["prev_fen"], moves, themes)
        p_best = r.get("maia2_prob_best")
        anchor = r.get("user_elo") or base_rating
        if isinstance(p_best, (int, float)) and 0 < p_best < 1:
            p = min(max(p_best, 0.05), 0.95)
            rating = anchor + 400 * math.log10((1 - p) / p)
        else:
            rating = anchor + 150
        pid = "g:" + str(r.get("event_id") or r.get("incident_id") or abs(hash(board.fen())) % 10 ** 10)
        out[board.board_fen()] = {
            "id": pid, "fen": r["prev_fen"], "moves": moves, "rating": int(round(rating)), "rd": 150,
            "plays": 0, "popularity": 0, "themes": sorted(themes), "game_url": None, "opening": "",
            "color": "w" if board.turn == chess.WHITE else "b", "source": "game", "rated": False,
            "game": {
                "game_id": r.get("game_id"), "move_number": board.fullmove_number,
                "played_at": r.get("played_at_unix"), "played_san": r.get("move_played_san"),
                "judgement": r.get("judgement") or ("missed win" if kind == "opportunity" else None),
                "es_loss": r.get("es_loss"), "kind": sub,
                "best_san": _san(board, line[0]),
            },
        }
    puzzles = sorted(out.values(), key=lambda p: -(p["game"]["played_at"] or 0))
    _game_cache[username] = (key, puzzles)
    return puzzles


def _san(board: chess.Board, uci: str) -> Optional[str]:
    try:
        return board.san(chess.Move.from_uci(uci))
    except Exception:
        return None


def _game_pool(username: str, angle: str) -> list[dict]:
    pool = _game_puzzles(username)
    if angle == "game-blunders":
        return [p for p in pool if p["game"]["kind"] == "blunder"]
    if angle == "game-missed":
        return [p for p in pool if p["game"]["kind"] != "blunder"]
    return pool


def _with_hint(p: dict, angle: str) -> dict:
    p = dict(p)
    p["angle"] = angle
    p["hint"] = _hint_for(p["themes"], angle)
    return p


# ── picking for an angle ────────────────────────────────────────────────────

MOTIF_CATEGORIES = ("motifs", "advanced", "matePatterns", "forkedTactics", "forkedEndgames", "special")


def _weak_themes(st: dict, username: str) -> list[tuple[str, str]]:
    """(theme, reason) pairs, strongest evidence first: confirmed / emerging
    blindspot families, motifs you missed most in your own games, themes rated
    well below your overall puzzle rating, then your top-scoring families."""
    cat = _catalog()
    out: list[tuple[str, str]] = []
    later: list[tuple[str, str]] = []
    cpath = OUTPUT_DIR / f"{username}_clusters.json"
    if cpath.exists():
        try:
            from ml.clustering.families import family_info
            clusters = json.loads(cpath.read_text(encoding="utf-8"))
            ranked = sorted(clusters, key=lambda c: c.get("score") or 0, reverse=True)
            for i, c in enumerate(ranked):
                status = (c.get("profile") or {}).get("status")
                fam = str(c.get("cluster_id"))
                if fam not in cat["family_focus"]:
                    continue
                name = family_info(fam)["name"]
                if status in ("confirmed", "emerging"):
                    out += [(t, f"{status.title()} blindspot · {name}") for t in cat["family_focus"][fam][:3]]
                elif i < 2 and (c.get("score") or 0) > 0:
                    later += [(t, f"Your #{i + 1} mistake family · {name}") for t in cat["family_focus"][fam][:2]]
        except Exception:
            pass
    if username != "Guest":
        motif_keys = {t for c in cat["categories"] if c["id"] in MOTIF_CATEGORIES for t in c["themes"]}
        missed: dict[str, int] = {}
        for p in _game_pool(username, "game-missed"):
            for t in p["themes"]:
                if t in motif_keys:
                    missed[t] = missed.get(t, 0) + 1
        for t, n in sorted(missed.items(), key=lambda kv: -kv[1])[:3]:
            if n >= 3:
                out.append((t, f"Missed {n}× in your own games"))
    rated = [(k, v) for k, v in st["themes"].items() if v["n"] >= 5 and k in cat["themes"] and k not in GENERIC]
    for k, v in sorted(rated, key=lambda kv: kv[1]["r"])[:4]:
        if v["r"] < st["rating"] - 40:
            out.append((k, f"{int(st['rating'] - v['r'])} below your overall rating"))
    out += later
    seen, uniq = set(), []
    for t, why in out:
        if t not in seen:
            seen.add(t)
            uniq.append((t, why))
    return uniq


def _next_puzzle(username: str, angle: str, difficulty: str, color: Optional[str], exclude: set[str],
                 themes: list[str], match: str, elo: Optional[int]) -> dict:
    st = _load_state(username, elo)
    seen = set(st["seen"]) | exclude

    if angle == "review":
        now = time.time()
        due = sorted((v for k, v in st["review"].items() if v["due"] <= now and k not in exclude),
                     key=lambda v: v["due"])
        if not due:
            raise HTTPException(404, "Nothing to review right now.")
        p = _with_hint(due[0]["puzzle"], "review")
        p["source"], p["rated"] = "review", False
        p["review"] = {"streak": due[0]["streak"], "fails": due[0]["fails"]}
        return p

    if angle in GAME_ANGLES:
        pool = [p for p in _game_pool(username, angle) if p["id"] not in exclude]
        if themes:
            want = set(themes)
            pool = [p for p in pool if (want <= set(p["themes"]) if match == "all" else want & set(p["themes"]))]
        if color in ("w", "b"):
            pool = [p for p in pool if p["color"] == color]
        if not pool:
            raise HTTPException(404, "No puzzles from your games for this filter yet.")
        fresh = [p for p in pool if p["id"] not in seen] or pool
        return _with_hint(random.choice(fresh[:40]), angle)

    focus_reason = None
    if angle == "weak":
        weak = _weak_themes(st, username)
        if not weak:
            weak = [("mix", "Play more rated puzzles to find your weak spots")]
        theme, focus_reason = random.choice(weak[:6])
        themes = [theme]
    elif angle == "custom":
        if not themes:
            raise HTTPException(400, "custom needs themes")
    else:
        themes = [angle]

    target = _target(st, themes[0] if len(themes) == 1 else "mix", difficulty)
    row = _pick_local(themes, match, target, color, seen)
    if row is not None:
        p = _row_to_puzzle(row, "local", angle if angle != "weak" else themes[0])
    else:
        p = _lichess_batch(themes[0], target, color, seen) if len(themes) == 1 else None
        if p is None:
            raise HTTPException(404, "No puzzle found for this filter. Try another difficulty or colour.")
    if angle == "weak":
        p["focus"] = {"theme": themes[0], "name": _theme_name(themes[0]), "reason": focus_reason}
        p["angle"] = "weak"
    p["target"] = target
    return p


# ── endpoints ───────────────────────────────────────────────────────────────

def _post_trigger_fen(fen: str, moves: str) -> str:
    b = chess.Board(fen)
    try:
        b.push_uci(moves.split()[0])
    except Exception:
        pass
    return b.fen()


_base_cache: dict = {"key": None, "data": None}


def _catalog_base() -> dict:
    """Catalog + counts + example boards (user-independent, cached)."""
    cat = _catalog()
    key = (DB_PATH.stat().st_mtime if DB_PATH.exists() else 0, _catalog_cache["mtime"])
    if _base_cache["key"] == key:
        return _base_cache["data"]
    counts: dict[str, dict] = {}
    openings: list[dict] = []
    meta: dict = {}
    con = _db()
    if con is not None:
        try:
            examples = {}
            for r in con.execute("SELECT t.theme, t.lichess, t.local, p.fen, p.moves, p.color FROM theme_count t "
                                 "LEFT JOIN puzzles p ON p.id = t.example_id"):
                counts[r["theme"]] = {"lichess": r["lichess"], "local": r["local"]}
                if r["fen"]:
                    examples[r["theme"]] = {"fen": _post_trigger_fen(r["fen"], r["moves"]), "color": r["color"]}
            for k, v in examples.items():
                counts[k]["example"] = v
            fams: dict[str, dict] = {}
            for r in con.execute("SELECT key, family, lichess, local FROM opening ORDER BY lichess DESC"):
                if r["key"] == r["family"]:
                    fams.setdefault(r["key"], {"variations": []}).update(
                        {"key": r["key"], "name": _theme_name(r["key"]), "count": r["lichess"], "local": r["local"]})
            for r in con.execute("SELECT key, family, lichess, local FROM opening WHERE key != family ORDER BY lichess DESC"):
                fam = fams.get(r["family"])
                if fam is not None:
                    fam["variations"].append({"key": r["key"], "count": r["lichess"], "local": r["local"],
                                              "name": _theme_name(r["key"]).replace(_theme_name(r["family"]), "").strip(" :") or _theme_name(r["key"])})
            openings = [f for f in fams.values() if "key" in f]
            meta = {r["key"]: json.loads(r["value"]) for r in con.execute("SELECT key, value FROM meta")}
        finally:
            con.close()

    categories = []
    for c in cat["categories"]:
        items = []
        for key in c["themes"]:
            t = cat["themes"].get(key)
            if not t:
                continue
            cnt = counts.get(key, {})
            items.append({
                "key": key, "name": t["name"], "desc": t["desc"], "spot": t.get("spot", []),
                "parent": t.get("parent"), "sub": t.get("sub", []), "forked": bool(t.get("forked")),
                "count": cnt.get("lichess", 0), "local": cnt.get("local", 0), "example": cnt.get("example"),
            })
        categories.append({"id": c["id"], "title": c["title"], "blurb": c["blurb"], "forked": bool(c.get("forked")),
                           "themes": items})
    data = {
        "categories": categories, "openings": openings,
        "source": {"db": bool(meta), "puzzles": meta.get("kept", 0), "lichess_total": meta.get("source_puzzles", 0),
                   "built_at": meta.get("built_at")},
    }
    _base_cache.update(key=key, data=data)
    return data


def _today() -> str:
    return date.today().isoformat()


def _streak_days(days: dict) -> int:
    n, d = 0, date.today()
    if not days.get(d.isoformat()):
        d -= timedelta(days=1)          # today not played yet: streak still alive from yesterday
    while days.get(d.isoformat()):
        n += 1
        d -= timedelta(days=1)
    return n


def _user_summary(username: str, st: dict) -> dict:
    now = time.time()
    total = sum(v[0] for v in st["days"].values())
    wins = sum(v[1] for v in st["days"].values())
    games = _game_puzzles(username) if username != "Guest" else []
    game_counts: dict[str, int] = {}
    for p in games:
        if p["game"]["kind"] == "blunder":
            continue                    # "×n in your games" = tactics you missed
        for t in p["themes"]:
            game_counts[t] = game_counts.get(t, 0) + 1
    blunders = [p for p in games if p["game"]["kind"] == "blunder"]
    sample = blunders[0] if blunders else (games[0] if games else None)
    return {
        "rating": round(st["rating"]), "rd": round(st["rd"]), "provisional": st["rd"] > 110,
        "total": total, "solved": wins, "today": dict(zip(("n", "w"), st["days"].get(_today(), [0, 0]))),
        "streak_days": _streak_days(st["days"]),
        "review_due": sum(1 for v in st["review"].values() if v["due"] <= now),
        "review_total": len(st["review"]),
        "game_puzzles": len(games), "game_by_theme": game_counts,
        "game_split": {"blunders": len(blunders), "missed": len(games) - len(blunders)},
        "game_sample": ({"fen": sample["fen"], "moves": sample["moves"].split()[0], "color": sample["color"],
                         "played_san": sample["game"]["played_san"], "move_number": sample["game"]["move_number"],
                         "kind": sample["game"]["kind"]} if sample else None),
        "focus": [{"theme": t, "name": _theme_name(t), "reason": why} for t, why in _weak_themes(st, username)[:6]],
        "themes": {k: {"rating": round(v["r"]), "n": v["n"], "w": v["w"],
                       "acc": round(v["w"] / v["n"], 3) if v["n"] else None}
                   for k, v in st["themes"].items()},
        "runs": st["runs"], "seeded_from": st.get("seeded_from"),
    }


@router.get("/catalog")
def catalog(username: str = "", elo: Optional[int] = None):
    data = dict(_catalog_base())
    u = _safe_user(username)
    st = _load_state(u, elo)
    data["user"] = _user_summary(u, st)
    return data


@router.get("/next")
def next_puzzle(username: str = "", angle: str = "mix", difficulty: str = "normal",
                color: Optional[str] = None, exclude: str = "", themes: str = "",
                match: Literal["any", "all"] = "all", elo: Optional[int] = None):
    u = _safe_user(username)
    ex = {x for x in exclude.split(",") if x}
    tl = [t for t in themes.split(",") if t]
    col = color if color in ("w", "b") else None
    return _next_puzzle(u, angle, difficulty, col, ex, tl, match, elo)


def _nearest_unused(cands: list[tuple[str, int]], ratings: list[int], used: set[str], target: int) -> Optional[str]:
    """Closest-rated candidate not used yet (`cands` sorted by rating)."""
    j = bisect.bisect_left(ratings, target)
    for d in range(len(cands)):
        for idx in (j + d, j - d - 1):
            if 0 <= idx < len(cands) and cands[idx][0] not in used:
                return cands[idx][0]
    return None


@router.get("/run")
def run(username: str = "", angle: str = "mix", mode: Literal["rush", "streak"] = "rush",
        color: Optional[str] = None, themes: str = "", match: Literal["any", "all"] = "all",
        elo: Optional[int] = None):
    """An ascending-difficulty list: Rush starts ~500 below your theme rating and
    climbs past it; Streak starts a little lower and climbs further."""
    u = _safe_user(username)
    st = _load_state(u, elo)
    tl = [t for t in themes.split(",") if t] if angle == "custom" else [angle]
    if angle in GAME_ANGLES:
        pool = sorted(_game_pool(u, angle), key=lambda p: p["rating"])
        return {"puzzles": [_with_hint(p, angle) for p in pool[:60]], "start": None}
    col = color if color in ("w", "b") else None
    base = _target(st, tl[0] if len(tl) == 1 else "mix", "normal")
    n, start, step = (60, base - 550, 22) if mode == "rush" else (45, base - 450, 28)
    con = _db()
    if con is None:
        raise HTTPException(503, "Puzzle index not built. Run: python scripts/build_theme_index.py")
    try:
        cands = _candidates(con, tl, match, start - 200, start + n * step + 400, col)
        seen = set(st["seen"][-1500:])
        fresh = [c for c in cands if c[0] not in seen] or cands
        random.shuffle(fresh)
        fresh.sort(key=lambda c: c[1])
        used: set[str] = set()
        picked: list[str] = []
        ratings = [c[1] for c in fresh]
        for i in range(n):
            pid = _nearest_unused(fresh, ratings, used, start + i * step)
            if pid is None:
                break
            used.add(pid)
            picked.append(pid)
        rows = {r["id"]: r for r in con.execute(
            f"SELECT * FROM puzzles WHERE id IN ({','.join('?' * len(picked))})", picked)} if picked else {}
    finally:
        con.close()
    puzzles = [_row_to_puzzle(rows[i], "local", angle) for i in picked if i in rows]
    puzzles.sort(key=lambda p: p["rating"])
    return {"puzzles": puzzles, "start": start}


class AttemptIn(BaseModel):
    username: str = ""
    puzzle: dict
    angle: str = "mix"
    result: Literal["win", "hint", "loss"]
    time_ms: int = 0
    mode: Literal["practice", "rush", "streak"] = "practice"
    elo: Optional[int] = None


@router.post("/attempt")
def attempt(body: AttemptIn):
    u = _safe_user(body.username)
    p = body.puzzle
    pid = str(p.get("id", ""))
    if not pid:
        raise HTTPException(400, "puzzle.id required")
    score = {"win": 1.0, "hint": 0.5, "loss": 0.0}[body.result]
    with _lock(u):
        st = _load_state(u, body.elo)
        before = st["rating"]
        rated = (body.mode == "practice" and p.get("rated", True) and p.get("source") not in ("review", "game")
                 and pid not in st["seen"])
        theme_changes = []
        for t in p.get("themes", []):
            _theme_entry(st, t)            # new themes start from the rating before this puzzle
        if rated:
            pr, prd = float(p.get("rating", 1500)), float(p.get("rd", 80))
            st["rating"], st["rd"], st["vol"] = glicko2(st["rating"], st["rd"], st["vol"], pr, prd, score)
            for t in p.get("themes", []):
                e = _theme_entry(st, t)
                tb = e["r"]
                e["r"], e["rd"], e["vol"] = glicko2(e["r"], e["rd"], e["vol"], pr, prd, score)
                theme_changes.append({"theme": t, "before": round(tb), "after": round(e["r"])})
        for t in p.get("themes", []):
            e = _theme_entry(st, t)
            e["n"] += 1
            e["w"] += 1 if body.result == "win" else 0
            e["h"] += 1 if body.result == "hint" else 0
            e["ms"] += max(0, min(body.time_ms, 600_000))
            e["last"] = time.time()
        if pid not in st["seen"]:
            st["seen"].append(pid)
        day = st["days"].setdefault(_today(), [0, 0])
        day[0] += 1
        day[1] += 1 if body.result == "win" else 0
        st["history"].append({"id": pid, "angle": body.angle, "res": body.result, "mode": body.mode,
                              "pr": p.get("rating"), "r": round(st["rating"]), "ts": int(time.time()),
                              "ms": body.time_ms, "th": p.get("themes", [])[:8]})

        # spaced repetition of misses
        review = None
        entry = st["review"].get(pid)
        if body.result != "win":
            stored = {k: p.get(k) for k in ("id", "fen", "moves", "rating", "rd", "themes", "game_url",
                                            "opening", "color", "source", "plays", "popularity", "game")}
            st["review"][pid] = {"puzzle": stored, "due": time.time() + 86400 * REVIEW_STEPS_DAYS[0] / 4,
                                 "streak": 0, "fails": (entry or {}).get("fails", 0) + 1, "angle": body.angle}
            review = {"queued": True, "due_in_hours": 6}
        elif entry:
            entry["streak"] += 1
            if entry["streak"] >= len(REVIEW_STEPS_DAYS):
                del st["review"][pid]
                review = {"graduated": True}
            else:
                days = REVIEW_STEPS_DAYS[entry["streak"]]
                entry["due"] = time.time() + 86400 * days
                review = {"queued": True, "due_in_hours": days * 24}
        _save_state(u, st)
    return {
        "rated": rated, "rating": {"before": round(before), "after": round(st["rating"]),
                                   "delta": round(st["rating"] - before), "rd": round(st["rd"])},
        "themes": theme_changes, "review": review,
        "today": dict(zip(("n", "w"), st["days"][_today()])), "streak_days": _streak_days(st["days"]),
    }


class RunResultIn(BaseModel):
    username: str = ""
    angle: str = "mix"
    mode: Literal["rush", "streak"]
    score: int
    mistakes: int = 0
    duration_ms: int = 0


@router.post("/run-result")
def run_result(body: RunResultIn):
    u = _safe_user(body.username)
    with _lock(u):
        st = _load_state(u)
        runs = st["runs"].setdefault(body.mode, {})
        prev = runs.get(body.angle, {}).get("best", 0)
        record = body.score > prev
        if record:
            runs[body.angle] = {"best": body.score, "ts": int(time.time())}
        hist = st.setdefault("run_history", [])
        hist.append({"mode": body.mode, "angle": body.angle, "score": body.score, "ts": int(time.time())})
        st["run_history"] = hist[-200:]
        _save_state(u, st)
    return {"best": max(prev, body.score), "previous": prev, "record": record}


@router.get("/stats")
def stats(username: str = ""):
    u = _safe_user(username)
    st = _load_state(u)
    cat = _catalog()
    rows = []
    for k, v in st["themes"].items():
        if k in GENERIC or v["n"] == 0:
            continue
        rows.append({"theme": k, "name": _theme_name(k), "rating": round(v["r"]), "n": v["n"], "w": v["w"],
                     "acc": round(v["w"] / v["n"], 3), "avg_s": round(v["ms"] / v["n"] / 1000, 1),
                     "vs_overall": round(v["r"] - st["rating"]), "forked": bool(cat["themes"].get(k, {}).get("forked"))})
    solid = [r for r in rows if r["n"] >= 5]
    history = [[h["ts"], h["r"]] for h in st["history"] if h.get("mode") == "practice"][-200:]
    days = [{"day": (date.today() - timedelta(days=i)).isoformat(),
             "n": st["days"].get((date.today() - timedelta(days=i)).isoformat(), [0, 0])[0]} for i in range(83, -1, -1)]
    return {
        **_user_summary(u, st),
        "rows": sorted(rows, key=lambda r: -r["n"]),
        "strengths": sorted(solid, key=lambda r: -r["vs_overall"])[:4],
        "weaknesses": sorted(solid, key=lambda r: r["vs_overall"])[:4],
        "history": history, "days": days,
        "recent": st["history"][-30:][::-1],
    }


class ExplainIn(BaseModel):
    fen: str
    moves: str


@router.post("/explain")
def explain_line(body: ExplainIn):
    from ml.puzzles.explain import explain
    try:
        return explain(body.fen, body.moves)
    except Exception as exc:
        raise HTTPException(400, f"could not explain: {exc}")


class CheckMoveIn(BaseModel):
    fen: str          # position with the solver to move
    uci: str          # the move the player tried
    best: str         # the stored solution move


@router.post("/check-move")
def check_move(body: CheckMoveIn):
    """Own-game puzzles come from engine lines, which aren't unique like Lichess
    puzzles: accept any move the engine rates within ~5% expected score of best."""
    import chess.engine
    from backend.main import _sf_lock, _ensure_engine
    from ml.ingestion.winprob import expected_score
    board = chess.Board(body.fen)
    try:
        mv, best = chess.Move.from_uci(body.uci), chess.Move.from_uci(body.best)
    except ValueError:
        raise HTTPException(400, "bad move")
    if mv not in board.legal_moves:
        return {"ok": False, "reason": "illegal"}
    board.push(mv)
    if board.is_checkmate():
        return {"ok": True, "loss": 0.0}
    board.pop()

    def score_after(m: chess.Move) -> float:
        b = board.copy(stack=False)
        b.push(m)
        with _sf_lock:
            info = _ensure_engine().analyse(b, chess.engine.Limit(depth=14))
        cp = info["score"].pov(board.turn).score(mate_score=10000)
        return expected_score(cp)

    try:
        es_best, es_mine = score_after(best), score_after(mv)
    except Exception as exc:
        log.warning("check-move engine failure: %s", exc)
        return {"ok": False, "reason": "engine unavailable"}
    loss = max(0.0, es_best - es_mine)
    return {"ok": loss <= 0.05 and es_mine >= 0.6, "loss": round(loss, 3)}
