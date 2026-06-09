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
import logging
import os

import requests
from fastapi import APIRouter, File, HTTPException, UploadFile

from backend.scoresheet_parser import process_scoresheet

log = logging.getLogger("forked.ocr")

router = APIRouter(prefix="/api/ocr", tags=["ocr"])

MAX_BYTES = 10 * 1024 * 1024
ALLOWED_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
VISION_URL = "https://vision.googleapis.com/v1/images:annotate"


def run_google_vision_ocr(image_bytes: bytes) -> tuple[str, float]:
    """Returns (text, mean_confidence). Confidence is 0.0 when unavailable."""
    key = os.environ["GOOGLE_VISION_API_KEY"]
    body = {
        "requests": [
            {
                "image": {"content": base64.b64encode(image_bytes).decode("ascii")},
                "features": [{"type": "TEXT_DETECTION"}],
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

    full = payload.get("fullTextAnnotation")
    if full and full.get("text"):
        # Average per-word confidence across the document, if reported.
        confs: list[float] = []
        for page in full.get("pages", []):
            for block in page.get("blocks", []):
                for para in block.get("paragraphs", []):
                    for word in para.get("words", []):
                        if "confidence" in word:
                            confs.append(word["confidence"])
        mean_conf = sum(confs) / len(confs) if confs else 0.0
        return full["text"], mean_conf

    annotations = payload.get("textAnnotations")
    if annotations:
        return annotations[0]["description"], 0.0
    return "", 0.0


_NO_ENGINE_MSG = (
    "No OCR engine available. Set GOOGLE_VISION_API_KEY in the backend .env "
    "(recommended), or install Tesseract (`pip install pytesseract` + the "
    "system Tesseract binary)."
)


def run_tesseract_ocr(image_bytes: bytes) -> tuple[str, float]:
    try:
        import pytesseract
        from PIL import Image
    except ImportError as e:
        raise HTTPException(status_code=503, detail=_NO_ENGINE_MSG) from e

    try:
        image = Image.open(io.BytesIO(image_bytes))
        return pytesseract.image_to_string(image), 0.0
    except pytesseract.TesseractNotFoundError as e:
        # Python package installed but the system binary is missing.
        raise HTTPException(status_code=503, detail=_NO_ENGINE_MSG) from e


def run_ocr(image_bytes: bytes) -> tuple[str, float]:
    if os.getenv("GOOGLE_VISION_API_KEY"):
        return run_google_vision_ocr(image_bytes)
    log.warning("No GOOGLE_VISION_API_KEY — falling back to Tesseract OCR")
    return run_tesseract_ocr(image_bytes)


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
        raw_text, confidence = run_ocr(content)
    except HTTPException:
        raise
    except requests.RequestException as e:
        log.exception("Vision API request failed")
        raise HTTPException(status_code=502, detail=f"OCR service error: {e}") from e
    except Exception as e:  # noqa: BLE001
        log.exception("OCR failed")
        raise HTTPException(status_code=500, detail=f"OCR failed: {e}") from e

    result = process_scoresheet(raw_text)

    # Surface quality hints for the frontend's error states.
    result["confidence"] = confidence
    result["low_confidence"] = bool(confidence and confidence < 0.7)
    if result["total_moves"] < 3:
        result["warning"] = "few_moves"

    return result
