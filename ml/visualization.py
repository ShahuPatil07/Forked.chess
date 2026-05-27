"""
Visualization for Stage-1 pipeline output.

plot_eval_curve_for_game()   — eval_before / eval_after / eval_drop per move
                                for a single annotated game, with mistake
                                markers and best-move annotations.

plot_mistake_overview()      — aggregate dashboard across all mistakes for a user:
                                • threat-type distribution
                                • eval-drop histogram
                                • game-phase breakdown
                                • eval-drop over move-number scatter
"""
from __future__ import annotations

from typing import Optional

import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

from ml.ingestion.annotator import PositionAnnotation
from ml.ingestion.mistake_extractor import MistakeEvent


# ---------------------------------------------------------------------------
# Colour palette
# ---------------------------------------------------------------------------
C_EVAL_BEFORE  = "#4C72B0"   # blue
C_EVAL_AFTER   = "#55A868"   # green
C_EVAL_DROP    = "#C44E52"   # red
C_BEST         = "#DD8452"   # orange
C_MISTAKE_MARK = "#C44E52"
C_BG           = "#F8F8F8"
C_GRID         = "#E0E0E0"

PHASE_COLORS = {
    "opening":    "#5DA5DA",
    "middlegame": "#FAA43A",
    "endgame":    "#60BD68",
}

THREAT_COLORS = {
    "back_rank":   "#E05C5C",
    "fork":        "#E8A838",
    "pin":         "#5C8DE0",
    "king_attack": "#C44EAA",
    "passed_pawn": "#55A868",
    "other":       "#AAAAAA",
}


def _clamp_cp(val: int, cap: int = 500) -> int:
    """Clamp centipawn values so extreme mate scores don't blow up axes."""
    return max(-cap, min(cap, val))


# ---------------------------------------------------------------------------
# Single-game eval curve
# ---------------------------------------------------------------------------

