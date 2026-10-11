"""
Scoresheet OCR endpoint.

POST /api/ocr/scoresheet  — multipart form, field ``image`` (JPEG/PNG, <=10 MB).
Runs OCR (Google Cloud Vision REST if GOOGLE_VISION_API_KEY is set, else a local
Tesseract fallback), parses the text into moves, validates them with
python-chess, and returns the structured result used by the Forked Scanner's
move-review screen.

Env:
  GOOGLE_VISION_API_KEY   optional; enables Cloud Vision (free tier 1k/month).
                          Without it the endpoint falls back to Tesseract
                          (requires `pip install pytesseract` + system tesseract).
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os

import requests
from fastapi import APIRouter, File, HTTPException, UploadFile

from backend.scoresheet_parser import Word, process_scoresheet, words_from_vision

log = logging.getLogger("forked.ocr")

router = APIRouter(prefix="/api/ocr", tags=["ocr"])

MAX_BYTES = 10 * 1024 * 1024
ALLOWED_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
VISION_URL = "https://vision.googleapis.com/v1/images:annotate"


def run_google_vision_ocr(image_bytes: bytes) -> tuple[str, float, list[Word]]:
    """Returns (text, mean_confidence, positioned_words).

    Uses DOCUMENT_TEXT_DETECTION (tuned for dense / handwritten documents),
    which also returns per-word ``textAnnotations`` with bounding boxes so the
    parser can reconstruct the scoresheet grid.
    """
    key = os.environ["GOOGLE_VISION_API_KEY"]
    body = {
        "requests": [
            {
                "image": {"content": base64.b64encode(image_bytes).decode("ascii")},
                "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
            }
        ]
    }
    resp = requests.post(f"{VISION_URL}?key={key}", json=body, timeout=30)

    # Surface Google's specific reason (e.g. API not enabled, billing required,
    # key restricted) instead of a bare HTTP 403/400.
    if not resp.ok:
        try:
            msg = resp.json()["error"]["message"]
        except Exception:  # noqa: BLE001
            msg = resp.text[:300]
        raise HTTPException(status_code=502, detail=f"Google Vision error: {msg}")

    payload = resp.json()["responses"][0]

    if payload.get("error"):
        raise RuntimeError(payload["error"].get("message", "Vision API error"))

    annotations = payload.get("textAnnotations") or []
    words = words_from_vision(annotations)

    full = payload.get("fullTextAnnotation")
    if full and full.get("text"):
        confs: list[float] = []
        for page in full.get("pages", []):
            for block in page.get("blocks", []):
                for para in block.get("paragraphs", []):
                    for word in para.get("words", []):
                        if "confidence" in word:
                            confs.append(word["confidence"])
        mean_conf = sum(confs) / len(confs) if confs else 0.0
        return full["text"], mean_conf, words

    if annotations:
        return annotations[0]["description"], 0.0, words
    return "", 0.0, words


_NO_ENGINE_MSG = (
    "No OCR engine available. Set GOOGLE_VISION_API_KEY in the backend .env "
    "(recommended), or install Tesseract (`pip install pytesseract` + the "
    "system Tesseract binary)."
)


def run_tesseract_ocr(image_bytes: bytes) -> tuple[str, float, list[Word]]:
    try:
        import pytesseract
        from PIL import Image
    except ImportError as e:
        raise HTTPException(status_code=503, detail=_NO_ENGINE_MSG) from e

    try:
        image = Image.open(io.BytesIO(image_bytes))
        # image_to_data gives per-word boxes so the grid parser can run on the
        # Tesseract fallback too.
        data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
    except pytesseract.TesseractNotFoundError as e:
        raise HTTPException(status_code=503, detail=_NO_ENGINE_MSG) from e

    words: list[Word] = []
    texts: list[str] = []
    n = len(data["text"])
    for i in range(n):
        txt = data["text"][i].strip()
        if not txt:
            continue
        texts.append(txt)
        words.append(
            Word(
                text=txt,
                cx=data["left"][i] + data["width"][i] / 2,
                cy=data["top"][i] + data["height"][i] / 2,
                h=float(data["height"][i]),
            )
        )
    return " ".join(texts), 0.0, words


# ── Vision-LLM provider (Qwen2.5-VL etc.) ─────────────────────────────────────
# A vision LLM reads handwriting *with chess-notation context*, so it beats
# generic OCR on messy scoresheets. Any OpenAI-compatible endpoint works:
#   - OpenRouter free tier: VLM_OCR_BASE=https://openrouter.ai/api/v1
#                           VLM_OCR_MODEL=qwen/qwen2.5-vl-72b-instruct:free
#                           VLM_OCR_KEY=sk-or-...
#   - Local Ollama (free/offline): VLM_OCR_BASE=http://localhost:11434/v1
#                                  VLM_OCR_MODEL=qwen2.5vl:7b   (no key)
# The model returns the moves directly; our python-chess legality layer then
# validates/repairs them, so a hallucinated move can't reach the PGN.

_VLM_PROMPT = (
    "You are transcribing a chess scoresheet. Read EVERY move from the WHOLE sheet "
    "and return ONLY a JSON object of this exact shape:\n"
    '{"moves":[{"number":1,"white":"e4","black":"e5"},'
    '{"number":2,"white":"Nf3","black":"Nc6"}]}\n'
    "CRITICAL LAYOUT — most scoresheets have TWO side-by-side tables. The LEFT "
    "table holds the lower move numbers (e.g. 1-30) and the RIGHT table CONTINUES "
    "the SAME game with the higher move numbers (e.g. 31-60). You MUST read BOTH "
    "tables. Do NOT stop at the bottom of the left table — keep going into the "
    "right table until the moves run out. Each row is: number, White's move, "
    "Black's move.\n"
    "Notation rules: standard algebraic notation (SAN) with NO spaces inside a "
    "move; a capture is written like 'Qxc7' or 'exd5' (lowercase destination "
    "file, no space around the 'x'); piece letters are uppercase K Q R B N; "
    "square files are lowercase a-h; castling is O-O or O-O-O; if a cell is blank "
    "or unreadable use an empty string \"\"; ignore the header, player names, "
    "date, result and signatures. Output JSON only, no prose, no markdown fences."
)


def _parse_moves_json(text: str) -> list[dict]:
    """Pull the moves array out of the model's response, tolerating stray prose."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        return []
    try:
        obj = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return []
    out: list[dict] = []
    for i, m in enumerate(obj.get("moves", []), start=1):
        if not isinstance(m, dict):
            continue
        white = (m.get("white") or "").strip()
        black = (m.get("black") or "").strip()
        try:
            number = int(m.get("number", i))
        except (TypeError, ValueError):
            number = i
        out.append(
            {
                "number": number,
                "white": white or None,
                "black": black or None,
                "white_raw": white,
                "black_raw": black,
            }
        )
    return out


