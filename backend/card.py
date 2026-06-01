"""
Feature 5 + Chess DNA — shareable profile card (PNG).

The card combines two pieces of self-knowledge from the user's own games:
  • Chess DNA  — playing-style archetype + 5 axis bars  (left panel)
  • Blindspots — recurring weakness clusters + rating impact (right panel)

Endpoints (prefix /api/profile):
  POST /{username}/compute-style  → run + cache style profile
  GET  /{username}/style          → cached style profile (404 if absent)
  GET  /{username}/dna-card       → 1200×630 DNA card PNG (cached)
  GET  /{username}/card           → legacy alias → DNA card

Style labels are pulled from the current profile at render time (a snapshot).
"""
from __future__ import annotations

import io
import json
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ml.config import DATA_DIR
from ml.style.extractor import (
    compute_style, load_style, ARCHETYPE_DESCRIPTIONS,
)

log = logging.getLogger("forked.card")

router = APIRouter(prefix="/api/profile")

OUTPUT_DIR = DATA_DIR / "output"

W, H = 1200, 630
BG        = (15, 15, 20)
PANEL     = (22, 22, 32)
ACCENT    = (124, 106, 247)
ACCENT_2  = (167, 139, 250)
TEXT_0    = (238, 238, 242)
TEXT_1    = (150, 150, 176)
TEXT_2    = (96, 96, 122)
SUCCESS   = (13, 201, 127)
BAR_BG    = (38, 38, 56)


def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _font(size: int, bold: bool = False):
    from PIL import ImageFont
    candidates = (
        ["arialbd.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf"] if bold
        else ["arial.ttf", "Arial.ttf", "DejaVuSans.ttf"]
    )
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    try:
        return ImageFont.truetype("DejaVuSans.ttf", size)
    except Exception:
        return ImageFont.load_default()


def _rounded(draw, xy, radius, fill):
    draw.rounded_rectangle(xy, radius=radius, fill=fill)


# ── Axis spectrum labels (per the card spec) ───────────────────────────────────

def _axis_label(axis: int, score) -> str:
    if score is None:
        return "—"
    if axis == 1: return "Tactical"    if score > 50 else "Positional"
    if axis == 2: return "Aggressive"  if score > 50 else "Solid"
    if axis == 3: return "Risk-taker"  if score > 50 else "Conservative"
    if axis == 4: return "Middlegame"  if score > 50 else "Endgame"
    if axis == 5: return "Time calm"   if score >= 50 else "Time pressure"
    return ""


def _avatar(username: str, size: int):
    """Lichess avatar (if any) else a purple initial circle."""
    from PIL import Image, ImageDraw
    img = None
    try:
        import requests
        from ml.config import REQUEST_HEADERS
        r = requests.get(f"https://lichess.org/api/user/{username}",
                         headers=REQUEST_HEADERS, timeout=6)
        if r.status_code == 200:
            url = (r.json().get("profile", {}) or {}).get("image")
            if url:
                ir = requests.get(url, headers=REQUEST_HEADERS, timeout=6)
                if ir.status_code == 200:
                    img = Image.open(io.BytesIO(ir.content)).convert("RGBA").resize((size, size))
    except Exception:
        img = None

    if img is None:
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.ellipse([0, 0, size, size], fill=ACCENT)
        f = _font(int(size * 0.55), bold=True)
        ch = (username[:1] or "?").upper()
        tw = d.textlength(ch, font=f)
        try:
            asc, desc = f.getmetrics(); th = asc + desc
        except Exception:
            th = int(size * 0.55)
        d.text(((size - tw) / 2, (size - th) / 2), ch, font=f, fill=(255, 255, 255))
        return img

    # circular mask
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size, size], fill=255)
    img.putalpha(mask)
    return img


# ── Card render ────────────────────────────────────────────────────────────────