def plot_eval_curve_for_game(
    annotations: list[PositionAnnotation],
    game_meta:   Optional[dict] = None,
    save_path:   Optional[str]  = None,
) -> None:
    """
    Three-panel plot for a single annotated game:
      Panel 1 — eval_before vs eval_after (centipawn lines)
      Panel 2 — eval_drop per move (bar chart, mistakes highlighted)
      Panel 3 — best-move eval vs played-move eval (scatter / step)
    """
    if not annotations:
        print("No annotations to plot.")
        return

    moves     = [a.move_number + (0 if a.is_white_move else 0.5) for a in annotations]
    ev_before = [_clamp_cp(a.eval_before_cp) for a in annotations]
    ev_after  = [_clamp_cp(a.eval_after_cp)  for a in annotations]
    ev_drop   = [_clamp_cp(a.eval_drop_cp, cap=800) for a in annotations]
    best_eval = [_clamp_cp(a.best_move_eval_cp) for a in annotations]

    mistake_mask = [a.eval_drop_cp >= 50 for a in annotations]

    fig, axes = plt.subplots(3, 1, figsize=(14, 12), facecolor=C_BG)
    fig.subplots_adjust(hspace=0.45)

    title = "Eval curve"
    if game_meta:
        w = game_meta.get("white_username", "?")
        b = game_meta.get("black_username", "?")
        we = game_meta.get("white_elo", "")
        be = game_meta.get("black_elo", "")
        tc = game_meta.get("time_control", "")
        title = f"{w} ({we}) vs {b} ({be})  ·  {tc}"
    fig.suptitle(title, fontsize=13, fontweight="bold", y=0.98)

    # ── Panel 1: eval_before vs eval_after ───────────────────────────────
    ax1 = axes[0]
    ax1.set_facecolor(C_BG)
    ax1.axhline(0, color="#999", linewidth=0.8, linestyle="--")
    ax1.fill_between(moves, ev_before, 0,
                     where=[v > 0 for v in ev_before],
                     alpha=0.12, color=C_EVAL_BEFORE)
    ax1.fill_between(moves, ev_before, 0,
                     where=[v < 0 for v in ev_before],
                     alpha=0.12, color=C_EVAL_DROP)
    ax1.plot(moves, ev_before, color=C_EVAL_BEFORE, linewidth=1.8,
             label="eval_before (mover's perspective)")
    ax1.plot(moves, ev_after,  color=C_EVAL_AFTER,  linewidth=1.8,
             linestyle="--", label="eval_after")

    # Mark mistakes
    mx = [moves[i] for i, m in enumerate(mistake_mask) if m]
    my = [ev_before[i] for i, m in enumerate(mistake_mask) if m]
    ax1.scatter(mx, my, color=C_MISTAKE_MARK, zorder=5, s=60,
                label="Mistake (≥50 cp drop)", marker="v")

    ax1.set_ylabel("Centipawns", fontsize=10)
    ax1.set_title("Evaluation before vs after each move", fontsize=10)
    ax1.legend(fontsize=8, loc="upper right")
    ax1.grid(color=C_GRID, linewidth=0.6)
    ax1.set_ylim(-520, 520)

    # ── Panel 2: eval_drop bar chart ──────────────────────────────────────
    ax2 = axes[1]
    ax2.set_facecolor(C_BG)
    bar_colors = [C_MISTAKE_MARK if m else "#AAAAAA" for m in mistake_mask]
    ax2.bar(moves, ev_drop, color=bar_colors, width=0.4, alpha=0.85)
    ax2.axhline(50, color=C_MISTAKE_MARK, linewidth=1, linestyle=":", label="50 cp threshold")

    # Annotate the best move on the top-3 blunders
    top3_idx = sorted(
        range(len(ev_drop)), key=lambda i: ev_drop[i], reverse=True
    )[:3]
    for i in top3_idx:
        if ev_drop[i] < 50:
            continue
        ax2.annotate(
            annotations[i].best_move_uci,
            xy=(moves[i], ev_drop[i]),
            xytext=(0, 6),
            textcoords="offset points",
            ha="center", fontsize=7, color=C_BEST,
        )

    ax2.set_ylabel("Eval drop (cp)", fontsize=10)
    ax2.set_title("Eval drop per move  (red bars = mistakes)", fontsize=10)
    ax2.legend(fontsize=8)
    ax2.grid(color=C_GRID, linewidth=0.6, axis="y")

    # ── Panel 3: best-move eval vs played-move eval ───────────────────────
    ax3 = axes[2]
    ax3.set_facecolor(C_BG)
    ax3.axhline(0, color="#999", linewidth=0.8, linestyle="--")
    ax3.step(moves, best_eval, color=C_BEST, linewidth=1.6, where="mid",
             label="best-move eval (what engine preferred)")
    ax3.step(moves, ev_before, color=C_EVAL_BEFORE, linewidth=1.2,
             linestyle="--", where="mid", alpha=0.7, label="eval_before (played)")

    # Shade the gap (missed opportunity)
    for i in range(len(moves)):
        if mistake_mask[i]:
            ax3.annotate(
                annotations[i].move_played_san,
                xy=(moves[i], ev_after[i]),
                xytext=(2, -12),
                textcoords="offset points",
                fontsize=6.5, color=C_EVAL_DROP,
                arrowprops=dict(arrowstyle="-", color=C_EVAL_DROP, lw=0.8),
            )

    ax3.set_xlabel("Move number", fontsize=10)
    ax3.set_ylabel("Centipawns", fontsize=10)
    ax3.set_title("Best-move eval vs played-move eval", fontsize=10)
    ax3.legend(fontsize=8, loc="upper right")
    ax3.grid(color=C_GRID, linewidth=0.6)
    ax3.set_ylim(-520, 520)

    plt.tight_layout(rect=[0, 0, 1, 0.96])

    if save_path:
        plt.savefig(save_path, dpi=150, bbox_inches="tight")
        print(f"Saved eval-curve plot to {save_path}")
    else:
        plt.show()

    plt.close(fig)


# ---------------------------------------------------------------------------
# Multi-game mistake overview
# ---------------------------------------------------------------------------

