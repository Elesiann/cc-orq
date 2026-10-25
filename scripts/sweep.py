#!/usr/bin/env python3
"""orq sweep: end every process whose environment holds one NAME=VALUE marker.

Usage: sweep.py NAME=VALUE [GRACE_SECONDS] [--spare-tree PID]...

A CLI can leave a process running after it exits, outside its process group, such
as an MCP server that was still starting when OpenCode quit. The leftover keeps the
environment it inherited, so a marker in the CLI's environment finds it: the
supervisor marks a job with ORQ_JOB_DIR, and the catalog probe marks each
`opencode models` call with ORQ_PROBE_ID.

This script and every ancestor of it stay alive, because its caller carries the
marker too, and so does each PID given to --spare-tree with everything below it:
a supervisor that sweeps after its CLI exited spares itself, so that its own
helper processes are not counted as leftovers. A process that ignores SIGTERM gets SIGKILL at once, since a
supervisor's descendants inherit that ignore and waiting for them is pointless.
The others get SIGTERM and GRACE_SECONDS (default 1) to exit, then SIGKILL. It
scans again after each round, up to five times, for a process spawned meanwhile.

It reads /proc, so where /proc is missing (macOS) it does nothing. It prints
nothing and exits 0 when no process carries the marker, and one line to stderr
when it ended some.
"""
import argparse
import os
import signal
import sys
import time

DEFAULT_GRACE_S = 1.0
MAX_GRACE_S = 30.0
MAX_PASSES = 5


def stat_fields(pid):
    """The fields of /proc/PID/stat after the command name: state, ppid, pgrp, ..."""
    with open("/proc/%d/stat" % pid) as f:
        data = f.read()
    return data[data.rindex(")") + 2:].split()


def ancestors(pid):
    """pid and every process above it."""
    seen = set()
    while pid > 1 and pid not in seen:
        seen.add(pid)
        try:
            pid = int(stat_fields(pid)[1])
        except (OSError, ValueError, IndexError):
            break
    return seen


def is_alive(pid):
    try:
        return stat_fields(pid)[0] != "Z"
    except (OSError, IndexError):
        return False


def ignores_term(pid):
    try:
        with open("/proc/%d/status" % pid) as f:
            for line in f:
                if line.startswith("SigIgn:"):
                    return bool(int(line.split()[1], 16) & (1 << (signal.SIGTERM - 1)))
    except (OSError, ValueError, IndexError):
        pass
    return False


def carrying(needle, spare):
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit() or int(entry) in spare:
            continue
        try:
            with open("/proc/%s/environ" % entry, "rb") as f:
                if needle in f.read().split(b"\0"):
                    found.append(int(entry))
        except OSError:
            continue
    return found


def send(pid, sig):
    try:
        os.kill(pid, sig)
    except OSError:
        pass


def below(roots):
    """Every process at or below one of the roots."""
    children = {}
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            try:
                children.setdefault(int(stat_fields(int(entry))[1]), []).append(int(entry))
            except (OSError, ValueError, IndexError):
                continue
    found, stack = set(), list(roots)
    while stack:
        pid = stack.pop()
        if pid not in found:
            found.add(pid)
            stack.extend(children.get(pid, []))
    return found


def sweep(marker, grace, spare_trees):
    spare = ancestors(os.getpid()) | below(spare_trees)
    needle = marker.encode()
    ended = set()
    for _ in range(MAX_PASSES):
        pids = [p for p in carrying(needle, spare) if is_alive(p)]
        if not pids:
            break
        ended.update(pids)
        asked = []
        for pid in pids:
            if ignores_term(pid):
                send(pid, signal.SIGKILL)
            else:
                send(pid, signal.SIGTERM)
                asked.append(pid)
        deadline = time.monotonic() + grace
        while asked and time.monotonic() < deadline:
            asked = [p for p in asked if is_alive(p)]
            time.sleep(0.02)
        for pid in asked:
            send(pid, signal.SIGKILL)
        time.sleep(0.05)
    return len(ended)


def main():
    parser = argparse.ArgumentParser(description="End every process whose environment holds NAME=VALUE.")
    parser.add_argument("marker", metavar="NAME=VALUE")
    parser.add_argument("grace", nargs="?", type=float, default=DEFAULT_GRACE_S, metavar="GRACE_SECONDS")
    parser.add_argument("--spare-tree", type=int, action="append", default=[], metavar="PID")
    args = parser.parse_args()
    if not args.marker.partition("=")[0] or "=" not in args.marker:
        parser.error("the marker must be NAME=VALUE")
    if not os.path.isdir("/proc/self"):
        return 0
    count = sweep(args.marker, min(max(args.grace, 0.0), MAX_GRACE_S), args.spare_tree)
    if count:
        sys.stderr.write("orq: ended %d process%s that carried %s\n" % (count, "" if count == 1 else "es", args.marker.partition("=")[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
