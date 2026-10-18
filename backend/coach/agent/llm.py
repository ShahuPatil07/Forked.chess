"""Free-tier LLM provider chain (OpenAI-compatible, no SDK dependency).

Every provider in the chain speaks the OpenAI `/chat/completions` dialect with
function calling. Calls fail over to the next provider/model on rate limits
(HTTP 429), server errors, timeouts or unknown models, so free-tier per-model
token buckets add up instead of surfacing as errors.

Default order (only providers whose key is set are used):
  Gemini (GEMINI_API_KEY)  →  Cerebras (CEREBRAS_API_KEY)  →
  Groq gpt-oss-120b → qwen3.8-27b → gpt-oss-20b (GROQ_API_KEY)  →
  OpenRouter (OPENROUTER_API_KEY)

Override with COACH_LLM_CHAIN="groq:openai/gpt-oss-120b,gemini:gemini-flash-latest".
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass, field

import requests

log = logging.getLogger(__name__)

PROVIDERS = {
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY"),
    "cerebras": ("https://api.cerebras.ai/v1", "CEREBRAS_API_KEY"),
    "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
}
DEFAULT_CHAIN = [
    ("gemini", os.getenv("COACH_GEMINI_MODEL", "gemini-flash-latest")),
    ("cerebras", os.getenv("COACH_CEREBRAS_MODEL", "gpt-oss-120b")),
    ("groq", os.getenv("FORKED_COACH_MODEL", "openai/gpt-oss-120b")),
    ("groq", "qwen/qwen3.8-27b"),
    ("groq", "openai/gpt-oss-20b"),
    ("openrouter", os.getenv("COACH_OPENROUTER_MODEL", "openai/gpt-oss-120b:free")),
]
THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
FUNC_TAG_RE = re.compile(r"<function=.*?(</function>|$)", re.DOTALL)
# A model that 429s is skipped until this monotonic time (per provider:model).
_cooldown: dict[str, float] = {}
# Process-wide usage counters (read by the evaluation harness / logs).
TOTALS = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "rate_limited": 0}


class LLMUnavailable(RuntimeError):
    pass


@dataclass
class LLMReply:
    content: str
    tool_calls: list[dict] = field(default_factory=list)
    provider: str = ""


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


def critic_enabled() -> bool:
    """The second-opinion fact check costs a full extra call, so by default it
    only runs when a high-quota free provider (Gemini/Cerebras) is configured."""
    flag = os.getenv("COACH_CRITIC", "").strip().lower()
    if flag in ("0", "false", "no", "off"):
        return False
    if flag in ("1", "true", "yes", "on"):
        return True
    return any(p in ("gemini", "cerebras") for p, _ in chain())


def _extras(provider: str, model: str) -> dict:
    """Keep hidden reasoning short and out of the answer text."""
    if "gpt-oss" in model:
        return {"reasoning_effort": "medium"} if provider in ("groq", "cerebras") else {}
    if provider == "groq" and "qwen" in model:
        return {"reasoning_format": "hidden"}
    if provider == "gemini":
        return {"reasoning_effort": "low"}
    return {}


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


def complete(messages: list[dict], tools: list[dict] | None = None,
             max_tokens: int = 1400, temperature: float = 0.2) -> LLMReply:
    """One chat completion with automatic failover across the chain."""
    entries = chain()
    if not entries:
        raise LLMUnavailable("No LLM key configured (set GROQ_API_KEY, GEMINI_API_KEY or CEREBRAS_API_KEY).")
    errors = []
    for provider, model in entries:
        key = f"{provider}:{model}"
        if _cooldown.get(key, 0) > time.monotonic():
            errors.append(f"{key} cooling down")
            continue
        base, env = PROVIDERS[provider]
        body = {"model": model, "messages": messages, "max_tokens": max_tokens,
                "temperature": temperature, **_extras(provider, model)}
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        for attempt in range(2):
            try:
                resp = requests.post(f"{base}/chat/completions", json=body, timeout=40,
                                     headers={"Authorization": f"Bearer {os.environ[env]}"})
            except requests.RequestException as exc:
                errors.append(f"{key}: {type(exc).__name__}")
                break
            if resp.status_code == 429:
                TOTALS["rate_limited"] += 1
                wait = _parse_reset(resp.headers.get("x-ratelimit-reset-tokens")) or \
                       float(resp.headers.get("retry-after", "0") or 0)
                # A short token-bucket refill is worth waiting for: the first models in the
                # chain are the strongest, and quality beats a second or two of latency.
                if attempt == 0 and 0 < wait <= (8 if (provider, model) == entries[0] else 5):
                    time.sleep(wait + 0.3)
                    continue
                _cooldown[key] = time.monotonic() + max(wait, 20)
                errors.append(f"{key}: rate limited ({resp.text[:200]})")
                break
            if resp.status_code == 400 and "tool_use_failed" in resp.text:
                salvaged = _salvage(resp.text)
                if salvaged:
                    return LLMReply(THINK_RE.sub("", salvaged).strip(), [], key)
                body.pop("tools", None); body.pop("tool_choice", None)
                continue
            if resp.status_code >= 400:
                errors.append(f"{key}: HTTP {resp.status_code} {resp.text[:160]}")
                if resp.status_code in (401, 403, 404):
                    _cooldown[key] = time.monotonic() + 600
                break
            try:
                data = resp.json()
                msg = data["choices"][0]["message"]
                usage = data.get("usage") or {}
                TOTALS["calls"] += 1
                TOTALS["prompt_tokens"] += int(usage.get("prompt_tokens") or 0)
                TOTALS["completion_tokens"] += int(usage.get("completion_tokens") or 0)
                log.info("coach llm %s prompt=%s completion=%s", key, usage.get("prompt_tokens"), usage.get("completion_tokens"))
            except Exception:
                errors.append(f"{key}: malformed response")
                break
            calls = [{"id": tc.get("id") or f"call_{i}", "name": tc["function"]["name"],
                      "arguments": tc["function"].get("arguments") or "{}"}
                     for i, tc in enumerate(msg.get("tool_calls") or []) if tc.get("function")]
            content = THINK_RE.sub("", msg.get("content") or "").strip()
            if not content and not calls:
                errors.append(f"{key}: empty reply")
                break
            return LLMReply(content, calls, key)
    log.warning("All coach LLM providers failed: %s", "; ".join(errors))
    raise LLMUnavailable("All free LLM providers are busy or unavailable right now. " +
                         "; ".join(errors[-3:]))
