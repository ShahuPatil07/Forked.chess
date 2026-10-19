#!/usr/bin/env python
"""
Inference wrapper for the Stage-1 Chessformer (Build #1).

Exposes, for a (fen, move_uci):
  - threat_type   : one of THREAT_TYPES (via ML_CLASS_TO_THREAT)
  - ml_class      : the raw 16-way Lichess class
  - confidence    : TEMPERATURE-CALIBRATED max softmax probability  [0,1]
  - ood_distance  : distance to the nearest tactical-class cluster in the SupCon
                    projection space (1 - max cosine sim). High = the position
                    looks UNLIKE any tactic the model learned -> likely positional.
  - is_positional : ood_distance > the fitted threshold

Why two numbers: softmax confidence answers "how sure among the 16 tactical
classes", which is a weak out-of-distribution signal (nets are confidently wrong
on inputs unlike training). The SupCon embedding distance is the stronger "is
this even tactical?" signal — that's what we use to flag positional mistakes.

Setup (one-time): fit the reference (class centroids + temperature) from the
cached token tensors:
    python experiments/stage1_transformer/predict.py --fit

Then:
    from experiments.stage1_transformer.predict import Predictor
    p = Predictor()
    p.predict("r1bqk.../...", "c4f7")   # -> dict
"""
from __future__ import annotations

import argparse
import logging
import pickle
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

import numpy as np
import torch
import torch.nn.functional as F

from ml.classifier.transformer.board_encoding import encode_position
from ml.classifier.transformer.model import ChessformerClassifier, ModelConfig
from ml.classifier.label_map import ML_LICHESS_CLASSES, ML_CLASS_TO_THREAT
from ml.classifier import label_map_v2 as v2
# NOTE: dataset/DataLoader are imported lazily inside fit_reference() so that
# production INFERENCE (Predictor) needs only board_encoding + model + label_map.

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

MODELS_DIR = Path(__file__).resolve().parents[3] / "models"
V1_CKPT = MODELS_DIR / "stage1_transformer.pt"
V1_REF  = MODELS_DIR / "stage1_reference.pkl"
V2_CKPT = MODELS_DIR / "stage1_transformer_v2.pt"
V2_REF  = MODELS_DIR / "stage1_reference_v2.pkl"
# Prefer the v2 multi-label model once it has been trained; v1 stays the fallback.
DEFAULT_CKPT = V2_CKPT if V2_CKPT.exists() else V1_CKPT
DEFAULT_REF  = V2_REF if V2_CKPT.exists() else V1_REF
N_CLASSES = len(ML_LICHESS_CLASSES)


def _load_model(ckpt: Path, with_blob: bool = False):
    blob = torch.load(ckpt, map_location="cpu", weights_only=False)
    cfg = ModelConfig(**blob["config"])
    model = ChessformerClassifier(cfg)
    model.load_state_dict(blob["state_dict"])
    model.eval()
    if cfg.proj_dim <= 0 and not blob.get("multilabel"):
        raise ValueError("Checkpoint has no SupCon projection head (proj_dim=0); "
                         "OOD scoring needs a model trained with --supcon-weight>0.")
    meta = {k: v for k, v in blob.items() if k != "state_dict"}
    return (model, cfg, meta) if with_blob else (model, cfg)


def _batch_to_dict(batch: dict) -> dict:
    return {k: v for k, v in batch.items()}


# ---------------------------------------------------------------------------
# Reference fitting (centroids + temperature)
# ---------------------------------------------------------------------------

@torch.no_grad()
def fit_reference(ckpt: Path = V1_CKPT, n_centroid: int = 20000,
                  n_temp: int = 8000, batch_size: int = 512) -> None:
    from torch.utils.data import DataLoader
    from ml.classifier.transformer.dataset import TokenDataset, collate
    model, cfg = _load_model(ckpt)
    log.info("Fitting reference from %s (proj_dim=%d)", ckpt.name, cfg.proj_dim)

    # ── Class centroids in the normalised projection space (from train) ──────
    train = TokenDataset("train", max_rows=n_centroid)
    loader = DataLoader(train, batch_size=batch_size, shuffle=False, collate_fn=collate)
    sums = torch.zeros(N_CLASSES, cfg.proj_dim)
    cnts = torch.zeros(N_CLASSES)
    id_dists = []                       # in-distribution distances for the threshold
    for batch in loader:
        z = F.normalize(model.proj(model.encode(batch)), dim=1)
        labels = batch["label"]
        for c in labels.unique():
            m = labels == c
            sums[c] += z[m].sum(0)
            cnts[c] += m.sum()
    centroids = torch.zeros(N_CLASSES, cfg.proj_dim)
    present = cnts > 0
    centroids[present] = F.normalize(sums[present] / cnts[present].unsqueeze(1), dim=1)

    # in-distribution OOD distances (to set a threshold)
    for batch in loader:
        z = F.normalize(model.proj(model.encode(batch)), dim=1)
        sim = z @ centroids[present].t()
        id_dists.append((1 - sim.max(1).values).numpy())
    id_dists = np.concatenate(id_dists)
    threshold = float(np.quantile(id_dists, 0.95))   # 95th pct of tactical positions

    # ── Temperature scaling on val ───────────────────────────────────────────
    val = TokenDataset("val", max_rows=n_temp)
    vloader = DataLoader(val, batch_size=batch_size, shuffle=False, collate_fn=collate)
    logits_all, labels_all = [], []
    for batch in vloader:
        logits_all.append(model.head(model.encode(batch)))
        labels_all.append(batch["label"])
    logits = torch.cat(logits_all)
    labels = torch.cat(labels_all)

    T = torch.nn.Parameter(torch.ones(1))
    opt = torch.optim.LBFGS([T], lr=0.05, max_iter=60)
    nll = torch.nn.CrossEntropyLoss()

    def closure():
        opt.zero_grad()
        loss = nll(logits / T.clamp(min=1e-2), labels)
        loss.backward()
        return loss
    opt.step(closure)
    temperature = float(T.detach().clamp(min=1e-2).item())

    ref = {
        "centroids": centroids.numpy(),
        "present": present.numpy(),
        "temperature": temperature,
        "threshold": threshold,
        "classes": list(ML_LICHESS_CLASSES),
    }
    with open(V1_REF, "wb") as fh:
        pickle.dump(ref, fh)
    log.info("Temperature %.3f | OOD threshold (95pct ID) %.3f | saved %s",
             temperature, threshold, V1_REF.name)


