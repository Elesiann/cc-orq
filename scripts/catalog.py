#!/usr/bin/env python3
"""orq provider catalog probe: print one ProviderInstance[] JSON document.

Usage: echo '<instances config JSON>' | python3 scripts/catalog.py

The config is a JSON list of {instanceId, driver, displayName?, env?,
enabled?}. Each entry is probed against the live CLI on this machine and
becomes a ProviderInstance (see hooks/contract.ts). Per-driver failures are
captured in unavailableReason instead of crashing; a missing executable
yields installed=false with empty models. Configured `env` values are used
only to run the CLIs and are never printed.

Drivers:
  codex       `codex debug models` (visibility == "list" only, as T3 does),
              reasoning effort from supported_reasoning_levels, auth via
              `codex login status`. One instance per CODEX_HOME.
  opencode    `opencode models` (one provider/model per line) filtered to
              provider ids from `opencode auth list --format json`.
  antigravity `agy models` (tab-separated id and label; effort is in the id).
  claudeAgent the `claude` CLI; models are the haiku/sonnet/opus aliases
              accepted by `claude -p --model`, mirroring T3's
              ClaudeModelCatalog user-facing aliases.

Only provider ids are read from the opencode auth list; nothing else from
it is printed or stored.
"""
import json
import os
import shutil
import subprocess
import sys

EFFORT_OPTION = "reasoningEffort"
TIMEOUT_S = 60

CLAUDE_ALIASES = ("haiku", "sonnet", "opus")


def run(cmd, env, timeout=TIMEOUT_S):
    """Run cmd, return (exit_code, stdout). Timeouts/exec errors -> (127, '')."""
    try:
        p = subprocess.run(
            cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=timeout,
        )
        return p.returncode, p.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


def instance_env(base, extra):
    env = dict(base)
    if not isinstance(extra, dict):
        return env
    for k, v in extra.items():
        if isinstance(v, str):
            env[k] = os.path.expandvars(os.path.expanduser(v))
    return env


def effort_descriptor(levels, default):
    if not isinstance(levels, list):
        levels = []
    if not isinstance(default, str):
        default = None
    options = []
    for lv in levels:
        if not isinstance(lv, dict):
            continue
        effort = lv.get("effort")
        if not isinstance(effort, str) or not effort:
            continue
        opt = {"id": effort, "label": effort}
        if lv.get("description"):
            opt["description"] = lv["description"]
        if default is not None and effort == default:
            opt["isDefault"] = True
        options.append(opt)
    if not options:
        return None
    desc = {
        "id": EFFORT_OPTION,
        "label": "Reasoning effort",
        "type": "select",
        "options": options,
    }
    if default is not None:
        desc["currentValue"] = default
    return desc


def probe_codex(env):
    if shutil.which("codex", path=env.get("PATH")) is None:
        return False, None, [], "Executable 'codex' was not found on PATH."
    code, out = run(["codex", "debug", "models"], env)
    if code != 0:
        return True, None, [], "'codex debug models' failed (exit %d)." % code
    try:
        doc = json.loads(out)
    except ValueError:
        return True, None, [], "'codex debug models' printed unparseable JSON."
    if not isinstance(doc, dict):
        return True, None, [], "'codex debug models' printed unparseable JSON."
    raw = doc.get("models")
    if not isinstance(raw, list):
        return True, None, [], "'codex debug models' printed unparseable JSON."
    models = []
    for m in raw:
        if not isinstance(m, dict) or m.get("visibility") != "list":
            continue
        slug = m.get("slug")
        if not slug:
            continue
        entry = {"id": slug, "label": m.get("display_name")}
        desc = effort_descriptor(
            m.get("supported_reasoning_levels"), m.get("default_reasoning_level")
        )
        if desc is not None:
            entry["options"] = [desc]
        models.append(entry)
    login_code, _ = run(["codex", "login", "status"], env)
    return True, login_code == 0, models, None


