# Scoresheet OCR evaluation (dev split)

HCS handwritten scoresheets (real tournament sheets), DeepSeek-V4.1-Flash vision reader.
Reference = legal game decoded from the human per-cell labels; *legal-prefix* = the plies where the
labels replay verbatim as legal moves (exact, decoder-free ground truth).

| variant | pages | cell reading | ply accuracy | legal-prefix acc | exact games | games ≥95% | fixes/game | flag recall | silent errors /100 plies | flags/game | read s | decode s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pipeline-bands | 20 | 82.8% | 74.7% | 92.0% | 5.0% | 30.0% | 18.05 | 56.3% | 9.44 | 11.2 | 73.9 | 0.0 |

OCR spend so far (data/ocr_spend.json): $0.5325

- *cell reading*: reader output vs the literal human transcription, per cell.
- *ply accuracy*: decoded game vs reference, position by position (a shifted game counts as wrong).
- *fixes/game*: move edits needed to turn the output into the reference (sequence edit distance).
- *flag recall*: share of wrong plies the review screen highlights (uncertain/inferred).
- *silent errors*: wrong plies shown as confident, per 100 plies -- what a user could miss.
