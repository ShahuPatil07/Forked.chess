"""
Accounts, ratings, the game library, drill stats and alert matching — the
platform pieces added around the core pipeline. All file IO goes to tmp_path;
nothing here touches the network (chess-account checks are stubbed).

    .venv/Scripts/python -m pytest tests/test_platform.py -q -p no:cacheprovider
"""
from __future__ import annotations

import datetime as dt
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent


# ── ratings ─────────────────────────────────────────────────────────────────

def test_rating_scale_matches_frontend_copy():
    from backend.ratings import RAPID_SCALE
    ts = (ROOT / "frontend/src/lib/ratings.ts").read_text(encoding="utf-8")
    block = ts[ts.index("export const RAPID_SCALE"):]
    block = block[: block.index("]\n") + 1]
    pairs = [(int(a), int(b)) for a, b in re.findall(r"\[(\d+),\s*(\d+)\]", block)]
    assert pairs == [tuple(p) for p in RAPID_SCALE]


def test_rating_scale_is_monotonic_and_round_trips():
    from backend.ratings import RAPID_SCALE, from_lichess, to_lichess
    cc = [a for a, _ in RAPID_SCALE]
    li = [b for _, b in RAPID_SCALE]
    assert cc == sorted(cc) and li == sorted(li)
    # the gap narrows with strength (ChessGoals): big at the bottom, small at the top
    assert li[0] - cc[0] > li[-1] - cc[-1]
    for r in (900, 1200, 1588, 2000, 2300):
        assert abs(from_lichess(to_lichess(r, "chesscom"), "chesscom") - r) <= 2
        assert to_lichess(r, "lichess") == r


# ── accounts ────────────────────────────────────────────────────────────────

@pytest.fixture()
def auth_client(tmp_path, monkeypatch):
    from backend import auth
    monkeypatch.setattr(auth, "USERS_DIR", tmp_path)
    monkeypatch.setattr(auth, "USERS_PATH", tmp_path / "users.json")
    monkeypatch.setattr(auth, "SESSIONS_PATH", tmp_path / "sessions.json")
    monkeypatch.setattr(auth, "chess_account_exists", lambda platform, name: name != "nobody_here")
    auth._failures.clear()
    app = FastAPI()
    app.include_router(auth.router)
    return TestClient(app), auth


def _reg(**over):
    body = {"name": "Ada Player", "user_id": "ada_01", "email": "ada@example.com", "password": "correct-horse-9",
            "platform": "lichess", "chess_username": "ada_on_lichess"}
    body.update(over)
    return body


def test_register_login_me_and_password_rules(auth_client):
    client, _ = auth_client
    r = client.post("/api/auth/register", json=_reg())
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    assert "password" not in r.json()["user"]

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200 and me.json()["user"]["chess_username"] == "ada_on_lichess"

    # sign in with the user id or the email
    assert client.post("/api/auth/login", json={"identifier": "ada_01", "password": "correct-horse-9"}).status_code == 200
    assert client.post("/api/auth/login", json={"identifier": "ADA@example.com", "password": "correct-horse-9"}).status_code == 200
    assert client.post("/api/auth/login", json={"identifier": "ada_01", "password": "wrong-password-1"}).status_code == 401

    # duplicates, weak passwords, unknown chess accounts are refused
    assert client.post("/api/auth/register", json=_reg(email="other@example.com")).status_code == 409
    assert client.post("/api/auth/register", json=_reg(user_id="ada_02")).status_code == 409
    assert client.post("/api/auth/register", json=_reg(user_id="ada_03", email="a3@example.com", password="short")).status_code == 422
    assert client.post("/api/auth/register", json=_reg(user_id="ada_04", email="a4@example.com",
                                                        chess_username="nobody_here")).status_code == 422
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_passwords_are_hashed_on_disk(auth_client):
    client, auth = auth_client
    client.post("/api/auth/register", json=_reg())
    raw = auth.USERS_PATH.read_text(encoding="utf-8")
    assert "correct-horse-9" not in raw
    sessions = auth.SESSIONS_PATH.read_text(encoding="utf-8")
    token = client.post("/api/auth/login", json={"identifier": "ada_01", "password": "correct-horse-9"}).json()["token"]
    assert token not in sessions          # only token hashes are stored