@torch.no_grad()
def _v2_logits(model, d: dict, bs: int = 512):
    from ml.classifier.transformer.train_mt import to_batch
    logits, zs = [], []
    for s0 in range(0, len(d["labels"]), bs):
        idx = np.arange(s0, min(s0 + bs, len(d["labels"])))
        emb = model.encode(to_batch(d, idx))
        logits.append(model.head(emb))
        if model.proj is not None:
            zs.append(F.normalize(model.proj(emb), dim=1))
    return torch.cat(logits), (torch.cat(zs) if zs else None)


def fit_reference_v2(ckpt: Path = V2_CKPT, out: Path = V2_REF, n: int = 12000) -> dict:
    """v2 (multi-label) reference: a sigmoid temperature fitted on val by BCE,
    plus class centroids in the projection space (rarest-label bucket) for an
    OOD distance. Reads data/processed/mt_val.npz (+ mt_neg.npz)."""
    from ml.classifier.transformer.train_mt import load_npz, concat, take
    from ml.config import DATA_DIR
    model, _cfg = _load_model(ckpt)
    val = load_npz("mt_val.npz")
    if (DATA_DIR / "processed" / "mt_neg.npz").exists():
        neg = load_npz("mt_neg.npz")
        val = concat(val, take(neg, np.arange(min(2000, len(neg["labels"])))))
    d = take(val, np.random.default_rng(1).permutation(len(val["labels"]))[:n])
    logits, z = _v2_logits(model, d)
    y = torch.from_numpy(d["labels"].astype(np.float32))

    T = torch.nn.Parameter(torch.ones(1))
    opt = torch.optim.LBFGS([T], lr=0.05, max_iter=80)
    bce = torch.nn.BCEWithLogitsLoss()

    def closure():
        opt.zero_grad()
        loss = bce(logits / T.clamp(min=0.05), y)
        loss.backward()
        return loss
    with torch.enable_grad():
        opt.step(closure)
    temperature = float(T.detach().clamp(min=0.05).item())

    ref = {"temperature": temperature, "classes": list(v2.MOTIF_CLASSES), "multilabel": True}
    if z is not None:
        bucket = np.array([v2.CLASS_INDEX[v2.rarest([v2.MOTIF_CLASSES[j] for j in np.flatnonzero(row)]) or "none"]
                           for row in d["labels"]])
        cents = torch.zeros(v2.N_CLASSES, z.shape[1])
        present = np.zeros(v2.N_CLASSES, dtype=bool)
        for c in range(v2.N_CLASSES):
            m = bucket == c
            if c != v2.NONE_INDEX and m.sum() >= 20:
                cents[c] = F.normalize(z[torch.from_numpy(m)].mean(0), dim=0)
                present[c] = True
        sim = z @ cents[torch.from_numpy(present)].t()
        dist = (1 - sim.max(1).values).numpy()
        ref.update({"centroids": cents.numpy(), "present": present,
                    "threshold": float(np.quantile(dist[bucket != v2.NONE_INDEX], 0.95))})
    with open(out, "wb") as fh:
        pickle.dump(ref, fh)
    log.info("v2 reference: temperature %.3f -> %s", temperature, out.name)
    return ref


# ---------------------------------------------------------------------------
# Predictor
# ---------------------------------------------------------------------------

