#!/usr/bin/env python3
"""orq event extractor: stream a CLI JSONL log, print one JSON summary line.

Usage: extract.py <events.jsonl> <codex|opencode|agy|claude>

Prints: {"tid": "<thread/session id or ''>", "in": <int>, "out": <int>,
         "error": <bool>} plus an optional "model" key when the stream names
the model (agy `init.init.model`, claude the first `result.modelUsage`
key). Reads line by line, so logs larger than the mod's read cap are fine.
Per-line parse failures are skipped; only a missing/unreadable file exits
nonzero.
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[2] not in ("codex", "opencode", "agy", "claude"):
        print(json.dumps({"tid": "", "in": 0, "out": 0, "error": False}))
        return 2
    path, runner = sys.argv[1], sys.argv[2]
    tid = ""
    in_tok = 0
    out_tok = 0
    error = False
    model = ""
    try:
        f = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        print(json.dumps({"tid": "", "in": 0, "out": 0, "error": False}))
        return 1
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if not isinstance(o, dict):
                continue
            if runner == "codex":
                if o.get("type") == "thread.started" and not tid and isinstance(o.get("thread_id"), str):
                    tid = o["thread_id"]
                elif o.get("type") == "item.completed" and isinstance(o.get("item"), dict):
                    item = o["item"]
                    if item.get("type") == "error":
                        error = True
                    elif item.get("type") == "agent_message" and isinstance(item.get("text"), str):
                        pass
                elif o.get("type") == "turn.completed" and isinstance(o.get("usage"), dict):
                    u = o["usage"]
                    if isinstance(u.get("input_tokens"), int):
                        in_tok = u["input_tokens"]
                    if isinstance(u.get("output_tokens"), int):
                        out_tok = u["output_tokens"]
            elif runner == "opencode":
                if not tid and isinstance(o.get("sessionID"), str) and o["sessionID"]:
                    tid = o["sessionID"]
                part = o.get("part")
                if isinstance(part, dict) and part.get("type") == "step-finish":
                    toks = part.get("tokens")
                    if isinstance(toks, dict):
                        if isinstance(toks.get("input"), int):
                            in_tok += toks["input"]
                        if isinstance(toks.get("output"), int):
                            out_tok += toks["output"]
            elif runner == "agy":
                if not tid and isinstance(o.get("conversation_id"), str) and o["conversation_id"]:
                    tid = o["conversation_id"]
                if o.get("event") == "init" and not model and isinstance(o.get("init"), dict):
                    m = o["init"].get("model")
                    if isinstance(m, str) and m:
                        model = m
                if o.get("event") == "result" and isinstance(o.get("result"), dict):
                    r = o["result"]
                    if not tid and isinstance(r.get("conversation_id"), str) and r["conversation_id"]:
                        tid = r["conversation_id"]
                    u = r.get("usage")
                    if isinstance(u, dict):
                        if isinstance(u.get("input_tokens"), int):
                            in_tok = u["input_tokens"]
                        if isinstance(u.get("output_tokens"), int):
                            out_tok = u["output_tokens"]
                    if r.get("error"):
                        error = True
                    status = r.get("status")
                    if isinstance(status, str) and status and status.upper() != "SUCCESS":
                        error = True
            else:  # claude
                if not tid and isinstance(o.get("session_id"), str) and o["session_id"]:
                    tid = o["session_id"]
                if o.get("type") == "result":
                    if isinstance(o.get("is_error"), bool) and o["is_error"]:
                        error = True
                    subtype = o.get("subtype")
                    if isinstance(subtype, str) and subtype and subtype.lower() != "success":
                        error = True
                    u = o.get("usage")
                    if isinstance(u, dict):
                        if isinstance(u.get("input_tokens"), int):
                            in_tok = u["input_tokens"]
                        if isinstance(u.get("output_tokens"), int):
                            out_tok = u["output_tokens"]
                    mu = o.get("modelUsage")
                    if not model and isinstance(mu, dict) and mu:
                        first = next(iter(mu))
                        if isinstance(first, str) and first:
                            model = first
    out = {"tid": tid, "in": in_tok, "out": out_tok, "error": error}
    if model:
        out["model"] = model
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
