"""
Maia2 annotation — estimates the human probability of the engine's best move.

Positions where even strong humans rarely play the engine's best move
(maia2_prob_best < MAIA2_MIN_PROB_BEST) are "universally hard" and should
be filtered out of the blindspot corpus: they're not a personal weakness,
they're objectively difficult positions that most players would miss.

Requires the `maia2` package:  pip install maia2
Falls back gracefully when the package is unavailable.

Actual maia2 API (v0.9):
  model  = maia2.model.from_pretrained(type="rapid", device="cpu")
  prepared = maia2.inference.prepare()   # lookup tables, call once
  move_probs, win_prob = maia2.inference.inference_each(model, prepared, fen, elo_self, elo_oppo)
  # move_probs: dict[uci_str -> float probability]
"""
from __future__ import annotations

import logging
import math

log = logging.getLogger(__name__)

MAIA2_AVAILABLE = False
_model_cache    = None
_prepared_cache = None


def _check_maia2() -> bool:
    global MAIA2_AVAILABLE
    try:
        import maia2.model     # noqa: F401
        import maia2.inference # noqa: F401
        MAIA2_AVAILABLE = True
    except ImportError:
        MAIA2_AVAILABLE = False
    return MAIA2_AVAILABLE


_check_maia2()


class MaiaAnnotator:
    """Wraps the Maia2 model for batch annotation of MistakeEvent objects."""

    def __init__(self, device: str = "cpu"):
        global _model_cache, _prepared_cache
        if not MAIA2_AVAILABLE:
            raise ImportError(
                "maia2 package not found. Install with: pip install maia2"
            )
        if _model_cache is None:
            import maia2.model as maia2_model
            import maia2.inference as maia2_inf
            log.info("Loading Maia2 model (rapid, %s)...", device)
            _model_cache    = maia2_model.from_pretrained(type="rapid", device=device)
            _prepared_cache = maia2_inf.prepare()
            log.info("Maia2 model loaded.")
        self._model    = _model_cache
        self._prepared = _prepared_cache

    def annotate_mistake(
        self,
        fen: str,
        move_played_uci: str,
        best_move_uci: str,
        elo_self: int = 1500,
        elo_oppo: int = 1500,
    ) -> dict:
        """
        Returns:
          maia2_prob_best   — probability Maia2 plays the engine's best move
          maia2_prob_played — probability Maia2 plays the user's actual move
          maia2_surprise    — log(prob_best / prob_played) — how surprising the miss was
          maia2_difficulty  — 1 - prob_best (position difficulty for humans)

        Returns None values on inference failure (event is still kept).
        """
        try:
            import maia2.inference as maia2_inf
            move_probs, _win_prob = maia2_inf.inference_each(
                self._model, self._prepared, fen, elo_self, elo_oppo
            )
            prob_best   = float(move_probs.get(best_move_uci, 1e-6))
            prob_played = float(move_probs.get(move_played_uci, 1e-6))
            prob_best   = max(prob_best, 1e-6)
            prob_played = max(prob_played, 1e-6)
            surprise    = math.log(prob_best / prob_played)
            difficulty  = 1.0 - prob_best
            return {
                "maia2_prob_best":   prob_best,
                "maia2_prob_played": prob_played,
                "maia2_surprise":    surprise,
                "maia2_difficulty":  difficulty,
            }
        except Exception as exc:
            log.debug("Maia2 inference failed for FEN %s: %s", fen, exc)
            return {
                "maia2_prob_best":   None,
                "maia2_prob_played": None,
                "maia2_surprise":    None,
                "maia2_difficulty":  None,
            }

    def annotate_batch(
        self,
        mistake_events,   # list[MistakeEvent]
        elo_self: int = 1500,
        elo_oppo: int = 1500,
    ):
        """
        Annotate MistakeEvent objects in-place with maia2_* fields.
        Continues on per-event errors (failed events keep None values).
        Returns the same list.
        """
        for event in mistake_events:
            try:
                result = self.annotate_mistake(
                    fen=event.fen,
                    move_played_uci=event.move_played_uci,
                    best_move_uci=event.best_move_uci,
                    elo_self=elo_self,
                    elo_oppo=elo_oppo,
                )
                event.maia2_prob_best   = result["maia2_prob_best"]
                event.maia2_prob_played = result["maia2_prob_played"]
                event.maia2_surprise    = result["maia2_surprise"]
                event.maia2_difficulty  = result["maia2_difficulty"]
            except Exception as exc:
                log.debug("Maia2 batch annotation failed for event: %s", exc)
        return mistake_events
