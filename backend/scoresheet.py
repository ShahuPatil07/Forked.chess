"""
Scoresheet -> PGN endpoints (OTB Scan).

  POST /api/ocr/scoresheet            multipart: one or more images (field `images`, or legacy `image`)
                                       -- several images = consecutive pages of one game
  POST /api/ocr/scoresheet/redecode   JSON {reads, pins}: re-decode after the user fixes moves

Pipeline:
  1. read    backend/scoresheet_reader.py -- a vision model copies every cell literally:
             a full-page pass + four contrast-enhanced row bands, concurrently
             (DeepSeek-V4.1-Flash; ~9 calls incl. proofreading, about $0.004 a page).
             Without any vision model: Google Vision / Tesseract word boxes -> grid parser.
  2. decode  backend/scoresheet_decoder.py -- beam search over LEGAL games that best explain the
             readings, tolerant of misreads AND of the player's own notation slips; every ply
             gets a status (exact / corrected / uncertain / inferred) and alternatives.
     Where the writing fits no legal move exactly (or a cell is blank), Maia2 -- the human-move
             model -- breaks ties: "Bd7" in a position where Bd6 is natural and Be7 isn't.
     Then every decoded move is proofread against its image band as a multiple choice
             and the game is re-decoded (backend/scoresheet_pipeline.py).
  3. review  the frontend shows flagged plies; a fix is sent back as a pin and the rest of the
             game is re-decoded around it.

Measured on the HCS handwritten-scoresheet benchmark: scripts/eval_scoresheets.py,
reports/scoresheet_eval/.
"""
from __future__ import annotations

import base64
import io
import logging
import os
import time

import chess
import chess.pgn
import requests
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from backend import scoresheet_reader as reader
from backend.scoresheet_pipeline import scan_image
from backend.scoresheet_decoder import cells_from_rows, decode
from backend.scoresheet_prior import move_logprobs
from backend.scoresheet_parser import Word, parse_grid, parse_scoresheet, words_from_vision

log = logging.getLogger("forked.ocr")

router = APIRouter(prefix="/api/ocr", tags=["ocr"])

MAX_BYTES = 12 * 1024 * 1024
MAX_PAGES = 4
ALLOWED_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"}
VISION_URL = "https://vision.googleapis.com/v1/images:annotate"


# ── fallback OCR (no vision model configured) ───────────────────────────────

def run_google_vision_ocr(image_bytes: bytes) -> tuple[str, list[Word]]:
    key = os.environ["GOOGLE_VISION_API_KEY"]
    body = {"requests": [{"image": {"content": base64.b64encode(image_bytes).decode("ascii")},
                          "features": [{"type": "DOCUMENT_TEXT_DETECTION"}]}]}
    resp = requests.post(f"{VISION_URL}?key={key}", json=body, timeout=30)
    if not resp.ok:
        try:
            msg = resp.json()["error"]["message"]
        except Exception:  # noqa: BLE001
            msg = resp.text[:300]
        raise HTTPException(status_code=502, detail=f"Google Vision error: {msg}")
    payload = resp.json()["responses"][0]
    if payload.get("error"):
        raise HTTPException(status_code=502, detail=payload["error"].get("message", "Vision API error"))
    annotations = payload.get("textAnnotations") or []
    text = (payload.get("fullTextAnnotation") or {}).get("text") or (annotations[0]["description"] if annotations else "")
    return text, words_from_vision(annotations)


def run_tesseract_ocr(image_bytes: bytes) -> tuple[str, list[Word]]:
    try:
        import pytesseract
        from PIL import Image
        data = pytesseract.image_to_data(Image.open(io.BytesIO(image_bytes)), output_type=pytesseract.Output.DICT)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=(
            "No scoresheet reader available. Set DEEPSEEK_API_KEY (recommended) or VLM_OCR_BASE, "
            "or GOOGLE_VISION_API_KEY / install Tesseract.")) from e
    words, texts = [], []
    for i, txt in enumerate(data["text"]):
        txt = txt.strip()
        if txt:
            texts.append(txt)
            words.append(Word(text=txt, cx=data["left"][i] + data["width"][i] / 2,
                              cy=data["top"][i] + data["height"][i] / 2, h=float(data["height"][i])))
    return " ".join(texts), words


def _fallback_rows(image_bytes: bytes) -> tuple[list[dict], str, str]:
    if os.getenv("GOOGLE_VISION_API_KEY"):
        text, words, prov = *run_google_vision_ocr(image_bytes), "google-vision"
    else:
        text, words, prov = *run_tesseract_ocr(image_bytes), "tesseract"
    parsed = parse_grid(words) or parse_scoresheet(text)
    rows = [{"number": m["number"], "white": m.get("white_raw") or "", "black": m.get("black_raw") or "",
             "white_alt": [], "black_alt": []} for m in parsed]
    return rows, text, prov


# ── response building ───────────────────────────────────────────────────────

def _pgn(sans: list[str], meta: dict | None = None) -> str:
    game = chess.pgn.Game()
    meta = meta or {}
    game.headers["Event"] = meta.get("event") or "Over-the-board game"
    game.headers["White"] = meta.get("white") or "?"
    game.headers["Black"] = meta.get("black") or "?"
    if meta.get("date"):
        game.headers["Date"] = meta["date"]
    game.headers["Annotator"] = "Forked OTB Scan"
    node, board = game, chess.Board()
    for s in sans:
        mv = board.parse_san(s)
        node = node.add_variation(mv)
        board.push(mv)
    result = meta.get("result") if meta.get("result") in ("1-0", "0-1", "1/2-1/2") else None
    if board.is_checkmate():
        result = "1-0" if board.turn == chess.BLACK else "0-1"
    game.headers["Result"] = result or "*"
    return str(game.accept(chess.pgn.StringExporter(headers=True, variations=False, comments=False)))