def probe_opencode(env):
    if shutil.which("opencode", path=env.get("PATH")) is None:
        return False, None, [], "Executable 'opencode' was not found on PATH."
    code, out = run(["opencode", "auth", "list", "--format", "json"], env)
    if code != 0:
        return True, None, [], "'opencode auth list' failed (exit %d)." % code
    try:
        entries = json.loads(out)
    except ValueError:
        return True, None, [], "'opencode auth list' printed unparseable JSON."
    if not isinstance(entries, list):
        return True, None, [], "'opencode auth list' printed unparseable JSON."
    logged_in = {
        e["id"] for e in entries
        if isinstance(e, dict) and isinstance(e.get("id"), str)
    }
    code, out = run(["opencode", "models"], env)
    if code != 0:
        return True, None, [], "'opencode models' failed (exit %d)." % code
    models = []
    for line in out.splitlines():
        line = line.strip()
        if not line or "/" not in line:
            continue
        provider, name = line.split("/", 1)
        if provider not in logged_in or not name:
            continue
        models.append({"id": line, "label": name})
    return True, len(logged_in) > 0, models, None


def probe_antigravity(env):
    if shutil.which("agy", path=env.get("PATH")) is None:
        return False, None, [], "Executable 'agy' was not found on PATH."
    code, out = run(["agy", "models"], env)
    if code != 0:
        return True, None, [], "'agy models' failed (exit %d)." % code
    models = []
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        model_id = parts[0].strip()
        if not model_id:
            continue
        label = parts[1].strip() if len(parts) > 1 and parts[1].strip() else None
        models.append({"id": model_id, "label": label})
    return True, None, models, None


def probe_claude(env):
    if shutil.which("claude", path=env.get("PATH")) is None:
        return False, None, [], "Executable 'claude' was not found on PATH."
    return True, None, [{"id": a, "label": None} for a in CLAUDE_ALIASES], None


PROBES = {
    "codex": (probe_codex, "codex"),
    "opencode": (probe_opencode, "opencode"),
    "antigravity": (probe_antigravity, "antigravity"),
    "claudeAgent": (probe_claude, "claudeAgent"),
}


def probe_instance(cfg, base_env):
    # The printed instance never carries `env` values: the configured env is
    # used only to probe the CLI, never echoed back.
    instance = {
        "instanceId": "",
        "driver": None,
        "displayName": None,
        "enabled": True,
        "installed": False,
        "authenticated": None,
        "unavailableReason": None,
        "models": [],
    }
    if not isinstance(cfg, dict):
        instance["unavailableReason"] = "Instance config entry is not an object."
        return instance
    instance_id = cfg.get("instanceId", "")
    driver = cfg.get("driver")
    env = instance_env(base_env, cfg.get("env"))
    instance.update({
        "instanceId": instance_id,
        "driver": driver,
        "displayName": cfg.get("displayName"),
        "enabled": cfg.get("enabled", True),
    })
    if driver not in PROBES:
        instance["unavailableReason"] = "Unknown driver '%s'." % (driver,)
        return instance
    if not cfg.get("enabled", True):
        instance["installed"] = (
            shutil.which(
                {"codex": "codex", "opencode": "opencode",
                 "antigravity": "agy", "claudeAgent": "claude"}[driver],
                path=env.get("PATH"),
            )
            is not None
        )
        return instance
    probe, _ = PROBES[driver]
    try:
        installed, authenticated, models, reason = probe(env)
    except Exception as e:
        instance["unavailableReason"] = "Probe '%s' failed: %s." % (driver, e)
        return instance
    instance["installed"] = installed
    instance["authenticated"] = authenticated
    instance["models"] = models if isinstance(models, list) else []
    instance["unavailableReason"] = reason
    return instance


def main() -> int:
    try:
        config = json.load(sys.stdin)
    except ValueError as e:
        print(json.dumps({"error": "instances config on stdin is not JSON: %s" % e}))
        return 2
    if not isinstance(config, list):
        print(json.dumps({"error": "instances config must be a JSON list."}))
        return 2
    print(json.dumps([probe_instance(c, os.environ) for c in config]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
