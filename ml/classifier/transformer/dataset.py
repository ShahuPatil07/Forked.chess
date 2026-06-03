"""
Torch dataset over the pre-encoded token tensors (see prepare_tensors.py).

The whole split is held in memory as small int arrays (~70 bytes/position), and
each item is returned as plain tensors; `collate` stacks them into the dict the
model consumes.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

from ml.config import DATA_DIR

PROCESSED_DIR = DATA_DIR / "processed"


class TokenDataset(Dataset):
    def __init__(self, split: str, max_rows: int | None = None):
        path = PROCESSED_DIR / f"{split}_tokens.npz"
        if not path.exists():
            raise FileNotFoundError(
                f"{path} not found — run prepare_tensors.py --split {split} first."
            )
        d = np.load(path)
        self.codes  = d["codes"]
        self.meta   = d["meta"]      # [N,4] from,to,ep,promo
        self.castle = d["castle"]
        self.labels = d["labels"]
        if max_rows is not None and max_rows < len(self.labels):
            self.codes  = self.codes[:max_rows]
            self.meta   = self.meta[:max_rows]
            self.castle = self.castle[:max_rows]
            self.labels = self.labels[:max_rows]

    def __len__(self) -> int:
        return len(self.labels)

    def __getitem__(self, i: int) -> dict:
        m = self.meta[i]
        return {
            "codes":  torch.from_numpy(self.codes[i].astype(np.int64)),
            "from_sq": torch.tensor(int(m[0]), dtype=torch.int64),
            "to_sq":   torch.tensor(int(m[1]), dtype=torch.int64),
            "ep_sq":   torch.tensor(int(m[2]), dtype=torch.int64),
            "castle":  torch.from_numpy(self.castle[i].astype(np.float32)),
            "label":   torch.tensor(int(self.labels[i]), dtype=torch.int64),
        }

    def class_counts(self, n_classes: int) -> np.ndarray:
        counts = np.bincount(self.labels.astype(np.int64), minlength=n_classes)
        return counts


def collate(batch: list[dict]) -> dict[str, torch.Tensor]:
    out = {
        "codes":   torch.stack([b["codes"] for b in batch]),
        "from_sq": torch.stack([b["from_sq"] for b in batch]),
        "to_sq":   torch.stack([b["to_sq"] for b in batch]),
        "ep_sq":   torch.stack([b["ep_sq"] for b in batch]),
        "castle":  torch.stack([b["castle"] for b in batch]),
        "label":   torch.stack([b["label"] for b in batch]),
    }
    return out