def _legal_options(sans: list[str]) -> list[list[str]]:
    """All legal SANs at every ply (for the review screen's 'pick another move')."""
    board, out = chess.Board(), []
    for s in sans:
        out.append(sorted(board.san(m) for m in board.legal_moves))
        board.push_san(s)
    return out


def _prior(elo: int | None):
    """Maia2 human-move prior at the player's rating (club default 1500)."""
    level = min(max(int(elo or 1500), 800), 2400)
    return lambda boards: move_logprobs(boards, level)


def build_response(rows: list[dict], pins: dict[int, str] | None = None, meta: dict | None = None,
                   elo: int | None = None, decoded: dict | None = None) -> dict:
    """`decoded`: a decode of exactly these rows the caller already has (skips a second one)."""
    t0 = time.time()
    cells = cells_from_rows(rows)
    res = decoded if decoded is not None and not pins else decode(cells, pins=pins, prior=_prior(elo))
    plies = res["plies"]
    sans = [p["san"] for p in plies]
    options = _legal_options(sans)
    for p, opts in zip(plies, options):
        p["legal"] = opts
    dropped = [{"row": cells[j].row, "color": cells[j].color, "read": cells[j].raw} for j in res["dropped_cells"]]
    stats = {k: sum(1 for p in plies if p["status"] == k) for k in ("exact", "corrected", "uncertain", "inferred")}
    warning = None
    if len(plies) < 4:
        warning = "few_moves"
    elif stats["uncertain"] + stats["inferred"] > max(4, len(plies) // 4):
        warning = "low_confidence"
    return {
        "plies": plies, "dropped": dropped, "sans": sans, "pgn": _pgn(sans, meta),
        "reads": rows, "meta": meta or {}, "stats": stats, "warning": warning,
        "total_moves": (len(plies) + 1) // 2, "decode_s": round(time.time() - t0, 2),
    }


# ── endpoints ───────────────────────────────────────────────────────────────

@router.post("/scoresheet")
def ocr_scoresheet(images: list[UploadFile] | None = File(None), image: UploadFile | None = File(None),
                   elo: int | None = Form(None)) -> dict:
    files = [f for f in (images or []) if f is not None] + ([image] if image is not None else [])
    if not files:
        raise HTTPException(status_code=400, detail="Attach at least one scoresheet image.")
    if len(files) > MAX_PAGES:
        raise HTTPException(status_code=400, detail=f"At most {MAX_PAGES} pages per game.")
    t0 = time.time()
    spend0 = reader.spent_usd()
    pages: list[list[dict]] = []
    raw, provider, meta = [], None, {}
    decoded_pages: list[dict] = []
    for f in files:
        if f.content_type and f.content_type not in ALLOWED_TYPES:
            raise HTTPException(status_code=415, detail=f"Unsupported image type: {f.content_type}")
        data = f.file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Empty image")
        if len(data) > MAX_BYTES:
            raise HTTPException(status_code=413, detail="Image too large (max 12 MB)")
        try:
            if reader.available():
                # read -> decode -> proofread every move -> re-decode (backend/scoresheet_pipeline.py)
                out = scan_image(data, elo=elo, cache=os.getenv("SCORESHEET_CACHE") == "1")  # dev: reuse cached reads
                rows, provider = out["rows"], out["provider"]
                meta = meta or out.get("meta") or {}
                raw.append(out["raw"])
                decoded_pages.append(out["decoded"])
            else:
                rows, text, provider = _fallback_rows(data)
                raw.append(text)
        except reader.ReaderError as e:
            raise HTTPException(status_code=502, detail=f"Couldn't read the scoresheet: {e}") from e
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("scoresheet read failed")
            raise HTTPException(status_code=500, detail=f"Reading failed: {e}") from e
        pages.append(rows)

    # Later pages continue the game; if a page restarts its numbering, offset it.
    merged: list[dict] = []
    for rows in pages:
        top = max((r["number"] for r in merged), default=0)
        if rows and merged and min(r["number"] for r in rows) <= top:
            rows = [{**r, "number": r["number"] + top} for r in rows]
        merged += rows
    if not merged:
        raise HTTPException(status_code=422, detail="No moves found. Is the whole move table in the photo?")

    single = len(pages) == 1 and len(decoded_pages) == 1
    result = build_response(merged, meta=meta, elo=elo, decoded=decoded_pages[0] if single else None)
    result.update(provider=provider, pages=len(files), raw_ocr="\n\n".join(raw),
                  elapsed_s=round(time.time() - t0, 1), cost_usd=round(reader.spent_usd() - spend0, 5))
    return result


class RedecodeIn(BaseModel):
    reads: list[dict]
    pins: dict[int, str] = {}
    meta: dict = {}
    elo: int | None = None


@router.post("/scoresheet/redecode")
def redecode(body: RedecodeIn) -> dict:
    """Re-run the decoder with the user's confirmed moves pinned (no model call)."""
    for k, uci in body.pins.items():
        try:
            chess.Move.from_uci(uci)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"bad pinned move {uci!r} at ply {k}") from e
    return build_response(body.reads, pins={int(k): v for k, v in body.pins.items()}, meta=body.meta, elo=body.elo)
