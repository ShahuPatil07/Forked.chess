"""LLM provider chain for the Coach (OpenAI-compatible, no SDK dependency).

The paid primary is DeepSeek (`deepseek-flash`, served by V4.1-Flash-1017);
the free-tier chain stays behind it as an automatic fallback:

  DeepSeek (DEEPSEEK_API_KEY)  →  Gemini (GEMINI_API_KEY)  →  Cerebras (CEREBRAS_API_KEY)  →
  Groq gpt-oss-120b → qwen3.8-27b → gpt-oss-20b (GROQ_API_KEY)  →  OpenRouter (OPENROUTER_API_KEY)

Override with COACH_LLM_CHAIN="deepseek:deepseek-flash,groq:openai/gpt-oss-120b".

DeepSeek specifics handled here:
  * thinking mode is on by default; `effort` maps to `reasoning_effort` (low|high)
    and `thinking=False` switches it off (fast JSON calls such as the intent router);
  * in a tool loop the assistant's `reasoning_content` must be sent back, so
    replies carry it and `loop.py` stores it on the assistant message (other
    providers get it stripped);
  * every paid call is priced from the returned usage and added to a spend ledger
    (`data/coach_spend.json`). When COACH_SPEND_LIMIT_USD is set and reached, paid
    providers are skipped and the free chain answers instead.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import requests

log = logging.getLogger(__name__)

PROVIDERS = {
    "deepseek": ("https://api.deepseek.com", "DEEPSEEK_API_KEY"),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY"),
    "cerebras": ("https://api.cerebras.ai/v1", "CEREBRAS_API_KEY"),
    "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
}
DEFAULT_CHAIN = [
    ("deepseek", os.getenv("COACH_DEEPSEEK_MODEL", "deepseek-flash")),
    ("gemini", os.getenv("COACH_GEMINI_MODEL", "gemini-flash-latest")),
    ("cerebras", os.getenv("COACH_CEREBRAS_MODEL", "gpt-oss-120b")),
    ("groq", os.getenv("FORKED_COACH_MODEL", "openai/gpt-oss-120b")),
    ("groq", "qwen/qwen3.8-27b"),
    ("groq", "openai/gpt-oss-20b"),
    ("openrouter", os.getenv("COACH_OPENROUTER_MODEL", "openai/gpt-oss-120b:free")),
]
PAID = {"deepseek"}
# $ per 1M tokens: (cache miss input, cache hit input, output). DeepSeek's peak
# rate is used for every call, so the ledger never under-counts (off-peak is half).
PRICES = {"deepseek": (0.30, 0.006, 1.20)}
SPEND_FILE = Path(__file__).resolve().parents[3] / "data" / "coach_spend.json"

THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
FUNC_TAG_RE = re.compile(r"<function=.*?(</function>|$)", re.DOTALL)
_cooldown: dict[str, float] = {}
_spend_lock = threading.Lock()
# Process-wide usage counters (read by the evaluation harness / logs).
TOTALS = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "cache_hit_tokens": 0,
          "rate_limited": 0, "usd": 0.0}


class LLMUnavailable(RuntimeError):
    pass


@dataclass
class LLMReply:
    content: str
    tool_calls: list[dict] = field(default_factory=list)
    provider: str = ""
    reasoning: str = ""           # DeepSeek reasoning_content (replayed in tool loops)
    usage: dict = field(default_factory=dict)
    finish: str = ""              # "stop" | "length" (cut off at max_tokens) | "tool_calls"

    def assistant_message(self) -> dict:
        """The message to append to the transcript for this reply."""
        msg: dict = {"role": "assistant", "content": self.content or ""}
        if self.tool_calls:
            msg["tool_calls"] = [{"id": c["id"], "type": "function",
                                  "function": {"name": c["name"], "arguments": c["arguments"]}}
                                 for c in self.tool_calls]
        if self.reasoning:
            msg["reasoning_content"] = self.reasoning
        return msg


# ── Chain & budget ─────────────────────────────────────────────────────────────

def chain() -> list[tuple[str, str]]:
    raw = os.getenv("COACH_LLM_CHAIN", "").strip()
    entries = ([tuple(p.split(":", 1)) for p in raw.split(",") if ":" in p] if raw else DEFAULT_CHAIN)
    seen, out = set(), []
    for provider, model in entries:
        provider, model = provider.strip(), model.strip()
        if provider in PROVIDERS and os.getenv(PROVIDERS[provider][1]) and (provider, model) not in seen:
            seen.add((provider, model))
            out.append((provider, model))
    return out


def available() -> bool:
    return bool(chain())


def primary() -> str:
    entries = chain()
    return f"{entries[0][0]}:{entries[0][1]}" if entries else ""


def critic_enabled() -> bool:
    """The claim-by-claim fact check costs an extra call; on by default whenever a
    paid or high-quota provider is configured."""
    flag = os.getenv("COACH_CRITIC", "").strip().lower()
    if flag in ("0", "false", "no", "off"):
        return False
    if flag in ("1", "true", "yes", "on"):
        return True
    return any(p in ("deepseek", "gemini", "cerebras") for p, _ in chain())


def spend_limit() -> float:
    try:
        return float(os.getenv("COACH_SPEND_LIMIT_USD", "0") or 0)
    except ValueError:
        return 0.0


def spent() -> float:
    try:
        return float(json.loads(SPEND_FILE.read_text(encoding="utf-8")).get("usd", 0.0))
    except Exception:
        return 0.0


def _over_budget() -> bool:
    limit = spend_limit()
    return limit > 0 and spent() >= limit


def cost_of(provider: str, usage: dict) -> float:
    if provider not in PRICES:
        return 0.0
    miss_p, hit_p, out_p = PRICES[provider]
    prompt = int(usage.get("prompt_tokens") or 0)
    hit = int(usage.get("prompt_cache_hit_tokens") or (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
    miss = int(usage.get("prompt_cache_miss_tokens") or max(0, prompt - hit))
    out = int(usage.get("completion_tokens") or 0)
    return (miss * miss_p + hit * hit_p + out * out_p) / 1e6


def _record(provider: str, key: str, usage: dict) -> None:
    usd = cost_of(provider, usage)
    hit = int(usage.get("prompt_cache_hit_tokens") or (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
    TOTALS["calls"] += 1
    TOTALS["prompt_tokens"] += int(usage.get("prompt_tokens") or 0)
    TOTALS["completion_tokens"] += int(usage.get("completion_tokens") or 0)
    TOTALS["cache_hit_tokens"] += hit
    TOTALS["usd"] = round(TOTALS["usd"] + usd, 6)
    log.info("coach llm %s prompt=%s (cached %s) completion=%s $%.5f", key, usage.get("prompt_tokens"), hit,
             usage.get("completion_tokens"), usd)
    if provider in PAID:
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


# ── Request building ───────────────────────────────────────────────────────────

def _extras(provider: str, model: str, effort: str, thinking: bool) -> dict:
    if provider == "deepseek":
        if not thinking:
            return {"thinking": {"type": "disabled"}}
        return {"thinking": {"type": "enabled"}, "reasoning_effort": "high" if effort == "high" else "low"}
    if "gpt-oss" in model:
        return {"reasoning_effort": "medium" if effort == "high" else "low"} if provider in ("groq", "cerebras") else {}
    if provider == "groq" and "qwen" in model:
        return {"reasoning_format": "hidden"}
    if provider == "gemini":
        return {"reasoning_effort": "low"}
    return {}


REASONING_PLACEHOLDER = "Gathering verified evidence before answering."


def _messages_for(provider: str, messages: list[dict]) -> list[dict]:
    """DeepSeek's thinking mode rejects (HTTP 400) a tool conversation in which an assistant turn lacks
    `reasoning_content` — including turns we synthesise (the kickoff evidence, history, repairs) — so
    those get a short placeholder. Every other provider gets the field stripped."""
    if provider == "deepseek":
        return [{**m, "reasoning_content": REASONING_PLACEHOLDER}
                if m.get("role") == "assistant" and not m.get("reasoning_content") else m
                for m in messages]
    out = []
    for m in messages:
        if "reasoning_content" in m:
            m = {k: v for k, v in m.items() if k != "reasoning_content"}
        out.append(m)
    return out


def _salvage(text: str) -> str:
    """Groq rejects malformed inline tool calls (`tool_use_failed`); the prose
    is in `failed_generation`. Strip the broken function tag and keep it."""
    try:
        gen = json.loads(text).get("error", {}).get("failed_generation", "")
    except Exception:
        gen = ""
    return FUNC_TAG_RE.sub("", gen or "").strip()


def _parse_reset(value: str | None) -> float:
    """Groq style '2.085s' / '1m26.4s' → seconds."""
    if not value:
        return 0.0
    total, num = 0.0, ""
    for ch in value:
        if ch.isdigit() or ch == ".":
            num += ch
        elif ch in "hms" and num:
            total += float(num) * {"h": 3600, "m": 60, "s": 1}[ch]
            num = ""
    return total


def _body(provider, model, messages, tools, max_tokens, temperature, effort, thinking, json_mode, stream,
          tool_choice="auto"):
    body = {"model": model, "messages": _messages_for(provider, messages), "max_tokens": max_tokens,
            "temperature": temperature, **_extras(provider, model, effort, thinking)}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = tool_choice
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    if stream:
        body["stream"] = True
        body["stream_options"] = {"include_usage": True}
    return body


def _usable(entries) -> list[tuple[str, str]]:
    over = _over_budget()
    out = []
    for provider, model in entries:
        if over and provider in PAID:
            continue
        if _cooldown.get(f"{provider}:{model}", 0) > time.monotonic():
            continue
        out.append((provider, model))
    return out


# ── Calls ──────────────────────────────────────────────────────────────────────

def complete(messages: list[dict], tools: list[dict] | None = None, max_tokens: int = 1400,
             temperature: float = 0.2, *, effort: str = "low", thinking: bool = True,
             json_mode: bool = False, tool_choice: str = "auto") -> LLMReply:
    """One chat completion with automatic failover across the chain."""
    reply = None
    for kind, value in stream(messages, tools, max_tokens, temperature, effort=effort, thinking=thinking,
                              json_mode=json_mode, live=False, tool_choice=tool_choice):
        if kind == "reply":
            reply = value
    return reply


def stream(messages: list[dict], tools: list[dict] | None = None, max_tokens: int = 1400,
           temperature: float = 0.2, *, effort: str = "low", thinking: bool = True,
           json_mode: bool = False, live: bool = True, tool_choice: str = "auto") -> Iterator[tuple[str, object]]:
    """Yields ("text", delta) while the answer streams (when `live`), then exactly one
    ("reply", LLMReply). Fails over to the next provider on errors that happen
    before any text was streamed."""
    entries = chain()
    if not entries:
        raise LLMUnavailable("No LLM key configured (set DEEPSEEK_API_KEY or GROQ_API_KEY).")
    errors = []
    if _over_budget():
        errors.append(f"paid spend limit ${spend_limit():.2f} reached")
    for provider, model in _usable(entries):
        key = f"{provider}:{model}"
        base, env = PROVIDERS[provider]
        body = _body(provider, model, messages, tools, max_tokens, temperature, effort, thinking, json_mode, live,
                     tool_choice)
        for attempt in range(2):
            try:
                resp = requests.post(f"{base}/chat/completions", json=body, stream=live,
                                     timeout=(10, 90 if provider == "deepseek" else 40),
                                     headers={"Authorization": f"Bearer {os.environ[env]}"})
            except requests.RequestException as exc:
                errors.append(f"{key}: {type(exc).__name__}")
                break
            if resp.status_code == 429:
                TOTALS["rate_limited"] += 1
                wait = _parse_reset(resp.headers.get("x-ratelimit-reset-tokens")) or \
                       float(resp.headers.get("retry-after", "0") or 0)
                if attempt == 0 and 0 < wait <= 5:
                    time.sleep(wait + 0.3)
                    continue
                _cooldown[key] = time.monotonic() + max(wait, 20)
                errors.append(f"{key}: rate limited")
                break
            if resp.status_code == 400 and "tool_use_failed" in resp.text:
                salvaged = _salvage(resp.text)
                if salvaged:
                    yield "reply", LLMReply(THINK_RE.sub("", salvaged).strip(), [], key)
                    return
                body.pop("tools", None); body.pop("tool_choice", None)
                continue
            if resp.status_code >= 400:
                errors.append(f"{key}: HTTP {resp.status_code} {resp.text[:160]}")
                if resp.status_code in (401, 402, 403, 404):
                    _cooldown[key] = time.monotonic() + 600
                break
            streamed: list[str] = []
            try:
                if live:
                    reply = None
                    for kind, value in _read_stream(resp, provider, key):
                        if kind == "text":
                            streamed.append(value)
                            yield kind, value
                        else:
                            reply = value
                else:
                    reply = _read_json(resp.json(), provider, key)
            except Exception as exc:
                if streamed:   # text is already on screen: finish with what we have
                    yield "reply", LLMReply("".join(streamed).strip(), [], key)
                    return
                errors.append(f"{key}: malformed response ({type(exc).__name__})")
                break
            if reply is None or (not reply.content and not reply.tool_calls):
                errors.append(f"{key}: empty reply (finish={getattr(reply, 'finish', '?')}, "
                              f"reasoning={len(getattr(reply, 'reasoning', '') or '')} chars)")
                break
            if errors:
                log.warning("coach llm failover → %s after: %s", key, "; ".join(errors))
            yield "reply", reply
            return
    log.warning("All coach LLM providers failed: %s", "; ".join(errors))
    raise LLMUnavailable("The AI coach is unavailable right now. " + "; ".join(errors[-3:]))


def _read_json(data: dict, provider: str, key: str) -> LLMReply:
    choice = data["choices"][0]
    msg = choice["message"]
    usage = data.get("usage") or {}
    _record(provider, key, usage)
    calls = [{"id": tc.get("id") or f"call_{i}", "name": tc["function"]["name"],
              "arguments": tc["function"].get("arguments") or "{}"}
             for i, tc in enumerate(msg.get("tool_calls") or []) if tc.get("function")]
    return LLMReply(THINK_RE.sub("", msg.get("content") or "").strip(), calls, key,
                    msg.get("reasoning_content") or "", usage, choice.get("finish_reason") or "")


def _read_stream(resp, provider: str, key: str) -> Iterator[tuple[str, object]]:
    """Parse an OpenAI-style SSE stream: content deltas are yielded live; tool-call
    fragments and reasoning are accumulated into the final reply."""
    content, reasoning, usage, finish = [], [], {}, ""
    calls: dict[int, dict] = {}
    in_think = False
    # text/event-stream often has no charset; requests would then guess Latin-1 and mangle "’", "…", "—".
    resp.encoding = "utf-8"
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw or not raw.startswith("data:"):
            continue
        payload = raw[5:].strip()
        if payload == "[DONE]":
            break
        chunk = json.loads(payload)
        if chunk.get("usage"):
            usage = chunk["usage"]
        for choice in chunk.get("choices") or []:
            finish = choice.get("finish_reason") or finish
            delta = choice.get("delta") or {}
            if delta.get("reasoning_content"):
                reasoning.append(delta["reasoning_content"])
            text = delta.get("content")
            if text:
                # Some open models inline <think>…</think>; never stream that part.
                if "<think>" in text:
                    in_think = True
                if not in_think:
                    content.append(text)
                    yield "text", text
                if "</think>" in text:
                    in_think = False
            for tc in delta.get("tool_calls") or []:
                slot = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "arguments": ""})
                slot["id"] = tc.get("id") or slot["id"]
                fn = tc.get("function") or {}
                slot["name"] += fn.get("name") or ""
                slot["arguments"] += fn.get("arguments") or ""
    if not usage:   # provider sent no usage: estimate conservatively (~4 chars/token)
        usage = {"prompt_tokens": 0, "completion_tokens": (len("".join(content)) + len("".join(reasoning))) // 3}
    _record(provider, key, usage)
    tool_calls = [{"id": c["id"] or f"call_{i}", "name": c["name"], "arguments": c["arguments"] or "{}"}
                  for i, c in sorted(calls.items()) if c["name"]]
    return_text = THINK_RE.sub("", "".join(content)).strip()
    yield "reply", LLMReply(return_text, tool_calls, key, "".join(reasoning), usage, finish)
