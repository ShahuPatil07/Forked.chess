"""
End-to-end Stage-1 ingestion: fetch -> annotate -> extract -> Maia2 -> classify.

    from ml.pipeline import run_ingestion
    mistakes = run_ingestion("MagnusCarlsen", platform="lichess", min_games=150)

Per game (in parallel over a Stockfish pool, cached per game id):
  1. two-pass Stockfish annotation with stored lines (annotator.py)
  2. both sides' mistakes by win-probability loss, each tagged allowed / missed /
     both / quiet; tactical opportunities found / missed (mistake_extractor.py)
  3. Maia2 at the players' real ratings: P(a peer avoids this mistake) as a
     soft personal weight (maia_annotator.py)
Then, in one batch:
  4. motif classification in the right framing + verifier evidence + soft
     family probabilities (classify_events.py), cascade linking

Writes data/output/<user>_{mistakes,peer_mistakes,opportunities,exposure,
game_meta,ingest_stats}.json and returns the user's MistakeEvents. Stage 2
(ml/clustering/profile_pipeline.run_clustering) reads the peer / opportunity /
exposure files to build the peer-relative profile.
"""
from __future__ import annotations

import json
import logging
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

import chess.engine

from ml.config import DATA_DIR, STOCKFISH_PATH, USE_MAIA2, GAME_TIME_CLASSES
from ml.ingestion.annotator import annotate_game
from ml.ingestion.fetcher import (
    fetch_chesscom_games,
    fetch_lichess_games,
    parse_chesscom_game,
    parse_lichess_game,
)
from ml.ingestion.mistake_extractor import (
    MistakeEvent, Opportunity, extract_game_events, link_cascades,
)

log = logging.getLogger(__name__)

OUTPUT_DIR = DATA_DIR / "output"
MIN_PLIES = 10


@dataclass
class IngestBundle:
    mistakes:      list = field(default_factory=list)   # user
    peer_mistakes: list = field(default_factory=list)   # opponents
    opportunities: list = field(default_factory=list)   # both sides
    exposure:      list = field(default_factory=list)   # per game
    skipped:       int = 0


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _fetch_and_parse(username: str, platform: str, min_games: int) -> list[dict]:
    """Return a list of normalised game dicts (each has 'pgn', 'user_color', etc.)."""
    if platform == "chesscom":
        raw = fetch_chesscom_games(username, min_games=min_games)
        parsed = [parse_chesscom_game(g, username) for g in raw]
    elif platform == "lichess":
        raw = fetch_lichess_games(username, min_games=min_games)
        parsed = [parse_lichess_game(g, username) for g in raw]
    else:
        raise ValueError(f"Unknown platform '{platform}'. Choose 'chesscom' or 'lichess'.")

    games = [g for g in parsed if g is not None]
    if GAME_TIME_CLASSES:
        games = [g for g in games if not g.get("time_class") or g["time_class"] in GAME_TIME_CLASSES]
    return games


