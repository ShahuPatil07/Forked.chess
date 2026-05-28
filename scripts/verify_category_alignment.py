#!/usr/bin/env python
"""
Verify that the rule-based classifier and the ML label encoder use
identical threat-type labels.

Passes silently (exit 0) if everything is aligned.
Prints errors and exits 1 if anything is mismatched.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from ml.ingestion.threat_classifier import THREAT_TYPES
from ml.classifier.label_map import ML_LICHESS_CLASSES, ML_CLASS_TO_THREAT

errors: list[str] = []

# 1. THREAT_TYPES must contain exactly 14 entries
if len(THREAT_TYPES) != 14:
    errors.append(f"THREAT_TYPES has {len(THREAT_TYPES)} entries, expected 14: {THREAT_TYPES}")

# 2. "other" must be the last entry
if THREAT_TYPES[-1] != "other":
    errors.append(f"Last THREAT_TYPE must be 'other', got '{THREAT_TYPES[-1]}'")

# 3. Every ML class maps to a known THREAT_TYPE
threat_set = set(THREAT_TYPES)
for ml_class in ML_LICHESS_CLASSES:
    mapped = ML_CLASS_TO_THREAT.get(ml_class)
    if mapped is None:
        errors.append(f"ML class '{ml_class}' has no entry in ML_CLASS_TO_THREAT")
    elif mapped not in threat_set:
        errors.append(
            f"ML class '{ml_class}' maps to '{mapped}' which is not in THREAT_TYPES"
        )

# 4. The 4 deleted categories must NOT appear in THREAT_TYPES
deleted = {"overloaded_piece", "zwischenzug", "missed_threat", "pawn_structure"}
for d in deleted:
    if d in threat_set:
        errors.append(f"Deleted category '{d}' is still present in THREAT_TYPES")

# 5. Check ML_CLASS_TO_THREAT covers all 13 classifiable types (every THREAT_TYPE
#    except "other" should be reachable from at least one ML class)
reachable = set(ML_CLASS_TO_THREAT.values())
for tt in THREAT_TYPES:
    if tt == "other":
        continue
    if tt not in reachable:
        errors.append(
            f"THREAT_TYPE '{tt}' is not reachable from any ML class via ML_CLASS_TO_THREAT"
        )

# 6. Check model file exists (if trained)
model_path = Path(__file__).parent.parent / "models" / "threat_lgbm.pkl"
enc_path   = Path(__file__).parent.parent / "models" / "label_encoder.pkl"
if model_path.exists() and enc_path.exists():
    import joblib
    le = joblib.load(enc_path)
    # Every class the encoder knows must map to a known THREAT_TYPE
    for enc_idx in range(len(le.classes_)):
        orig_idx = int(le.inverse_transform([enc_idx])[0])
        if orig_idx >= len(ML_LICHESS_CLASSES):
            errors.append(f"Encoder index {orig_idx} out of ML_LICHESS_CLASSES range")
            continue
        ml_class = ML_LICHESS_CLASSES[orig_idx]
        threat   = ML_CLASS_TO_THREAT.get(ml_class)
        if threat not in threat_set:
            errors.append(
                f"Encoder class '{ml_class}' (idx {orig_idx}) maps to unknown threat '{threat}'"
            )
    print(f"Model + encoder checked ({len(le.classes_)} encoded classes).")
else:
    print("No trained model found — skipping encoder check.")

if errors:
    print("\nALIGNMENT ERRORS:")
    for e in errors:
        print(f"  FAIL: {e}")
    sys.exit(1)
else:
    print(f"\nAll checks passed.")
    print(f"  THREAT_TYPES ({len(THREAT_TYPES)}): {', '.join(THREAT_TYPES)}")
    print(f"  ML_LICHESS_CLASSES ({len(ML_LICHESS_CLASSES)}): {', '.join(ML_LICHESS_CLASSES)}")
    print(f"  ML_CLASS_TO_THREAT coverage: {len(set(ML_CLASS_TO_THREAT.values()))} unique threat types reachable")
    sys.exit(0)
