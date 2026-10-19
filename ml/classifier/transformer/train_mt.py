#!/usr/bin/env python
"""
Fine-tune the Stage-1 Chessformer into the v2 MULTI-LABEL motif classifier (CPU).

  init      models/stage1_transformer.pt (v1, 16-way softmax). The encoder, the
            SupCon projection and the first head layer are reused; output rows
            whose meaning carried over are copied (label_map_v2.V1_INIT_ROW),
            new classes (intermezzo, kingAttack, defensiveMove, none) start fresh.
  data      mt_train.npz (+ mt_neg.npz no-tactic negatives), mt_val.npz
  loss      BCE-with-logits over 17 sigmoid outputs (a puzzle can be fork AND
            discovered attack AND mate)
  schedule  time-budgeted: warmup then cosine decay over --minutes of wall time,
            so the run ends on time on a busy CPU
  output    models/stage1_transformer_v2.pt (best val hit@1), *_last.pt

    python -m ml.classifier.transformer.train_mt --minutes 150 --threads 10
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

import numpy as np
import torch
import torch.nn as nn

from ml.config import DATA_DIR
from ml.classifier.label_map_v2 import MOTIF_CLASSES, N_CLASSES, NONE_INDEX, V1_INIT_ROW, MODIFIERS, CLASS_INDEX
from ml.classifier.transformer.model import ChessformerClassifier, ModelConfig

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[3]
MODELS = ROOT / "models"
PROC = DATA_DIR / "processed"
MOD_IDX = [CLASS_INDEX[m] for m in MODIFIERS]


def load_npz(name: str) -> dict[str, np.ndarray]:
    d = np.load(PROC / name)
    return {k: d[k] for k in ("codes", "meta", "castle", "labels")}


def concat(*parts: dict) -> dict:
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def take(d: dict, idx) -> dict:
    return {k: v[idx] for k, v in d.items()}


def to_batch(d: dict, idx: np.ndarray) -> dict[str, torch.Tensor]:
    m = d["meta"][idx]
    return {
        "codes": torch.from_numpy(d["codes"][idx].astype(np.int64)),
        "from_sq": torch.from_numpy(m[:, 0].astype(np.int64)),
        "to_sq": torch.from_numpy(m[:, 1].astype(np.int64)),
        "ep_sq": torch.from_numpy(m[:, 2].astype(np.int64)),
        "castle": torch.from_numpy(d["castle"][idx].astype(np.float32)),
    }


def build_model(init: Path) -> tuple[ChessformerClassifier, ModelConfig]:
    blob = torch.load(init, map_location="cpu", weights_only=False)
    v1cfg = blob["config"]
    cfg = ModelConfig(**{**v1cfg, "n_classes": N_CLASSES})
    model = ChessformerClassifier(cfg)
    sd = blob["state_dict"]
    own = model.state_dict()
    last_w, last_b = "head.3.weight", "head.3.bias"
    for k, v in sd.items():
        if k in (last_w, last_b):
            continue
        if k in own and own[k].shape == v.shape:
            own[k] = v
    with torch.no_grad():
        for new_i, old_i in V1_INIT_ROW.items():
            if old_i is not None:
                own[last_w][new_i] = sd[last_w][old_i]
                own[last_b][new_i] = sd[last_b][old_i]
        own[last_b][NONE_INDEX] = -2.0
    model.load_state_dict(own)
    return model, cfg


@torch.no_grad()
def evaluate(model, d: dict, bs: int = 512) -> dict:
    model.eval()
    probs = []
    for s in range(0, len(d["labels"]), bs):
        idx = np.arange(s, min(s + bs, len(d["labels"])))
        probs.append(torch.sigmoid(model(to_batch(d, idx))).numpy())
    model.train()
    p = np.concatenate(probs)
    y = d["labels"].astype(bool)
    pred = p >= 0.5
    tp = (pred & y).sum(); fp = (pred & ~y).sum(); fn = (~pred & y).sum()
    micro_f1 = 2 * tp / max(1, 2 * tp + fp + fn)
    core = p.copy(); core[:, MOD_IDX] = -1
    top = core.argmax(1)
    hit1 = float(y[np.arange(len(y)), top].mean())
    is_neg = y[:, NONE_INDEX]
    none_acc = float(((p[:, NONE_INDEX] >= 0.5) == is_neg).mean())
    pos = ~is_neg
    hit1_motif = float(y[np.arange(len(y)), top][pos].mean()) if pos.any() else 0.0
    return {"micro_f1": round(float(micro_f1), 4), "hit1": round(hit1, 4),
            "hit1_motif": round(hit1_motif, 4), "none_acc": round(none_acc, 4)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=150)
    ap.add_argument("--threads", type=int, default=10)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1.5e-4)
    ap.add_argument("--head-lr", type=float, default=1e-3)
    ap.add_argument("--eval-every-min", type=float, default=20)
    ap.add_argument("--init", default=str(MODELS / "stage1_transformer.pt"))
    ap.add_argument("--out", default=str(MODELS / "stage1_transformer_v2.pt"))
    args = ap.parse_args()
    torch.set_num_threads(args.threads)
    torch.manual_seed(0)
    rng = np.random.default_rng(0)

    train = load_npz("mt_train.npz")
    val = load_npz("mt_val.npz")
    neg_path = PROC / "mt_neg.npz"
    if neg_path.exists():
        neg = load_npz("mt_neg.npz")
        nperm = rng.permutation(len(neg["labels"]))
        n_val = max(500, len(nperm) // 20)
        val = concat(val, take(neg, nperm[:n_val]))
        train = concat(train, take(neg, nperm[n_val:]))
        log.info("negatives: %d train / %d val", len(nperm) - n_val, n_val)
    val = take(val, rng.permutation(len(val["labels"]))[:6000])
    n = len(train["labels"])
    log.info("train %d | val %d | classes %d", n, len(val["labels"]), N_CLASSES)

    model, cfg = build_model(Path(args.init))
    head_params = list(model.head.parameters())
    head_ids = {id(p) for p in head_params}
    enc_params = [p for p in model.parameters() if id(p) not in head_ids]
    opt = torch.optim.AdamW([{"params": enc_params, "lr": args.lr},
                             {"params": head_params, "lr": args.head_lr}], weight_decay=0.01)
    base_lrs = [args.lr, args.head_lr]
    loss_fn = nn.BCEWithLogitsLoss()

    log.info("init (v1 weights, new head rows) val: %s", evaluate(model, val))
    budget = args.minutes * 60
    t0 = time.time()
    next_eval = t0 + args.eval_every_min * 60
    best = -1.0
    step, seen = 0, 0
    perm = rng.permutation(n)
    pos = 0
    model.train()
    while True:
        elapsed = time.time() - t0
        if elapsed >= budget:
            break
        frac = elapsed / budget
        warm = min(1.0, (step + 1) / 200)
        scale = warm * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * frac)))
        for g, b in zip(opt.param_groups, base_lrs):
            g["lr"] = b * scale
        if pos + args.batch > n:
            perm = rng.permutation(n); pos = 0
        idx = perm[pos:pos + args.batch]; pos += args.batch
        logits = model(to_batch(train, idx))
        loss = loss_fn(logits, torch.from_numpy(train["labels"][idx].astype(np.float32)))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        step += 1; seen += len(idx)
        if step % 100 == 0:
            log.info("step %d | seen %d (%.2f ep) | loss %.4f | %.0f samples/s | lr x%.2f",
                     step, seen, seen / n, loss.item(), seen / (time.time() - t0), scale)
        if time.time() >= next_eval or time.time() - t0 >= budget:
            next_eval = time.time() + args.eval_every_min * 60
            m = evaluate(model, val)
            log.info("VAL %s", m)
            blob = {"config": cfg.__dict__, "classes": list(MOTIF_CLASSES), "multilabel": True,
                    "label_space": "v2", "val": m, "steps": step, "seen": seen,
                    "init_from": Path(args.init).name, "state_dict": model.state_dict()}
            torch.save(blob, Path(args.out).with_name(Path(args.out).stem + "_last.pt"))
            if m["hit1"] > best:
                best = m["hit1"]
                torch.save(blob, args.out)
                log.info("  saved best -> %s", args.out)

    m = evaluate(model, val)
    log.info("FINAL VAL %s (steps %d, seen %d)", m, step, seen)
    blob = {"config": cfg.__dict__, "classes": list(MOTIF_CLASSES), "multilabel": True,
            "label_space": "v2", "val": m, "steps": step, "seen": seen,
            "init_from": Path(args.init).name, "state_dict": model.state_dict()}
    torch.save(blob, Path(args.out).with_name(Path(args.out).stem + "_last.pt"))
    if m["hit1"] > best:
        torch.save(blob, args.out)
    (MODELS / "stage1_transformer_v2_train.json").write_text(json.dumps(
        {"final_val": m, "best_hit1": max(best, m["hit1"]), "steps": step, "seen": seen,
         "minutes": args.minutes, "train_rows": n}, indent=2))


if __name__ == "__main__":
    main()