def _unix(raw_ts) -> Optional[int]:
    if not raw_ts:
        return None
    return int(raw_ts // 1000) if raw_ts > 1e10 else int(raw_ts)


def default_classifier():
    """The Stage-1 transformer (v2 multi-label when trained, else v1)."""
    try:
        from ml.classifier.transformer.classifier import get_classifier
        return get_classifier()
    except Exception as exc:
        log.warning("Transformer classifier unavailable (%s) — rule-based labels only.", exc)
        return None


def _maia():
    if not USE_MAIA2:
        return None
    try:
        from ml.ingestion.maia_annotator import MaiaAnnotator
        return MaiaAnnotator()
    except Exception as exc:
        log.warning("Maia2 unavailable (%s) — personal weights default to 1.0", exc)
        return None


def _process_game(engine: chess.engine.SimpleEngine, game: dict, maia) -> Optional[dict]:
    try:
        anns = annotate_game(game["pgn"], engine, game_id=game.get("game_id"),
                             increment_s=game.get("increment_s") or 0.0)
    except Exception as exc:
        log.warning("Skipped game %s: %s", game.get("game_id", "?"), exc)
        return None
    if len(anns) < MIN_PLIES:
        return None
    ts = _unix(game.get("played_at"))
    ev = extract_game_events(anns, game, game["user_color"], engine=engine,
                             played_at_unix=ts, initial_s=game.get("initial_s"))
    if maia is not None:
        for m in ev.mistakes + ev.peer_mistakes:
            try:
                maia.annotate_safety(m, engine)
            except Exception as exc:
                log.debug("Maia safety failed: %s", exc)
    uc = game["user_color"]
    return {
        "events": ev,
        "exposure": {
            "game_id": game.get("game_id", ""), "played_at_unix": ts,
            "user_moves": ev.exposure["user"], "opp_moves": ev.exposure["opponent"],
            "user_elo": game.get("white_elo" if uc == "white" else "black_elo"),
            "opp_elo": game.get("black_elo" if uc == "white" else "white_elo"),
            "result": game.get("result"), "time_control": game.get("time_control", ""),
            "plies": len(anns),
        },
    }


def process_games(games: list[dict], workers: Optional[int] = None, progress_callback=None,
                  engine: Optional[chess.engine.SimpleEngine] = None, maia="auto") -> IngestBundle:
    """Annotate + extract every game. Uses a Stockfish pool unless a single
    `engine` is given (live sync)."""
    if maia == "auto":
        maia = _maia()
    bundle = IngestBundle()
    total = len(games)
    found = [0]

    def on_done(i, res):
        if res:
            found[0] += len(res["events"].mistakes)
        if progress_callback:
            progress_callback(i + 1, total, found[0])

    if engine is not None:
        results = []
        for i, g in enumerate(games):
            r = _process_game(engine, g, maia)
            results.append(r); on_done(i, r)
    else:
        from ml.ingestion.engine_pool import EnginePool
        with EnginePool(workers=workers) as pool:
            results = pool.map(lambda eng, g: _process_game(eng, g, maia), games, on_done=on_done)

    for r in results:
        if r is None:
            bundle.skipped += 1
            continue
        bundle.mistakes.extend(r["events"].mistakes)
        bundle.peer_mistakes.extend(r["events"].peer_mistakes)
        bundle.opportunities.extend(r["events"].opportunities)
        bundle.exposure.append(r["exposure"])
    return bundle


def classify_bundle(bundle: IngestBundle, classifier, use_verifier: bool = True) -> None:
    from ml.ingestion.classify_events import classify_events
    from ml.ingestion.threat_classifier import classify_threat
    events = bundle.mistakes + bundle.peer_mistakes
    if classifier is not None:
        classify_events(events, bundle.opportunities, classifier, use_verifier=use_verifier)
    else:
        from ml.clustering.families import family_of
        for e in events:
            e.threat_type = classify_threat(e.fen, e.best_move_uci)
            e.cluster_id = family_of(e.threat_type)
            e.family_probs = {e.cluster_id: 1.0}
            e.classification_method = "rule_based"
    link_cascades(events)


def _annotate_batch(
    games: list[dict],
    engine: chess.engine.SimpleEngine,
    exclude_opening: bool = False,
    progress_callback=None,
    classifier=None,
) -> list[MistakeEvent]:
    """Back-compat (live sync): annotate + extract + classify with one engine,
    returning the user's mistakes. classifier=None -> the default transformer."""
    bundle = process_games(games, engine=engine, progress_callback=progress_callback)
    classify_bundle(bundle, classifier or default_classifier())
    out = bundle.mistakes
    if exclude_opening:
        out = [m for m in out if m.game_phase != "opening"]
    return out


def _dump(path: Path, rows: list) -> None:
    path.write_text(json.dumps([asdict(r) if hasattr(r, "__dataclass_fields__") else r for r in rows],
                               indent=1, default=str), encoding="utf-8")


def save_bundle(bundle: IngestBundle, username: str, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{username}_mistakes.json"
    _dump(path, bundle.mistakes)
    _dump(output_dir / f"{username}_peer_mistakes.json", bundle.peer_mistakes)
    _dump(output_dir / f"{username}_opportunities.json", bundle.opportunities)
    _dump(output_dir / f"{username}_exposure.json", bundle.exposure)
    return path


def _save_game_meta(games: list[dict], username: str, output_dir: Path) -> None:
    meta: dict = {}
    for g in games:
        gid = g.get("game_id", "")
        if not gid:
            continue
        white = g.get("white_username", "")
        black = g.get("black_username", "")
        user_color = g.get("user_color", "white")
        opponent = black if user_color == "white" else white
        meta[gid] = {
            "white": white,
            "black": black,
            "user_color": user_color,
            "opponent": opponent,
            "url": g.get("url", ""),
            "time_control": g.get("time_control", ""),
            "time_class": g.get("time_class", ""),
            "result": g.get("result"),
            "user_elo": g.get("white_elo" if user_color == "white" else "black_elo"),
            "opp_elo": g.get("black_elo" if user_color == "white" else "white_elo"),
            "played_at": _unix(g.get("played_at")),
        }
    output_dir.mkdir(parents=True, exist_ok=True)
    with open(output_dir / f"{username}_game_meta.json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_ingestion(
    username: str,
    platform:  str = "chesscom",
    min_games: int = 200,
    output_dir: Optional[Path] = None,
    stockfish_path: Optional[Path] = None,
    exclude_opening: bool = False,
    progress_callback=None,  # callable(current, total, mistakes_so_far) | None
    workers: Optional[int] = None,
    games: Optional[list[dict]] = None,
) -> list[MistakeEvent]:
    """
    Full Stage-1 pipeline for one user. Returns the user's MistakeEvents and
    saves them (plus the peer / opportunity / exposure files) to JSON.
    `games` lets callers pass already-fetched normalised games.
    """
    if output_dir is None:
        output_dir = OUTPUT_DIR
    sf_path = stockfish_path or STOCKFISH_PATH
    if not Path(sf_path).exists():
        raise FileNotFoundError(
            f"Stockfish binary not found at {sf_path}.\n"
            "Run: python scripts/setup_stockfish.py"
        )
    t0 = time.time()
    print(f"\n{'='*60}\n  Forked ingestion pipeline (Stage 1 v2)")
    print(f"  User: {username}  |  Platform: {platform}  |  Games: {min_games}  |  "
          f"Time classes: {','.join(GAME_TIME_CLASSES) or 'all'}\n{'='*60}\n")

    print("[1/4] Fetching games...")
    if games is None:
        games = _fetch_and_parse(username, platform, min_games)
    print(f"      -> {len(games)} games retrieved\n")
    if not games:
        print("No games found. Check the username, platform and time class.")
        return []
    _save_game_meta(games, username, output_dir)

    print("[2/4] Annotating (Stockfish pool, cached) + Maia2 personal weights...")
    t1 = time.time()
    bundle = process_games(games, workers=workers, progress_callback=progress_callback)
    t_annot = time.time() - t1

    print("[3/4] Classifying (allowed / missed framing + verifier)...")
    classifier = default_classifier()
    classify_bundle(bundle, classifier)
    if exclude_opening:
        bundle.mistakes = [m for m in bundle.mistakes if m.game_phase != "opening"]

    path = save_bundle(bundle, username, output_dir)
    stats = {
        "username": username, "platform": platform, "games": len(games),
        "games_used": len(bundle.exposure), "games_skipped": bundle.skipped,
        "user_mistakes": len(bundle.mistakes), "peer_mistakes": len(bundle.peer_mistakes),
        "incidents": sum(1 for m in bundle.mistakes if not m.cascade),
        "opportunities": len(bundle.opportunities),
        "classifier": getattr(getattr(classifier, "_predictor", None), "version", "rule"),
        "annotate_seconds": round(t_annot, 1), "total_seconds": round(time.time() - t0, 1),
        "time_classes": list(GAME_TIME_CLASSES),
    }
    (output_dir / f"{username}_ingest_stats.json").write_text(json.dumps(stats, indent=2), encoding="utf-8")
    print(f"\n[4/4] Saved to {path}  ({stats['total_seconds']:.0f}s)\n")

    ms = bundle.mistakes
    if ms:
        total = len(ms)
        for title, counter in (("Direction", Counter(m.direction for m in ms)),
                               ("Family", Counter(m.cluster_id for m in ms)),
                               ("Phase", Counter(m.game_phase for m in ms))):
            print(f"  {title}:")
            for k, n in counter.most_common():
                print(f"    {str(k):<22} {n:>4}  ({n/total*100:4.1f}%)")
    return ms
