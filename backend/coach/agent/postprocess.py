"""Answer post-processing that also works on a live token stream.

  * Board diagrams never reach the user: rows like "r . b q k b . r", "8 | r n b q |",
    "+---+---+", "a b c d e f g h" and code fences are dropped (the user already sees
    the board). A line is held back only while it still looks like a diagram row.
  * Notation "words": SAN moves become words ("Nxe5" → "knight takes on e5") for users
    who asked for it. Bare pawn moves ("e4") are converted only inside move sequences,
    because in prose "e4" is usually a square.
"""
from __future__ import annotations

import re

DIAGRAM_CHARS = set("prnbqkPRNBQKabcdefgh12345678.|+-_=*:`#·♔♕♖♗♘♙♚♛♜♝♞♟ \t")
PIECE_TOKENS = set("prnbqkPRNBQK.·♔♕♖♗♘♙♚♛♜♝♞♟_-")


TOOL_MARKUP = re.compile(r"DSML|^</?\s*[｜|]|^</?(tool_call|function|invoke|parameter)\b")


def is_diagram_line(line: str) -> bool:
    """Lines never shown to the user: board diagrams, code fences and leaked tool-call markup."""
    s = line.strip()
    if not s:
        return False
    if TOOL_MARKUP.search(s):
        return True
    if re.fullmatch(r"`{3,}\w*", s):
        return True
    if re.fullmatch(r"[+\-=|_\s]{6,}", s):
        return True
    if re.fullmatch(r"[|\s]*a[|\s]+b[|\s]+c[|\s]+d[|\s]+e[|\s]+f[|\s]+g[|\s]+h[|\s]*", s):
        return True
    body = re.sub(r"^\s*[1-8]?\s*[|:]?|[|:]?\s*[1-8]?\s*$", "", s)
    tokens = [t for t in re.split(r"[\s|]+", body) if t]
    if len(tokens) >= 6 and all(len(t) == 1 and t in PIECE_TOKENS for t in tokens):
        return True
    compact = body.replace(" ", "").replace("|", "")
    return len(compact) == 8 and all(c in PIECE_TOKENS or c.isdigit() for c in compact) and any(c in ".·" for c in compact)


NAMES = {"K": "king", "Q": "queen", "R": "rook", "B": "bishop", "N": "knight"}
SAN_TOKEN = re.compile(r"(?<![\w/])(O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][1-8](?:=[QRBN])?)([+#]?)(?![\w])")


def san_words(san: str, suffix: str = "") -> str:
    tail = " with check" if suffix == "+" else " — checkmate" if suffix == "#" else ""
    if san.startswith("O-O"):
        return ("castles queenside" if san == "O-O-O" else "castles kingside") + tail
    promo = ""
    if "=" in san:
        san, piece = san.split("=")
        promo = f", promoting to a {NAMES[piece]}"
    if san[0] in NAMES:
        piece, rest = NAMES[san[0]], san[1:]
    else:
        piece, rest = "pawn", san
    square = rest[-2:]
    origin = rest[:-2].replace("x", "")
    if piece == "pawn" and origin:
        piece = f"{origin}-pawn"
        origin = ""
    frm = f" from the {origin}-file" if origin and origin.isalpha() else f" from rank {origin}" if origin else ""
    verb = " takes on " if "x" in rest else " to "
    return f"{piece}{frm}{verb}{square}{promo}{tail}"


def to_words(text: str, state: dict | None = None) -> str:
    """`state` carries {"ctx": recent raw text, "seq": inside a move sequence} across stream chunks."""
    state = state if state is not None else {}
    ctx, in_sequence = state.get("ctx", ""), state.get("seq", False)
    out, last_end = [], 0
    for m in SAN_TOKEN.finditer(text):
        token, suffix = m.group(1), m.group(2)
        between = text[last_end:m.start()]
        before = (ctx + between) if last_end == 0 else between
        numbered = bool(re.search(r"\d+\.(\.\.)?\s*$|\.\.\.\s*$", before))
        if numbered or (in_sequence and re.fullmatch(r"[\s,]*", between)):
            in_sequence = True
        elif not re.fullmatch(r"[\s,]*", between):
            in_sequence = False
        is_pawn_push = token[0] in "abcdefgh" and "x" not in token and "=" not in token
        if is_pawn_push and not (numbered or in_sequence):
            continue
        in_sequence = True
        out.append(text[last_end:m.start()])
        out.append(san_words(token, suffix))
        last_end = m.end()
    tail = text[last_end:]
    if tail and not re.fullmatch(r"[\s,]*", tail):
        in_sequence = False if not re.search(r"\d+\.(\.\.)?\s*$", tail) else in_sequence
    out.append(tail)
    state["ctx"], state["seq"] = (ctx + text)[-16:], in_sequence
    return "".join(out)


class AnswerFilter:
    """Feed streamed text, get back what is safe to show; call flush() at the end."""

    def __init__(self, words: bool = False):
        self.words = words
        self.line = ""          # held-back start of the current line (might be a diagram row)
        self.holding = True
        self.pending = ""       # words mode: text after the last whitespace (token may be incomplete)
        self.state: dict = {}   # words mode: move-sequence context across chunks

    def _emit(self, text: str) -> str:
        text = text.replace("`", "")   # no code formatting in coaching answers
        if not self.words:
            return text
        text = self.pending + text
        cut = max(text.rfind(" "), text.rfind("\n"))
        if cut < 0:
            self.pending = text
            return ""
        self.pending = text[cut + 1:]
        return to_words(text[:cut + 1], self.state)

    def feed(self, text: str) -> str:
        out = []
        for ch in text:
            if ch == "\n":
                if self.holding:
                    if not is_diagram_line(self.line):
                        out.append(self.line + "\n")
                else:
                    out.append("\n")
                self.line, self.holding = "", True
            elif self.holding:
                self.line += ch
                if self.line.lstrip().startswith("<"):
                    continue   # possible leaked tool-call markup: decide at the end of the line
                if ch not in DIAGRAM_CHARS or (len(self.line) > 3 and self.line.lstrip()[:1] not in DIAGRAM_CHARS):
                    out.append(self.line)
                    self.line, self.holding = "", False
            else:
                out.append(ch)
        return self._emit("".join(out))

    def flush(self) -> str:
        rest = ""
        if self.line and not is_diagram_line(self.line):
            rest = self.line
        self.line, self.holding = "", True
        text = self._emit(rest)
        if self.words:
            text += to_words(self.pending, self.state)
            self.pending = ""
        return text


def clean(text: str, words: bool = False) -> str:
    f = AnswerFilter(words)
    out = f.feed(text) + f.flush()
    out = out.replace("`", "")
    return re.sub(r"\n{3,}", "\n\n", out).strip()
