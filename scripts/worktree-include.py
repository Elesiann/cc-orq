#!/usr/bin/env python3
"""orq worktree include: copy into a new task worktree the files .worktreeinclude names.

Usage: python3 scripts/worktree-include.py CHECKOUT WORKTREE DEADLINE_SECONDS

Follows Claude Code's .worktreeinclude: a file is copied when it matches a pattern
of CHECKOUT/.worktreeinclude and is gitignored, so tracked files are never
duplicated. Whether a file is ignored is judged in WORKTREE, by the .gitignore
files of the commit the worktree holds, so a copied file never shows up there as
untracked. A path whose parent in WORKTREE is a symlink is skipped, so the copy
never writes outside WORKTREE, and so is an untracked nested repository.

The copy is all or nothing: on any error, or once DEADLINE_SECONDS have passed,
every file and directory it created is removed again. Prints one JSON line,
{"copied": N, "skipped": M}, and exits 0, or prints the reason on stderr and
exits 1.
"""
import json
import os
import shutil
import subprocess
import sys
import time

GIT = ["git", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false"]


def git(cwd, args, stdin=None):
    p = subprocess.run(GIT + ["-C", cwd] + args, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return p.returncode, p.stdout, p.stderr.decode("utf-8", "replace").strip()


def candidates(checkout, include):
    code, out, err = git(checkout, ["ls-files", "-z", "--others", "--ignored", "--exclude-from=" + include])
    if code != 0:
        raise RuntimeError("git ls-files failed: " + err)
    # An untracked nested repository is listed as one directory entry; it is not copied.
    return [p for p in out.decode("utf-8", "surrogateescape").split("\0") if p and not p.endswith("/")]


def ignored_in(worktree, paths):
    if not paths:
        return set()
    # check-ignore reads each path as a pathspec; "./" keeps a name such as ":memory:" from reading as magic.
    data = "".join("./" + p + "\0" for p in paths).encode("utf-8", "surrogateescape")
    code, out, err = git(worktree, ["check-ignore", "-z", "--no-index", "--stdin"], stdin=data)
    if code not in (0, 1):
        raise RuntimeError("git check-ignore failed: " + err)
    return {p[2:] if p.startswith("./") else p for p in out.decode("utf-8", "surrogateescape").split("\0") if p}


def crosses_symlink(worktree, path):
    parts = path.split("/")[:-1]
    current = worktree
    for part in parts:
        current = os.path.join(current, part)
        if os.path.islink(current):
            return True
    return False


def copy(checkout, worktree, deadline):
    include = os.path.join(checkout, ".worktreeinclude")
    if not os.path.isfile(include):
        return 0, 0
    listed = []
    skipped = 0
    for path in candidates(checkout, include):
        # git refuses a path beyond a symlink, and writing there would leave the worktree.
        if crosses_symlink(worktree, path):
            skipped += 1
        else:
            listed.append(path)
    wanted = ignored_in(worktree, listed)
    created_files, created_dirs = [], []
    copied = 0
    try:
        for path in listed:
            if time.monotonic() > deadline:
                raise TimeoutError("the copy ran out of time")
            src = os.path.join(checkout, path)
            dst = os.path.join(worktree, path)
            if path not in wanted or os.path.lexists(dst):
                skipped += 1
                continue
            if not os.path.islink(src) and not os.path.isfile(src):
                skipped += 1
                continue
            parent = os.path.dirname(dst)
            missing = []
            while not os.path.isdir(parent):
                missing.append(parent)
                parent = os.path.dirname(parent)
            for d in reversed(missing):
                os.mkdir(d)
                created_dirs.append(d)
            if os.path.islink(src):
                os.symlink(os.readlink(src), dst)
            else:
                shutil.copy2(src, dst)
            created_files.append(dst)
            copied += 1
    except BaseException:
        for f in reversed(created_files):
            try:
                os.unlink(f)
            except OSError:
                pass
        for d in reversed(created_dirs):
            try:
                os.rmdir(d)
            except OSError:
                pass
        raise
    return copied, skipped


def main():
    if len(sys.argv) != 4:
        print("usage: worktree-include.py CHECKOUT WORKTREE DEADLINE_SECONDS", file=sys.stderr)
        return 2
    checkout, worktree, seconds = sys.argv[1], sys.argv[2], float(sys.argv[3])
    try:
        copied, skipped = copy(checkout, worktree, time.monotonic() + seconds)
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1
    print(json.dumps({"copied": copied, "skipped": skipped}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
