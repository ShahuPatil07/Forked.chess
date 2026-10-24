"""
Coach chat history — every conversation with the Coach is saved, with the
board tabs it used, so reopening it restores both the messages and the boards.

Storage (gitignored): data/library/{user}/chats/index.json   [{id, title, updated_at, ...}]
                      data/library/{user}/chats/{id}.json    the full conversation

API (prefix /api/coach-chats):
  GET    /{user}            list (newest first)
  GET    /{user}/{id}       one conversation {id, title, messages, board, ...}
  PUT    /{user}/{id}       create / replace (the client autosaves after each answer)
  PATCH  /{user}/{id}       rename
  DELETE /{user}/{id}
"""
from __future__ import annotations

import json
import re
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.auth import assert_owner
from backend.library import user_dir
from backend.storage import locked_update, read_json, safe_name, write_json

router = APIRouter(prefix="/api/coach-chats")
MAX_MESSAGES = 200
MAX_BYTES = 1_500_000
ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,40}$")


def _chats_dir(username: str):
    return user_dir(username) / "chats"


def _index_path(username: str):
    return _chats_dir(username) / "index.json"


def _chat_path(username: str, chat_id: str):
    return _chats_dir(username) / f"{safe_name(chat_id)}.json"


def _check_id(chat_id: str) -> None:
    if not ID_RE.match(chat_id):
        raise HTTPException(400, "Invalid conversation id.")


def _title_from(messages: list[dict]) -> str:
    first = next((m.get("content", "") for m in messages if m.get("role") == "user" and m.get("content")), "")
    first = " ".join(first.split())
    return (first[:70] + "…") if len(first) > 70 else (first or "New conversation")


class ChatIn(BaseModel):
    title: Optional[str] = Field(default=None, max_length=120)
    messages: list[dict[str, Any]] = Field(default_factory=list)
    board: Optional[dict[str, Any]] = None


class RenameIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)


@router.get("/{username}")
def list_chats(username: str, request: Request):
    assert_owner(request, username)
    items = read_json(_index_path(username), []) or []
    return {"chats": sorted(items, key=lambda c: -c.get("updated_at", 0))}


@router.get("/{username}/{chat_id}")
def get_chat(username: str, chat_id: str, request: Request):
    assert_owner(request, username)
    _check_id(chat_id)
    doc = read_json(_chat_path(username, chat_id), None)
    if doc is None:
        raise HTTPException(404, "Conversation not found.")
    return doc


@router.put("/{username}/{chat_id}")
def save_chat(username: str, chat_id: str, body: ChatIn, request: Request):
    assert_owner(request, username)
    _check_id(chat_id)
    messages = body.messages[-MAX_MESSAGES:]
    board = body.board
    if len(json.dumps(board or {})) > MAX_BYTES:
        board = None                       # oversized board history: keep the words, drop the boards
    now = time.time()
    prev = read_json(_chat_path(username, chat_id), None) or {}
    title = body.title or prev.get("title") or _title_from(messages)
    doc = {"id": chat_id, "title": title, "messages": messages, "board": board,
           "created_at": prev.get("created_at", now), "updated_at": now}
    write_json(_chat_path(username, chat_id), doc)
    preview = next((m.get("content", "")[:120] for m in reversed(messages) if m.get("role") == "assistant" and m.get("content")), "")

    def upsert(items: list):
        items = [c for c in items if c.get("id") != chat_id]
        items.append({"id": chat_id, "title": title, "created_at": doc["created_at"], "updated_at": now,
                      "messages": len(messages), "preview": preview})
        return items[-500:]
    locked_update(_index_path(username), [], upsert)
    return {"ok": True, "id": chat_id, "title": title, "updated_at": now}


@router.patch("/{username}/{chat_id}")
def rename_chat(username: str, chat_id: str, body: RenameIn, request: Request):
    assert_owner(request, username)
    _check_id(chat_id)
    doc = read_json(_chat_path(username, chat_id), None)
    if doc is None:
        raise HTTPException(404, "Conversation not found.")
    doc["title"] = body.title.strip()
    write_json(_chat_path(username, chat_id), doc)

    def apply(items: list):
        for c in items:
            if c.get("id") == chat_id:
                c["title"] = doc["title"]
        return items
    locked_update(_index_path(username), [], apply)
    return {"ok": True}


@router.delete("/{username}/{chat_id}")
def delete_chat(username: str, chat_id: str, request: Request):
    assert_owner(request, username)
    _check_id(chat_id)
    try:
        _chat_path(username, chat_id).unlink()
    except OSError:
        pass
    locked_update(_index_path(username), [], lambda items: [c for c in items if c.get("id") != chat_id])
    return {"ok": True}