def test_dev_login_and_owner_check(auth_client, monkeypatch):
    client, auth = auth_client
    r = client.post("/api/auth/dev-login")
    assert r.status_code == 200 and r.json()["user"]["chess_username"] == auth.DEV_CHESS_USERNAME
    token = r.json()["token"]
    req = SimpleNamespace(headers={"authorization": f"Bearer {token}"})
    auth.assert_owner(req, auth.DEV_CHESS_USERNAME)                     # own data: fine
    with pytest.raises(Exception):
        auth.assert_owner(req, "someone_else")                           # another player's data
    auth.assert_owner(SimpleNamespace(headers={}), "anyone")             # anonymous local tools
    monkeypatch.setenv("FORKED_DEV_LOGIN", "0")
    assert client.post("/api/auth/dev-login").status_code == 404


# ── game library ────────────────────────────────────────────────────────────

PGN = """[Event "Casual"]
[White "ada_on_lichess"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0
"""


@pytest.fixture()
def library(tmp_path, monkeypatch):
    from backend import library as lib
    monkeypatch.setattr(lib, "LIBRARY_DIR", tmp_path)
    return lib


def test_library_ids_are_stable_and_deduplicated(library):
    a = library.upsert_game("ada", pgn=PGN, source="review", aliases=["ada_on_lichess"])
    b = library.upsert_game("ada", moves=a["moves"], source="maia")       # same game, other route in
    assert a["id"] == b["id"]
    rec = library.get_game("ada", a["id"])
    assert set(rec["sources"]) == {"review", "maia"} and rec["source"] == "maia"
    assert rec["result"] == "1-0" and rec["plies"] == 7
    assert rec["user_color"] == "white"
    assert library.delete_game("ada", a["id"]) and library.get_game("ada", a["id"]) is None


def test_key_moments_split_and_side():
    from backend.library import key_moments
    rows = [
        {"color": "white", "classification": "blunder", "ply": 3},
        {"color": "white", "classification": "mistake", "ply": 5},
        {"color": "white", "classification": "miss", "ply": 7},
        {"color": "white", "classification": "inaccuracy", "ply": 9},
        {"color": "black", "classification": "blunder", "ply": 4},
    ]
    km = key_moments(rows, "white")
    assert [m["ply"] for m in km["blunders"]] == [3]
    assert [m["ply"] for m in km["mistakes"]] == [5, 7]
    both = key_moments(rows, None)
    assert len(both["blunders"]) == 2


# ── drill stats ─────────────────────────────────────────────────────────────

def test_day_streak_counts_back_from_today_or_yesterday():
    from backend.drills import _day_streak
    today = dt.date(2026, 10, 25)
    days = {d: {"n": 1} for d in ("2026-10-23", "2026-10-24", "2026-10-25", "2026-10-10", "2026-10-11", "2026-10-12")}
    assert _day_streak(days, today) == (3, 3)
    days.pop("2026-10-25")
    assert _day_streak(days, today) == (2, 3)            # nothing yet today: streak still alive
    assert _day_streak({}, today) == (0, 0)


def test_drill_attempts_accumulate(tmp_path, monkeypatch):
    from backend import drills
    monkeypatch.setattr(drills, "OUTPUT_DIR", tmp_path)
    app = FastAPI()
    app.include_router(drills.router)
    c = TestClient(app)
    for ok in (True, True, False, True):
        assert c.post("/api/drills/attempt", json={"username": "ada", "cluster_id": "loose_pieces",
                                                   "correct": ok, "date": "2026-10-25"}).status_code == 200
    s = c.get("/api/drills/stats/ada?today=2026-10-25").json()
    assert (s["total"], s["solved"], s["streak"], s["best_streak"]) == (4, 3, 1, 2)
    assert s["today"] == {"n": 4, "w": 3} and s["day_streak"] == 1


# ── alerts only for real tactical mistakes ─────────────────────────────────

def test_positional_and_inaccuracies_never_match():
    from ml.matching import MatchContext, match_events
    ctx = MatchContext(clusters=[{"cluster_id": "loose_pieces"}, {"cluster_id": "positional"}],
                       family_to_i={"loose_pieces": 0, "positional": 1})
    ev = lambda tt, jd: SimpleNamespace(threat_type=tt, judgement=jd, eval_drop_category=jd or "inaccuracy")
    from ml.clustering.families import family_of
    tactical = next(t for t in ("hanging_piece", "undefended_piece", "loose_piece") if family_of(t) == "loose_pieces")
    res = match_events([ev(tactical, "blunder"), ev(tactical, None), ev("positional", "blunder")], ctx)
    assert [r.matched for r in res] == [True, False, False]