def _downscale_for_vlm(image_bytes: bytes) -> tuple[bytes, str]:
    """Shrink large phone photos before sending to the VLM. A scoresheet stays
    perfectly legible at ~1500px on the long edge, and the smaller image cuts
    inference time dramatically (the difference between seconds and minutes on a
    CPU-only Ollama). Controlled by VLM_OCR_MAX_EDGE (px); 0 disables."""
    max_edge = int(os.getenv("VLM_OCR_MAX_EDGE", "1500"))
    if max_edge <= 0:
        return image_bytes, "image/jpeg"
    try:
        from PIL import Image
    except ImportError:
        return image_bytes, "image/jpeg"
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img = img.convert("RGB")
        if max(img.size) > max_edge:
            scale = max_edge / max(img.size)
            img = img.resize((round(img.width * scale), round(img.height * scale)))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return buf.getvalue(), "image/jpeg"
    except Exception:  # noqa: BLE001
        return image_bytes, "image/jpeg"


# Focused prompt for a single (cropped) table — the right-hand continuation.
# `{start}` is the expected first move number so the model anchors the numbering.
_VLM_PROMPT_CROP = (
    "This image is ONE table cropped from a chess scoresheet — the RIGHT-HAND "
    "table that CONTINUES the same game. Columns are: move number, White's move, "
    "Black's move. The first data row is move number {start}, and the rows count "
    "UP from there ({start}, {next}, {next2}, ...).\n"
    "Transcribe EVERY row from top to bottom — there can be many rows. Do NOT "
    "stop after the first row. Go down the whole table until the rows become "
    "blank, then stop. Keep the printed move numbers.\n"
    "Return ONLY JSON: "
    '{{"moves":[{{"number":{start},"white":"...","black":"..."}},'
    '{{"number":{next},"white":"...","black":"..."}}]}}. '
    "Notation: SAN, no spaces, lowercase destination files, captures like Qxc7, "
    "castling O-O / O-O-O; a blank or unreadable cell = \"\". JSON only."
)