class Predictor:
    def __init__(self, ckpt: Path = DEFAULT_CKPT, ref: Path = DEFAULT_REF):
        self.model, self.cfg, meta = _load_model(ckpt, with_blob=True)
        self.multilabel = bool(meta.get("multilabel"))
        self.classes = list(meta.get("classes") or ML_LICHESS_CLASSES)
        self.version = "v2" if self.multilabel else "v1"
        r: dict = {}
        if ref is not None and Path(ref).exists():
            with open(ref, "rb") as fh:
                r = pickle.load(fh)
        self.temperature = float(r.get("temperature", 1.0))
        self.centroids = torch.from_numpy(np.asarray(r["centroids"])).float() if "centroids" in r else None
        self.present = torch.from_numpy(np.asarray(r["present"])) if "present" in r else None
        self.threshold = float(r.get("threshold", 1.0))

    @torch.no_grad()
    def _encode(self, fens: list[str], moves: list[str]):
        codes, frm, to, ep, cas, keep = [], [], [], [], [], []
        for f, mv in zip(fens, moves):
            try:
                e = encode_position(f, mv)
            except Exception:
                keep.append(False); continue
            codes.append(e["codes"].astype(np.int64))
            frm.append(int(e["meta"][0])); to.append(int(e["meta"][1]))
            ep.append(int(e["meta"][2])); cas.append(e["castle"].astype(np.float32))
            keep.append(True)
        if not codes:
            return None, np.array(keep, dtype=bool)
        batch = {
            "codes":   torch.from_numpy(np.stack(codes)),
            "from_sq": torch.tensor(frm, dtype=torch.int64),
            "to_sq":   torch.tensor(to, dtype=torch.int64),
            "ep_sq":   torch.tensor(ep, dtype=torch.int64),
            "castle":  torch.from_numpy(np.stack(cas)),
        }
        return batch, np.array(keep, dtype=bool)

    @torch.no_grad()
    def predict_many(self, fens: list[str], moves: list[str]) -> dict:
        batch, keep = self._encode(fens, moves)
        if batch is None:
            return {"keep": keep}
        emb = self.model.encode(batch)
        logits = self.model.head(emb)
        if self.centroids is not None and self.model.proj is not None:
            z = F.normalize(self.model.proj(emb), dim=1)
            sim = z @ self.centroids[self.present].t()
            ood = (1 - sim.max(1).values)
        else:
            ood = torch.zeros(logits.shape[0])
        if self.multilabel:
            return self._predict_v2(logits, ood, keep)
        probs = F.softmax(logits / self.temperature, dim=1)
        conf, pred = probs.max(1)

        pred = pred.numpy()
        ml_class = [ML_LICHESS_CLASSES[i] for i in pred]
        threat = [ML_CLASS_TO_THREAT.get(c, "other") for c in ml_class]
        return {
            "keep": keep,
            "ml_class": ml_class,
            "threat_type": threat,
            "confidence": conf.numpy(),
            "ood_distance": ood.numpy(),
            "is_positional": (ood.numpy() > self.threshold),
        }

    def _predict_v2(self, logits: torch.Tensor, ood: torch.Tensor, keep: np.ndarray) -> dict:
        probs = torch.sigmoid(logits / self.temperature).numpy()
        core = probs.copy()
        for m in v2.MODIFIERS:
            core[:, v2.CLASS_INDEX[m]] = -1
        core[:, v2.NONE_INDEX] = -1
        top = core.argmax(1)
        conf = core[np.arange(len(top)), top]
        p_none = probs[:, v2.NONE_INDEX]
        ml_class = [self.classes[i] for i in top]
        # No motif evident (the learned "none" wins, or nothing clears a floor) -> positional.
        positional = (p_none >= np.maximum(conf, 0.5)) | (conf < 0.2)
        threat = ["other" if pos else (v2.CLASS_TO_THREAT.get(c) or "other")
                  for c, pos in zip(ml_class, positional)]
        return {
            "keep": keep, "ml_class": ml_class, "threat_type": threat,
            "confidence": conf, "ood_distance": ood.numpy(),
            "is_positional": positional, "probs": probs, "p_none": p_none,
        }

    def predict(self, fen: str, move_uci: str) -> dict:
        out = self.predict_many([fen], [move_uci])
        if not out["keep"][0]:
            raise ValueError("could not encode (illegal fen/move)")
        return {k: (v[0] if k != "keep" else None) for k, v in out.items() if k != "keep"}


def main() -> None:
    ap = argparse.ArgumentParser(description="Stage-1 predictor / reference fitter.")
    ap.add_argument("--fit", action="store_true", help="Fit the reference (centroids + temperature).")
    ap.add_argument("--fit-v2", action="store_true", help="Fit the v2 multi-label reference.")
    ap.add_argument("--ckpt", default=str(DEFAULT_CKPT))
    ap.add_argument("--fen", default=None)
    ap.add_argument("--move", default=None)
    args = ap.parse_args()

    if args.fit:
        fit_reference(Path(args.ckpt))
        return
    if args.fit_v2:
        fit_reference_v2()
        return
    if args.fen and args.move:
        p = Predictor(Path(args.ckpt))
        import json
        print(json.dumps({k: (float(v) if isinstance(v, (np.floating, np.bool_)) else v)
                          for k, v in p.predict(args.fen, args.move).items()}, indent=2, default=str))
    else:
        ap.error("pass --fit, or --fen and --move")


if __name__ == "__main__":
    main()