def _render_dna_card(username: str) -> bytes:
    from PIL import Image, ImageDraw

    clusters = _read_json(OUTPUT_DIR / f"{username}_clusters.json", None)
    if not clusters:
        raise HTTPException(404, "No blindspot profile found. Run analysis first.")

    settings = _read_json(OUTPUT_DIR / f"{username}_settings.json", {})
    elo      = settings.get("elo", 1500)
    cf       = _read_json(OUTPUT_DIR / f"{username}_counterfactual.json", {})
    total_gain = cf.get("total_gain", 0)
    potential  = cf.get("potential_rating", elo)
    style      = load_style(username) or compute_style(username)

    img  = Image.new("RGB", (W, H), BG)

    # accent glow corners
    for (cx, cy, rad, col, alpha) in [(150, 120, 280, ACCENT, 30), (1060, 540, 320, ACCENT_2, 22)]:
        glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(glow).ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=(*col, alpha))
        img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    draw = ImageDraw.Draw(img)

    f_brand = _font(30, bold=True)
    f_url   = _font(20)
    f_user  = _font(34, bold=True)
    f_panel = _font(20, bold=True)
    f_arch  = _font(46, bold=True)
    f_axis  = _font(22, bold=True)
    f_axisn = _font(22, bold=True)
    f_rank  = _font(22, bold=True)
    f_label = _font(23, bold=True)
    f_score = _font(22, bold=True)
    f_foot  = _font(22)
    f_small = _font(18)

    pad = 56

    # Avatar + brand
    av = _avatar(username, 48)
    img.paste(av, (pad, 40), av)
    draw = ImageDraw.Draw(img)
    draw.text((pad + 62, 48), "Forked", font=f_brand, fill=ACCENT)
    url = "forked.chess"
    draw.text((W - pad - draw.textlength(url, font=f_url), 52), url, font=f_url, fill=TEXT_2)

    # User line
    draw.text((pad, 104), f"{username} · {elo}", font=f_user, fill=TEXT_0)

    # ── Panels ──────────────────────────────────────────────────────────────
    panel_y  = 162
    panel_h  = 384
    gap      = 28
    panel_w  = (W - pad * 2 - gap) // 2
    lx, rx   = pad, pad + panel_w + gap
    _rounded(draw, [lx, panel_y, lx + panel_w, panel_y + panel_h], 18, PANEL)
    _rounded(draw, [rx, panel_y, rx + panel_w, panel_y + panel_h], 18, PANEL)

    # ── LEFT: Chess DNA ───────────────────────────────────────────────────────
    draw.text((lx + 28, panel_y + 22), "CHESS DNA", font=f_panel, fill=ACCENT_2)

    if style and not style.get("insufficient"):
        arch = style.get("archetype") or "—"
        aw = draw.textlength(arch, font=f_arch)
        draw.text((lx + (panel_w - aw) / 2, panel_y + 58), arch, font=f_arch, fill=ACCENT)

        axes = [style.get(f"axis{i}") for i in range(1, 6)]
        ax_x   = lx + 28
        ax_w   = panel_w - 56
        bar_x  = ax_x + 150
        bar_w  = ax_w - 150 - 44
        row_y  = panel_y + 138
        row_h  = 46
        for i, score in enumerate(axes, 1):
            y = row_y + (i - 1) * row_h
            draw.text((ax_x, y), _axis_label(i, score), font=f_axis, fill=TEXT_0)
            if score is None:
                draw.text((bar_x, y), "Not enough data", font=f_small, fill=TEXT_2)
                continue
            _rounded(draw, [bar_x, y + 2, bar_x + bar_w, y + 22], 10, BAR_BG)
            fw = max(12, int(bar_w * score / 100))
            _rounded(draw, [bar_x, y + 2, bar_x + fw, y + 22], 10, ACCENT)
            draw.text((bar_x + bar_w + 12, y), str(score), font=f_axisn, fill=TEXT_0)
    else:
        n_games = (style or {}).get("n_games", 0)
        msg1 = "Play 50+ games to unlock"
        msg2 = "your Chess DNA profile"
        draw.text((lx + (panel_w - draw.textlength(msg1, font=f_label)) / 2, panel_y + 150),
                  msg1, font=f_label, fill=TEXT_1)
        draw.text((lx + (panel_w - draw.textlength(msg2, font=f_label)) / 2, panel_y + 180),
                  msg2, font=f_label, fill=TEXT_1)
        sub = f"{n_games}/50 games analysed"
        draw.text((lx + (panel_w - draw.textlength(sub, font=f_small)) / 2, panel_y + 220),
                  sub, font=f_small, fill=TEXT_2)

    # ── RIGHT: Blindspots ───────────────────────────────────────────────────────
    draw.text((rx + 28, panel_y + 22), "BLINDSPOTS", font=f_panel, fill=ACCENT_2)
    top = clusters[:3]
    max_score = max((c.get("score", 0) for c in top), default=1) or 1
    bx = rx + 28
    bw = panel_w - 56
    label_w = 150
    bar_x = bx + 44 + label_w
    bar_w = bw - 44 - label_w - 38
    row_y = panel_y + 70
    row_h = 56
    for i, c in enumerate(top):
        y = row_y + i * row_h
        draw.text((bx, y + 2), f"#{i+1}", font=f_rank, fill=TEXT_2)
        label = str(c.get("label", f"Cluster {i+1}"))
        if len(label) > 16:
            label = label[:15] + "…"
        draw.text((bx + 44, y + 2), label, font=f_label, fill=TEXT_0)
        frac = (c.get("score", 0) / max_score) if max_score else 0
        score = int(round(frac * 99))
        _rounded(draw, [bar_x, y + 4, bar_x + bar_w, y + 24], 10, BAR_BG)
        _rounded(draw, [bar_x, y + 4, bar_x + max(10, int(bar_w * frac)), y + 24], 10, ACCENT)
        draw.text((bar_x + bar_w + 10, y + 2), str(score), font=f_score, fill=TEXT_0)

    # rating impact inside right panel
    iy = panel_y + 70 + 3 * row_h + 18
    if total_gain and total_gain > 0:
        draw.text((bx, iy), f"Fix all: +{total_gain} pts", font=f_label, fill=SUCCESS)
        draw.text((bx, iy + 34), f"Potential: {potential}", font=f_foot, fill=TEXT_0)
    else:
        draw.text((bx, iy), f"{len(clusters)} recurring patterns", font=f_foot, fill=TEXT_1)

    # Footer tagline
    draw.text((pad, H - 46), '"A coach who knows exactly how you lose"', font=f_foot, fill=TEXT_1)
    draw.text((W - pad - draw.textlength("forked.chess", font=f_foot), H - 46),
              "forked.chess", font=f_foot, fill=TEXT_2)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _card_is_fresh(username: str, cache_path: Path) -> bool:
    """Card is stale if clusters/style/counterfactual changed after it was built."""
    if not cache_path.exists():
        return False
    ct = cache_path.stat().st_mtime
    for dep in (f"{username}_clusters.json", f"{username}_style.json",
                f"{username}_counterfactual.json"):
        p = OUTPUT_DIR / dep
        if p.exists() and p.stat().st_mtime > ct:
            return False
    return True


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/{username}/compute-style")
def post_compute_style(username: str):
    if not (OUTPUT_DIR / f"{username}_mistakes.json").exists():
        raise HTTPException(404, "No analysis found. Run analysis first.")
    return compute_style(username)


@router.get("/{username}/style")
def get_style(username: str):
    s = load_style(username)
    if s is None:
        # Lazily compute if mistakes exist; else 404
        if (OUTPUT_DIR / f"{username}_mistakes.json").exists():
            s = compute_style(username)
        else:
            raise HTTPException(404, "Style profile not computed yet.")
    if s.get("archetype"):
        s = {**s, "description": ARCHETYPE_DESCRIPTIONS.get(s["archetype"], "")}
    return s


def _serve_card(username: str) -> Response:
    cache_path = OUTPUT_DIR / f"{username}_dna_card.png"
    if not (OUTPUT_DIR / f"{username}_clusters.json").exists():
        raise HTTPException(404, "No blindspot profile found. Run analysis first.")
    if _card_is_fresh(username, cache_path):
        data = cache_path.read_bytes()
    else:
        data = _render_dna_card(username)
        try:
            cache_path.write_bytes(data)
        except Exception:
            pass
    return Response(content=data, media_type="image/png")


@router.get("/{username}/dna-card")
def dna_card(username: str):
    return _serve_card(username)


@router.get("/{username}/card")
def profile_card(username: str):
    # Legacy alias — kept so existing links / the old share modal keep working.
    return _serve_card(username)
