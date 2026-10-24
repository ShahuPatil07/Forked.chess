"""
Vision readers for handwritten scoresheets: image -> literal cell readings.

The reader's only job is to copy what is written, cell by cell. Chess knowledge
lives in backend/scoresheet_decoder.py, which turns the readings into a legal
game. Asking the model to "fix" moves makes it invent plausible-but-wrong ones,
so the prompts insist on literal transcription and ask for an alternative only
where the handwriting is genuinely ambiguous.

Providers (first available wins; SCORESHEET_READERS overrides the order):
  deepseek   DeepSeek-V4.1-Flash vision (DEEPSEEK_API_KEY). ~4 s, ~$0.0013/page.
  ollama     any OpenAI-compatible endpoint (VLM_OCR_BASE / VLM_OCR_MODEL), e.g. local
             Ollama qwen3-vl -- free, slower, weaker.

Reading strategy (READ_PASSES):
  full    one pass over the whole sheet (all tables)
  tiles   one pass per table column (left / right halves) with the expected first
          row number -- small models skip the right-hand table otherwise
Passes are merged per cell into weighted readings; disagreements become
alternatives for the decoder instead of being silently resolved.

Every paid call is priced and added to data/ocr_spend.json (separate from the
Coach ledger); OCR_SPEND_LIMIT_USD stops paid calls when reached.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import os
import re
import threading
import time
from pathlib import Path

import requests

log = logging.getLogger("forked.ocr")

ROOT = Path(__file__).resolve().parents[1]
SPEND_FILE = ROOT / "data" / "ocr_spend.json"
CACHE_DIR = ROOT / "data" / "raw" / "ocr_cache"       # eval-time cache (gitignored)
PRICE = {"deepseek": (0.30, 1.20)}                   # $ per 1M (input, output)
_spend_lock = threading.Lock()


class ReaderError(RuntimeError):
    pass


PROMPT_FULL = (
    "This is a photo of a handwritten chess scoresheet. Transcribe it EXACTLY as written, cell by cell.\n"
    "Return JSON only: {\"rows\":[{\"n\":1,\"w\":\"d4\",\"b\":\"Nf6\"}, ...]}\n"
    "- One object per numbered row that has any writing. Skip rows where both cells are blank.\n"
    "- Read EVERY table on the sheet. Scoresheets usually have two or more side-by-side tables: the "
    "left one holds the low move numbers (e.g. 1-30) and the next one CONTINUES the same game (31-60). "
    "Use the printed row numbers for n.\n"
    "- w = White's cell, b = Black's cell. Copy the writing literally, even if it looks like a wrong or "
    "illegal move, including x, +, = and disambiguation letters. Do NOT correct or complete moves, and "
    "do NOT fill in moves from chess knowledge or opening theory: players often play unusual moves, and "
    "every cell must come from the ink in THAT row.\n"
    "- Pieces are uppercase K Q R B N; files are lowercase a-h. Castling as written (0-0 / O-O).\n"
    "- If a move is crossed out, give only the move that replaced it.\n"
    "- If a cell is genuinely ambiguous (e.g. b vs 6, N vs H, a vs Q), put your best reading in w/b and "
    "the other plausible reading in \"w_alt\" / \"b_alt\" (a list). Otherwise omit those keys.\n"
    "- Inside the move table, ignore signatures and notes such as 'resigns' or 'draw'.\n"
    "- If the sheet's header shows them, also return \"meta\": {\"white\": name, \"black\": name, "
    "\"result\": \"1-0\" | \"0-1\" | \"1/2-1/2\", \"event\": text, \"date\": \"YYYY.MM.DD\"}, leaving out unknown fields."
)

_TILE_RULES = (
    "Transcribe EXACTLY as written, cell by cell, top to bottom, using the PRINTED row numbers for n. "
    "Skip rows where both cells are blank. Copy moves literally: do not correct them and do not guess "
    "from chess knowledge or opening theory -- every cell must come from the ink in that row. Pieces "
    "uppercase K Q R B N, files lowercase a-h. If a cell is ambiguous add \"w_alt\"/\"b_alt\" lists with "
    "the other plausible reading. Ignore anything that is not a move (results, 'resigns', signatures)."
)

PROMPT_BAND = (
    "This image is one PART of a handwritten chess scoresheet: printed move numbers, each followed by "
    "White's cell and Black's cell. It may start or end part-way down the table. " + _TILE_RULES +
    " Include only rows whose printed number you can see. Return JSON only: "
    "{\"rows\":[{\"n\":12,\"w\":\"...\",\"b\":\"...\"}, ...]}"
)

PROMPT_TILE_LEFT = (
    "This image is the LEFT part of a handwritten chess scoresheet: a column of printed move numbers "
    "starting at 1, each followed by White's cell and Black's cell. " + _TILE_RULES +
    " Return JSON only: {\"rows\":[{\"n\":1,\"w\":\"...\",\"b\":\"...\"}, ...]}"
)

PROMPT_TILE_RIGHT = (
    "This image is the RIGHT part of a handwritten chess scoresheet: one or more columns of printed "
    "move numbers, each followed by White's cell and Black's cell, continuing the game from the left "
    "part. " + _TILE_RULES + " Return JSON only: {\"rows\":[{\"n\":31,\"w\":\"...\",\"b\":\"...\"}, ...]}"
)


# ── image prep ──────────────────────────────────────────────────────────────

def prep_image(image_bytes: bytes, max_edge: int = 1600) -> "Image.Image":
    from PIL import Image, ImageOps
    img = Image.open(io.BytesIO(image_bytes))
    img = ImageOps.exif_transpose(img).convert("RGB")       # phone photos carry rotation in EXIF
    if os.getenv("SCORESHEET_ENHANCE", "1") == "1":
        # pencil on cream paper is faint: stretch the contrast (keeps colour-free JPEGs small too)
        img = ImageOps.autocontrast(ImageOps.grayscale(img), cutoff=1).convert("RGB")
    if max(img.size) > max_edge:
        s = max_edge / max(img.size)
        img = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
    return img


def to_jpeg(img, quality: int = 88) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def band_tiles(img, max_edge: int = 1600) -> list[tuple[str, "Image.Image"]]:
    """Each table column split into an upper and a lower band (with overlap), so a
    band keeps close to full resolution: about twice the pixels per row of a
    full-page read. Labels: left-top, left-bottom, right-top, right-bottom."""
    from PIL import Image
    w, h = img.size
    cols = {"left": (0, int(w * 0.54)), "right": (int(w * 0.46), w)}
    rows = {"top": (0, int(h * 0.56)), "bottom": (int(h * 0.44), h)}
    out = []
    for cn, (x0, x1) in cols.items():
        for rn, (y0, y1) in rows.items():
            t = img.crop((x0, y0, x1, y1))
            if max(t.size) > max_edge:
                s = max_edge / max(t.size)
                t = t.resize((round(t.width * s), round(t.height * s)), Image.LANCZOS)
            out.append((f"{cn}-{rn}", t))
    return out


def column_tiles(img, max_edge: int = 1600) -> list:
    """Left / right halves with a small overlap (tables rarely sit exactly at 50%),
    cut from a higher-resolution image so each table gets more pixels per row."""
    from PIL import Image
    w, h = img.size
    out = []
    for t in (img.crop((0, 0, int(w * 0.54), h)), img.crop((int(w * 0.46), 0, w, h))):
        if max(t.size) > max_edge:
            s = max_edge / max(t.size)
            t = t.resize((round(t.width * s), round(t.height * s)), Image.LANCZOS)
        out.append(t)
    return out


# ── spend ledger ────────────────────────────────────────────────────────────

def spent_usd() -> float:
    try:
        return float(json.loads(SPEND_FILE.read_text(encoding="utf-8")).get("usd", 0.0))
    except Exception:
        return 0.0


def _over_budget() -> bool:
    limit = float(os.getenv("OCR_SPEND_LIMIT_USD", "0") or 0)
    return bool(limit) and spent_usd() >= limit


def _record(provider: str, usage: dict) -> float:
    if provider not in PRICE:
        return 0.0
    pin, pout = PRICE[provider]
    usd = (usage.get("prompt_tokens", 0) * pin + usage.get("completion_tokens", 0) * pout) / 1e6
    with _spend_lock:
        try:
            data = json.loads(SPEND_FILE.read_text(encoding="utf-8")) if SPEND_FILE.exists() else {}
        except Exception:
            data = {}
        data["usd"] = round(float(data.get("usd", 0.0)) + usd, 6)
        data["calls"] = int(data.get("calls", 0)) + 1
        data["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        SPEND_FILE.parent.mkdir(parents=True, exist_ok=True)
        SPEND_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return usd


# ── providers ───────────────────────────────────────────────────────────────

def _providers() -> list[str]:
    order = [p.strip() for p in os.getenv("SCORESHEET_READERS", "deepseek,ollama").split(",") if p.strip()]
    ok = []
    for p in order:
        if p == "deepseek" and os.getenv("DEEPSEEK_API_KEY"):
            ok.append(p)
        if p == "ollama" and os.getenv("VLM_OCR_BASE"):
            ok.append(p)
    return ok


def available() -> bool:
    return bool(_providers())


def _chat(provider: str, prompt: str, jpeg: bytes, max_tokens: int = 2500,
          temperature: float = 0.0) -> tuple[str, dict]:
    url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
    content = [{"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": url}}]
    if provider == "deepseek":
        if _over_budget():
            raise ReaderError("OCR spend limit reached (OCR_SPEND_LIMIT_USD)")
        base, key = "https://api.deepseek.com", os.environ["DEEPSEEK_API_KEY"]
        model = os.getenv("SCORESHEET_DEEPSEEK_MODEL", "deepseek-flash")
        extra = {"thinking": {"type": "disabled"}}     # thinking burns ~4k tokens and reads no better
        timeout = 90
    else:
        base, key = os.environ["VLM_OCR_BASE"].rstrip("/"), os.getenv("VLM_OCR_KEY", "")
        model = os.getenv("VLM_OCR_MODEL", "qwen3-vl:2b")
        extra = {"keep_alive": os.getenv("VLM_OCR_KEEP_ALIVE", "30m")}
        timeout = float(os.getenv("VLM_OCR_TIMEOUT", "600"))
    body = {"model": model, "temperature": temperature, "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": content}],
            "response_format": {"type": "json_object"}, **extra}
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    for attempt in range(3):
        try:
            r = requests.post(f"{base}/chat/completions", json=body, headers=headers, timeout=timeout)
        except requests.RequestException as exc:
            if attempt == 2:
                raise ReaderError(f"{provider}: {type(exc).__name__}") from exc
            time.sleep(1.5 * (attempt + 1))
            continue
        if r.status_code == 400 and "response_format" in body:
            body.pop("response_format")
            continue
        if r.status_code in (429, 500, 502, 503) and attempt < 2:
            time.sleep(2.0 * (attempt + 1))
            continue
        if not r.ok:
            raise ReaderError(f"{provider}: HTTP {r.status_code} {r.text[:200]}")
        j = r.json()
        usage = j.get("usage") or {}
        _record(provider, usage)
        return j["choices"][0]["message"].get("content") or "", usage
    raise ReaderError(f"{provider}: no response")


def parse_rows(text: str) -> list[dict]:
    """Tolerant JSON -> [{number, white, black, white_alt, black_alt}]."""
    text = re.sub(r"^```(?:json)?|```$", "", (text or "").strip(), flags=re.M)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        return []
    try:
        obj = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return []
    rows = obj.get("rows") or obj.get("moves") or []
    out = []
    for i, r in enumerate(rows, start=1):
        if not isinstance(r, dict):
            continue
        try:
            n = int(r.get("n", r.get("number", i)))
        except (TypeError, ValueError):
            continue
        w = str(r.get("w", r.get("white", "")) or "").strip()
        b = str(r.get("b", r.get("black", "")) or "").strip()
        alt = lambda k: [str(a).strip() for a in (r.get(k) or []) if str(a).strip()] if isinstance(r.get(k), list) else (
            [str(r.get(k)).strip()] if r.get(k) else [])
        if not (w or b):
            continue
        out.append({"number": n, "white": w, "black": b, "white_alt": alt("w_alt"), "black_alt": alt("b_alt")})
    return out


def parse_meta(text: str) -> dict:
    """Header fields (players, result, event, date) if the model returned them."""
    text = text or ""
    start, end = text.find("{"), text.rfind("}")
    try:
        meta = json.loads(text[start:end + 1]).get("meta") or {}
    except (json.JSONDecodeError, ValueError, AttributeError):
        return {}
    if not isinstance(meta, dict):
        return {}
    keep = {k: str(v).strip()[:80] for k, v in meta.items()
            if k in ("white", "black", "result", "event", "date") and v and str(v).strip()}
    if keep.get("result") not in (None, "1-0", "0-1", "1/2-1/2"):
        keep.pop("result")
    return keep


def _vote_key(s: str) -> str:
    return re.sub(r"[\s+#!?]", "", s or "").replace("0-0-0", "O-O-O").replace("0-0", "O-O")


def merge_reads(passes: list[list[dict]]) -> list[dict]:
    """Combine independent passes per row by voting. Each cell keeps every reading
    with its vote count ({side}_votes) -- unanimous cells are trustworthy, split
    votes become weighted alternatives the decoder flags -- and the most-voted
    reading (ties: the earliest pass) is primary. A pass that saw the cell blank
    votes for "". Model-suggested alternatives are kept as low-weight extras."""
    numbers = sorted({r["number"] for rows in passes for r in rows})
    by_pass = [{r["number"]: r for r in rows} for rows in passes]
    out = []
    for n in numbers:
        row: dict = {"number": n}
        for k in ("white", "black"):
            votes: dict[str, int] = {}
            first: dict[str, int] = {}
            alts: list[str] = []
            for pi, bp in enumerate(by_pass):
                r = bp.get(n)
                v = _vote_key(r[k]) if r else ""
                votes[v] = votes.get(v, 0) + 1
                first.setdefault(v, pi)
                for a in (r or {}).get(f"{k}_alt", []):
                    if _vote_key(a) and _vote_key(a) not in alts:
                        alts.append(_vote_key(a))
            ranked = sorted(votes, key=lambda v: (-votes[v], v == "", first[v]))
            primary = ranked[0] if ranked else ""
            row[k] = primary
            row[f"{k}_votes"] = [[v, c] for v, c in sorted(votes.items(), key=lambda t: -t[1]) if v]
            row[f"{k}_alt"] = [v for v in ranked[1:] if v] + [a for a in alts if a not in votes]
        row["passes"] = len(passes)
        if row["white"] or row["black"]:
            out.append(row)
    return out


PROMPT_VERIFY = (
    "This is part of a handwritten chess scoresheet (printed move numbers, then White's cell, then "
    "Black's cell). For each question below, look ONLY at the given row and side, and say what is "
    "written there. Pick the option that matches the ink. If none matches, set choice to \"other\" and "
    "copy what is written in \"text\". If the cell is blank, set choice to \"blank\". Judge the "
    "handwriting, not which move would be good chess.\n"
    "Questions:\n{questions}\n"
    "Return JSON only: {{\"answers\":[{{\"id\":0,\"choice\":\"Bd6\",\"text\":\"Bd6\"}}, ...]}}"
)


PROOF_CHUNK = 36   # questions per call


def proofread(image_bytes: bytes, groups: dict[str, list[dict]], provider: str | None = None,
              cache: bool = False) -> dict[int, dict]:
    """Multiple-choice proofreading of decoded moves, each question asked against the
    image band its row was read from ("full" = whole page).
    groups: {band name | "full": [{id, row, side, options}]}. Returns {id: {"choice", "text"}}."""
    prov = provider or (_providers() or [None])[0]
    if prov is None or not any(groups.values()):
        return {}
    images: dict[str, bytes] = {"full": to_jpeg(prep_image(image_bytes))}
    if any(k != "full" for k in groups):
        images.update({n: to_jpeg(t) for n, t in band_tiles(prep_image(image_bytes, 3200))})

    def ask(jpeg: bytes, qs: list[dict]) -> dict[int, dict]:
        lines = "\n".join(f'- id {q["id"]}: row {q["row"]}, {q["side"]}\'s cell. Options: '
                          + ", ".join(q["options"]) for q in qs)
        prompt = PROMPT_VERIFY.format(questions=lines)
        key = _cache_key(prov, "p", jpeg, prompt)
        path = CACHE_DIR / f"{key}.json"
        if cache and path.exists():
            text = json.loads(path.read_text(encoding="utf-8"))["text"]
        else:
            text, _ = _chat(prov, prompt, jpeg, max_tokens=2500)
            if cache:
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({"text": text}), encoding="utf-8")
        start, end = text.find("{"), text.rfind("}")
        try:
            answers = json.loads(text[start:end + 1]).get("answers", [])
        except (json.JSONDecodeError, ValueError, AttributeError):
            return {}
        out = {}
        for a in answers if isinstance(answers, list) else []:
            try:
                out[int(a.get("id"))] = {"choice": str(a.get("choice", "")).strip(),
                                         "text": str(a.get("text", "")).strip()}
            except (TypeError, ValueError, AttributeError):
                continue
        return out

    jobs = [(images.get(g, images["full"]), qs[i:i + PROOF_CHUNK])
            for g, qs in groups.items() for i in range(0, len(qs), PROOF_CHUNK)]
    import concurrent.futures as cf
    result: dict[int, dict] = {}
    with cf.ThreadPoolExecutor(min(8, len(jobs))) as ex:
        for f in [ex.submit(ask, jpeg, qs) for jpeg, qs in jobs]:
            try:
                result.update(f.result())
            except ReaderError as exc:
                log.warning("proofreading call failed: %s", exc)
    return result


def verify_cells(image_bytes: bytes, questions: list[dict], left_max_row: int | None,
                 provider: str | None = None, cache: bool = False) -> dict[int, dict]:
    """Targeted re-read of doubtful cells. questions: [{id, row, side, options}].
    Asks the column tile that holds each row (one concurrent call per tile).
    Returns {id: {"choice", "text"}}."""
    if not questions:
        return {}
    prov = provider or (_providers() or [None])[0]
    if prov is None:
        return {}
    if left_max_row is None:            # no column split known: ask about the whole page
        left, right = prep_image(image_bytes), None
    else:
        left, right = column_tiles(prep_image(image_bytes, 2800))
    groups: dict[str, list[dict]] = {"left": [], "right": []}
    for q in questions:
        side = "left" if left_max_row is None or q["row"] <= left_max_row else "right"
        groups[side].append(q)

    def ask(tile, qs: list[dict]) -> dict[int, dict]:
        lines = "\n".join(f'- id {q["id"]}: row {q["row"]}, {q["side"]}\'s cell. Options: '
                          + ", ".join(q["options"]) for q in qs)
        prompt = PROMPT_VERIFY.format(questions=lines)
        jpeg = to_jpeg(tile)
        key = _cache_key(prov, "v", jpeg, prompt)
        path = CACHE_DIR / f"{key}.json"
        if cache and path.exists():
            text = json.loads(path.read_text(encoding="utf-8"))["text"]
        else:
            text, _ = _chat(prov, prompt, jpeg, max_tokens=1500)
            if cache:
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({"text": text}), encoding="utf-8")
        start, end = text.find("{"), text.rfind("}")
        try:
            answers = json.loads(text[start:end + 1]).get("answers", [])
        except (json.JSONDecodeError, ValueError, AttributeError):
            return {}
        out = {}
        for a in answers:
            try:
                out[int(a.get("id"))] = {"choice": str(a.get("choice", "")).strip(), "text": str(a.get("text", "")).strip()}
            except (TypeError, ValueError):
                continue
        return out

    import concurrent.futures as cf
    result: dict[int, dict] = {}
    with cf.ThreadPoolExecutor(2) as ex:
        futs = [ex.submit(ask, tile, qs) for tile, qs in ((left, groups["left"]), (right, groups["right"])) if qs]
        for f in futs:
            try:
                result.update(f.result())
            except ReaderError as exc:
                log.warning("verification pass failed: %s", exc)
    return result


def _cache_key(provider: str, mode: str, jpeg: bytes, prompt: str) -> str:
    h = hashlib.sha1(jpeg + prompt.encode()).hexdigest()[:20]
    return f"{provider}_{mode}_{h}"


def read_sheet(image_bytes: bytes, passes: str | None = None, provider: str | None = None,
               cache: bool = False, samples: int | None = None) -> dict:
    """Read one scoresheet image. Returns {rows, passes, provider, raw, usage, left_max, meta}.

    `samples` > 1 repeats the passes at temperature 0.7 so cells can vote: where the
    reads agree the cell is trustworthy, where they split it is flagged."""
    provs = [provider] if provider else _providers()
    if not provs:
        raise ReaderError("No scoresheet reader configured (set DEEPSEEK_API_KEY or VLM_OCR_BASE).")
    mode = passes or os.getenv("SCORESHEET_PASSES", "full+bands")
    n_samples = max(1, int(samples or os.getenv("SCORESHEET_SAMPLES", "1")))
    img = prep_image(image_bytes)
    full_jpeg = to_jpeg(img)
    tiles = [to_jpeg(t) for t in column_tiles(prep_image(image_bytes, 2800))] if mode in ("tiles", "full+tiles") else []
    bands = [(n, to_jpeg(t)) for n, t in band_tiles(prep_image(image_bytes, 3200))] if mode in ("bands", "full+bands") else []
    last_err: Exception | None = None
    for prov in provs:
        try:
            usage_total = {"prompt_tokens": 0, "completion_tokens": 0}

            def run(prompt: str, jpeg: bytes, temp: float) -> tuple[list[dict], str]:
                key = _cache_key(prov, f"x{temp}" if temp else "x", jpeg, prompt + (f"#t{temp}" if temp else ""))
                path = CACHE_DIR / f"{key}.json"
                if cache and path.exists():
                    text = json.loads(path.read_text(encoding="utf-8"))["text"]
                else:
                    text, usage = _chat(prov, prompt, jpeg, temperature=temp)
                    for k in usage_total:
                        usage_total[k] += usage.get(k, 0) or 0
                    if cache:
                        CACHE_DIR.mkdir(parents=True, exist_ok=True)
                        path.write_text(json.dumps({"text": text}), encoding="utf-8")
                return parse_rows(text), text

            # Every pass is an independent view of the sheet; they all run concurrently,
            # so latency stays about one call. Column tiles are cut from a higher-resolution
            # image (more pixels per row = fewer row slips and less guessing from theory).
            import concurrent.futures as cf
            plan: list[tuple[str, str, bytes, float]] = []
            for s in range(n_samples):
                temp = 0.0 if s == 0 else 0.7
                if mode in ("full", "full+tiles", "full+bands"):
                    plan.append(("full", PROMPT_FULL, full_jpeg, temp))
                if tiles:
                    plan += [("left", PROMPT_TILE_LEFT, tiles[0], temp), ("right", PROMPT_TILE_RIGHT, tiles[1], temp)]
                if bands:
                    plan += [(f"band:{n}", PROMPT_BAND, jpeg, temp) for n, jpeg in bands]
            with cf.ThreadPoolExecutor(min(8, len(plan))) as ex:
                outs = list(ex.map(lambda t: run(t[1], t[2], t[3]), plan))
            raws = [t for _, t in outs]
            results: list[list[dict]] = []
            left_max = None
            band_rows: dict[str, list[int]] | None = None
            i = 0
            while i < len(plan):
                kind = plan[i][0]
                if kind == "full":
                    results.append(outs[i][0])
                    i += 1
                elif kind.startswith("band:"):          # four bands -> one pass (overlap rows: first band wins)
                    merged: dict[int, dict] = {}
                    for k in range(4):
                        for r in outs[i + k][0]:
                            cur = merged.get(r["number"])
                            if cur is None or not (cur["white"] or cur["black"]):
                                merged[r["number"]] = r
                    lnums = [r["number"] for k in (0, 1) for r in outs[i + k][0]]
                    left_max = left_max or (max(lnums) if lnums else None)
                    if band_rows is None:              # which rows each band shows (for proofreading)
                        band_rows = {plan[i + k][0][5:]: sorted({r["number"] for r in outs[i + k][0]})
                                     for k in range(4)}
                    results.append([merged[n] for n in sorted(merged)])
                    i += 4
                else:                                  # left + right tile -> one pass
                    lrows, rrows = outs[i][0], outs[i + 1][0]
                    top = max([r["number"] for r in lrows] + [0])
                    left_max = left_max or (top or None)
                    results.append(sorted(lrows + [r for r in rrows if r["number"] > top], key=lambda r: r["number"]))
                    i += 2
            rows = merge_reads(results)
            return {"rows": rows, "passes": [len(r) for r in results], "provider": prov,
                    "raw": "\n---\n".join(raws), "usage": usage_total, "left_max": left_max, "band_rows": band_rows,
                    "meta": parse_meta(raws[0]) if raws else {}}
        except ReaderError as exc:
            log.warning("scoresheet reader %s failed: %s", prov, exc)
            last_err = exc
    raise ReaderError(str(last_err) if last_err else "no reader succeeded")