def plot_mistake_overview(
    mistakes:  list[MistakeEvent],
    username:  str = "",
    save_path: Optional[str] = None,
) -> None:
    """
    Four-panel dashboard summarising all mistake events for a user:
      1 — Threat-type bar chart
      2 — Eval-drop histogram
      3 — Game-phase pie chart
      4 — Eval-drop vs move-number scatter (coloured by threat type)
    """
    if not mistakes:
        print("No mistakes to visualise.")
        return

    from collections import Counter

    threat_counts = Counter(m.threat_type  for m in mistakes)
    phase_counts  = Counter(m.game_phase   for m in mistakes)
    ev_drops      = [_clamp_cp(m.eval_drop_cp, cap=800) for m in mistakes]
    move_numbers  = [m.move_number for m in mistakes]
    threat_types  = [m.threat_type for m in mistakes]

    fig, axes = plt.subplots(2, 2, figsize=(14, 10), facecolor=C_BG)
    fig.suptitle(
        f"Mistake overview — {username}  ({len(mistakes)} events)",
        fontsize=14, fontweight="bold",
    )

    # ── 1. Threat-type bar chart ──────────────────────────────────────────
    ax = axes[0, 0]
    ax.set_facecolor(C_BG)
    labels  = list(threat_counts.keys())
    counts  = [threat_counts[l] for l in labels]
    colors  = [THREAT_COLORS.get(l, "#AAAAAA") for l in labels]
    bars    = ax.barh(labels, counts, color=colors, edgecolor="white", linewidth=0.5)
    for bar, count in zip(bars, counts):
        ax.text(bar.get_width() + 0.5, bar.get_y() + bar.get_height() / 2,
                str(count), va="center", fontsize=9)
    ax.set_xlabel("Number of mistakes", fontsize=10)
    ax.set_title("Mistakes by threat type", fontsize=11)
    ax.grid(color=C_GRID, linewidth=0.6, axis="x")

    # ── 2. Eval-drop histogram ────────────────────────────────────────────
    ax = axes[0, 1]
    ax.set_facecolor(C_BG)
    ax.hist(ev_drops, bins=30, color=C_EVAL_DROP, edgecolor="white",
            linewidth=0.5, alpha=0.85)
    ax.axvline(np.mean(ev_drops), color=C_BEST, linewidth=1.5,
               linestyle="--", label=f"Mean: {np.mean(ev_drops):.0f} cp")
    ax.axvline(np.median(ev_drops), color=C_EVAL_BEFORE, linewidth=1.5,
               linestyle=":", label=f"Median: {np.median(ev_drops):.0f} cp")
    ax.set_xlabel("Eval drop (centipawns)", fontsize=10)
    ax.set_ylabel("Frequency", fontsize=10)
    ax.set_title("Eval-drop distribution", fontsize=11)
    ax.legend(fontsize=9)
    ax.grid(color=C_GRID, linewidth=0.6)

    # ── 3. Game-phase pie ─────────────────────────────────────────────────
    ax = axes[1, 0]
    ax.set_facecolor(C_BG)
    phase_labels = list(phase_counts.keys())
    phase_vals   = [phase_counts[p] for p in phase_labels]
    phase_cols   = [PHASE_COLORS.get(p, "#AAAAAA") for p in phase_labels]
    wedges, texts, autotexts = ax.pie(
        phase_vals,
        labels=phase_labels,
        colors=phase_cols,
        autopct="%1.1f%%",
        startangle=140,
        textprops={"fontsize": 10},
    )
    for at in autotexts:
        at.set_fontsize(9)
    ax.set_title("Mistakes by game phase", fontsize=11)

    # ── 4. Eval-drop vs move-number scatter ───────────────────────────────
    ax = axes[1, 1]
    ax.set_facecolor(C_BG)
    for threat in set(threat_types):
        idx = [i for i, t in enumerate(threat_types) if t == threat]
        ax.scatter(
            [move_numbers[i] for i in idx],
            [ev_drops[i]     for i in idx],
            color=THREAT_COLORS.get(threat, "#AAAAAA"),
            label=threat, alpha=0.65, s=35, edgecolors="white", linewidths=0.3,
        )
    ax.axhline(50, color="#999", linewidth=0.8, linestyle="--", label="50 cp threshold")
    ax.set_xlabel("Move number", fontsize=10)
    ax.set_ylabel("Eval drop (centipawns)", fontsize=10)
    ax.set_title("Eval drop vs move number (by threat type)", fontsize=11)
    ax.legend(fontsize=8, loc="upper right", ncol=2)
    ax.grid(color=C_GRID, linewidth=0.6)

    # Legend patches for threat types
    legend_patches = [
        mpatches.Patch(color=THREAT_COLORS.get(t, "#AAAAAA"), label=t)
        for t in THREAT_COLORS
    ]
    fig.legend(
        handles=legend_patches,
        loc="lower center", ncol=len(legend_patches),
        fontsize=9, frameon=False,
        bbox_to_anchor=(0.5, -0.02),
    )

    plt.tight_layout(rect=[0, 0.03, 1, 0.95])

    if save_path:
        plt.savefig(save_path, dpi=150, bbox_inches="tight")
        print(f"Saved overview plot to {save_path}")
    else:
        plt.show()

    plt.close(fig)
