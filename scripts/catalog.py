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
  opencode    `opencode models --standalone` (one provider/model per line).
              OpenCode lists only the providers it can use, logged in or
              configured through the environment, so every listed model is
              kept, as T3 does.
  antigravity `agy models` (tab-separated id and label; effort is in the id).
  claudeAgent the `claude` CLI; models are the haiku/sonnet/opus aliases
              accepted by `claude -p --model`, mirroring T3's
              ClaudeModelCatalog user-facing aliases.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid

EFFORT_OPTION = "reasoningEffort"
TIMEOUT_S = 60

CLAUDE_ALIASES = ("haiku", "sonnet", "opus")

OPENCODE_SLUG = re.compile(r"^\s*[^\s/]+/\S+\s*$")

# --standalone lists on a private server that ends with the command. Without it OpenCode hands the
# command to its shared background service, which starts the user's MCP servers on every call and
# leaves them running.
OPENCODE_MODELS = ["opencode", "models", "--standalone"]

SWEEP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sweep.py")


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


def run_opencode_models(env):
    """Run OPENCODE_MODELS, then end what it left running. An MCP server that was still starting when OpenCode
    exited is orphaned and outlives the command, and the probe runs on every capabilities call. Every process
    of the call carries ORQ_PROBE_ID, which nothing else shares, so sweep.py finds it."""
    probe_id = uuid.uuid4().hex
    try:
        return run(OPENCODE_MODELS, dict(env, ORQ_PROBE_ID=probe_id))
    finally:
        try:
            subprocess.run(
                [sys.executable, SWEEP, "ORQ_PROBE_ID=" + probe_id],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            pass


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
    code, out = run_opencode_models(env)
    if code not in (0, 127):
        # OpenCode commands share one SQLite database, so a concurrent run can fail it once.
        time.sleep(1)
        code, out = run_opencode_models(env)
    if code != 0:
        return True, None, [], "'%s' failed (exit %d)." % (" ".join(OPENCODE_MODELS), code)
    # The label would repeat the id after the slash, and OpenCode can list hundreds of models.
    models = [{"id": line.strip(), "label": None} for line in out.splitlines() if OPENCODE_SLUG.match(line)]
    if not models:
        return True, None, [], "OpenCode is available, but it did not report any connected upstream providers."
    return True, True, models, None


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