def _vlm_chat(img_bytes: bytes, media: str, prompt: str) -> str:
    """One OpenAI-compatible vision-chat call; returns the message content."""
    base = os.environ["VLM_OCR_BASE"].rstrip("/")
    model = os.getenv("VLM_OCR_MODEL", "qwen/qwen2.5-vl-72b-instruct:free")
    key = os.getenv("VLM_OCR_KEY", "")
    timeout = float(os.getenv("VLM_OCR_TIMEOUT", "600"))

    data_url = f"data:{media};base64,{base64.b64encode(img_bytes).decode('ascii')}"
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    body = {
        "model": model,
        "temperature": 0,
        "max_tokens": 4000,
        "keep_alive": os.getenv("VLM_OCR_KEEP_ALIVE", "30m"),
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }],
        "response_format": {"type": "json_object"},
    }
    url = f"{base}/chat/completions"
    resp = requests.post(url, json=body, headers=headers, timeout=timeout)
    if resp.status_code == 400 and "response_format" in body:
        body.pop("response_format")
        resp = requests.post(url, json=body, headers=headers, timeout=timeout)
    if not resp.ok:
        try:
            msg = resp.json()["error"]["message"]
        except Exception:  # noqa: BLE001
            msg = resp.text[:300]
        raise HTTPException(status_code=502, detail=f"Vision model error: {msg}")
    return resp.json()["choices"][0]["message"]["content"]


def _crop_right_half(image_bytes: bytes) -> bytes | None:
    """Crop the right ~half of the image (includes the right move-number column)."""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        w, h = img.size
        crop = img.crop((int(w * 0.46), 0, w, h))
        buf = io.BytesIO()
        crop.save(buf, format="JPEG", quality=90)
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        return None


def _max_move_number(moves: list[dict]) -> int:
    return max((m.get("number", 0) for m in moves if (m.get("white") or m.get("black"))), default=0)


def run_vlm_ocr(image_bytes: bytes, content_type: str) -> tuple[str, float, list[Word], list[dict]]:
    """
    Two-column-safe reading. Many scoresheets are two side-by-side tables; small
    VLMs reliably read the LEFT table but skip the RIGHT one. So: do a full-image
    pass, then — if there are enough moves to plausibly have a right column — do a
    second pass on a right-half crop and merge in any HIGHER-numbered moves. On a
    single-column sheet the right-half crop has no number column, so it yields
    nothing above the existing max and the merge is a no-op.
    """
    img_bytes, media = _downscale_for_vlm(image_bytes)
    content = _vlm_chat(img_bytes, media, _VLM_PROMPT)
    moves = _parse_moves_json(content)

    max_num = _max_move_number(moves)
    if max_num >= 16:
        crop = _crop_right_half(image_bytes)
        if crop is not None:
            try:
                cimg, cmedia = _downscale_for_vlm(crop)
                start = max_num + 1
                crop_prompt = _VLM_PROMPT_CROP.format(start=start, next=start + 1, next2=start + 2)
                ccontent = _vlm_chat(cimg, cmedia, crop_prompt)
                extra = [
                    m for m in _parse_moves_json(ccontent)
                    if m.get("number", 0) > max_num and (m.get("white") or m.get("black"))
                ]
                if extra:
                    moves = sorted(moves + extra, key=lambda m: m.get("number", 0))
                    content = content + "\n--- right table ---\n" + ccontent
            except HTTPException:
                pass  # right-half pass is best-effort; keep the left-table result

    return content, 0.0, [], moves


def run_ocr(image_bytes: bytes, content_type: str) -> tuple[str, float, list[Word], list[dict] | None]:
    if os.getenv("VLM_OCR_BASE"):
        return run_vlm_ocr(image_bytes, content_type)
    if os.getenv("GOOGLE_VISION_API_KEY"):
        text, conf, words = run_google_vision_ocr(image_bytes)
        return text, conf, words, None
    log.warning("No VLM_OCR_BASE / GOOGLE_VISION_API_KEY — falling back to Tesseract OCR")
    text, conf, words = run_tesseract_ocr(image_bytes)
    return text, conf, words, None


@router.post("/scoresheet")
async def ocr_scoresheet(image: UploadFile = File(...)) -> dict:
    if image.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail=f"Unsupported type: {image.content_type}")

    content = await image.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty image")
    if len(content) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 10 MB)")

    try:
        raw_text, confidence, words, moves = run_ocr(content, image.content_type or "image/jpeg")
    except HTTPException:
        raise
    except requests.RequestException as e:
        log.exception("OCR request failed")
        raise HTTPException(status_code=502, detail=f"OCR service error: {e}") from e
    except Exception as e:  # noqa: BLE001
        log.exception("OCR failed")
        raise HTTPException(status_code=500, detail=f"OCR failed: {e}") from e

    result = process_scoresheet(raw_text, words, moves)

    # Surface quality hints for the frontend's error states.
    result["confidence"] = confidence
    result["low_confidence"] = bool(confidence and confidence < 0.7)
    if result["total_moves"] < 3:
        result["warning"] = "few_moves"

    return result
