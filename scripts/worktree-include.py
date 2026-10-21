#!/usr/bin/env python3
"""orq worktree include: copy into a new task worktree the files .worktreeinclude names.

Usage: python3 scripts/worktree-include.py CHECKOUT WORKTREE DEADLINE_SECONDS
       python3 scripts/worktree-include.py --discard WORKTREE

Follows Claude Code's .worktreeinclude: a file is copied when it matches a pattern
of CHECKOUT/.worktreeinclude and is gitignored, so tracked files are never
duplicated. Whether a file is ignored is judged in WORKTREE, by the .gitignore
files of the commit the worktree holds, so a copied file never shows up there as
untracked.

The copy runs with the rights of the mod, outside any sandbox, so it never
follows a symlink: a source path below a symlink is skipped, a symlink is copied
as a symlink, and a path below a symlink the worktree holds is skipped. Untracked
nested repositories are skipped too.

The files are first copied into a staging directory beside WORKTREE, then each new
top-level path is renamed into place, so a failure, a signal or the deadline
leaves the worktree as git made it. `--discard` removes a staging directory that a
killed run left behind. Prints one JSON line, {"copied": N, "skipped": M}, and
exits 0, or prints the reason on stderr and exits 1 once the copy is undone.
"""
import errno
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import time

GIT = ["git", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false"]
CHUNK = 1 << 20
O_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
# A source path that is missing, not a directory, or a symlink where a directory was listed.
SKIP_ERRNOS = (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)


class Stop(Exception):
    pass


def on_signal(signum, _frame):
    raise Stop("stopped by signal %d" % signum)


def staging_for(worktree):
    parent, name = os.path.split(worktree.rstrip(b"/"))
    return os.path.join(parent, b".orq-include-" + name)


def git(cwd, args, stdin=None):
    p = subprocess.run(GIT + ["-C", cwd] + args, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return p.returncode, p.stdout, p.stderr.decode("utf-8", "replace").strip()


def listed(checkout, include):
    code, out, err = git(checkout, ["ls-files", "-z", "--others", "--ignored", b"--exclude-from=" + include])
    if code != 0:
        raise RuntimeError("git ls-files failed: " + err)
    return [p for p in out.split(b"\0") if p]


def ignored_in(worktree, paths):
    if not paths:
        return set()
    # check-ignore reads each path as a pathspec: "./" keeps a name such as ":memory:" from reading as
    # magic, and --no-index keeps a glob character from matching a tracked entry instead.
    data = b"".join(b"./" + p + b"\0" for p in paths)
    code, out, err = git(worktree, ["check-ignore", "-z", "--no-index", "--stdin"], stdin=data)
    if code not in (0, 1):
        raise RuntimeError("git check-ignore failed: " + err)
    return {p[2:] if p.startswith(b"./") else p for p in out.split(b"\0") if p}


def crosses_symlink(base, path):
    """True when a parent of `path` in `base` is a symlink or a file, so nothing may be written there."""
    current = base
    for part in path.split(b"/")[:-1]:
        current = os.path.join(current, part)
        if os.path.islink(current) or (os.path.lexists(current) and not os.path.isdir(current)):
            return True
    return False


def open_dir(root_fd, parts):
    """Open the directory `parts` below root_fd one component at a time, refusing any symlink."""
    fd = os.dup(root_fd)
    try:
        for part in parts:
            nxt = os.open(part, O_DIR, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def copy_file(src_fd, dst, st, deadline):
    out = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        while True:
            if time.monotonic() > deadline:
                raise Stop("the copy ran out of time")
            chunk = os.read(src_fd, CHUNK)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                view = view[os.write(out, view):]
        os.fchmod(out, stat.S_IMODE(st.st_mode))
    finally:
        os.close(out)
    os.utime(dst, ns=(st.st_atime_ns, st.st_mtime_ns))


def stage_one(root_fd, staging, path, modes, deadline):
    """Copy one path into staging. Returns False when the source is no longer a plain file or symlink."""
    parts = path.split(b"/")
    try:
        parent_fd = open_dir(root_fd, parts[:-1])
    except OSError as e:
        if e.errno in SKIP_ERRNOS:
            return False
        raise
    try:
        st = os.lstat(parts[-1], dir_fd=parent_fd)
        if not (stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode)):
            return False
        for depth in range(1, len(parts)):
            rel = b"/".join(parts[:depth])
            if rel not in modes:
                os.mkdir(os.path.join(staging, rel), 0o700)
                dir_fd = open_dir(root_fd, parts[:depth])
                modes[rel] = stat.S_IMODE(os.fstat(dir_fd).st_mode)
                os.close(dir_fd)
        dst = os.path.join(staging, path)
        if stat.S_ISLNK(st.st_mode):
            os.symlink(os.readlink(parts[-1], dir_fd=parent_fd), dst)
            return True
        src_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
        try:
            st = os.fstat(src_fd)
            if not stat.S_ISREG(st.st_mode):
                return False
            copy_file(src_fd, dst, st, deadline)
        finally:
            os.close(src_fd)
        return True
    finally:
        os.close(parent_fd)


def place(worktree, staging, copied, modes, deadline):
    """Rename each new top-level path from staging into the worktree, undoing the renames on a failure."""
    roots = []
    for path in copied:
        parts = path.split(b"/")
        for depth in range(1, len(parts) + 1):
            prefix = b"/".join(parts[:depth])
            if not os.path.lexists(os.path.join(worktree, prefix)):
                if prefix not in roots:
                    roots.append(prefix)
                break
    placed = []
    try:
        for root in roots:
            if time.monotonic() > deadline:
                raise Stop("the copy ran out of time")
            target = os.path.join(worktree, root)
            if crosses_symlink(worktree, root) or os.path.lexists(target):
                raise RuntimeError("the worktree changed during the copy")
            os.rename(os.path.join(staging, root), target)
            placed.append(target)
        # The directories the copy created take their source modes, deepest first, once nothing more goes in.
        for rel in sorted(modes, key=len, reverse=True):
            if any(rel == r or rel.startswith(r + b"/") for r in roots):
                os.chmod(os.path.join(worktree, rel), modes[rel])
    except BaseException:
        for target in reversed(placed):
            if os.path.isdir(target) and not os.path.islink(target):
                shutil.rmtree(target, ignore_errors=True)
            else:
                try:
                    os.unlink(target)
                except OSError:
                    pass
        raise


def copy(checkout, worktree, deadline):
    include = os.path.join(checkout, b".worktreeinclude")
    if not os.path.isfile(include):
        return 0, 0
    entries = listed(checkout, include)
    # An untracked nested repository is listed as one directory entry; it is not copied.
    files = [p for p in entries if not p.endswith(b"/")]
    safe = [p for p in files if not crosses_symlink(worktree, p)]
    wanted = ignored_in(worktree, safe)
    todo = [p for p in safe if p in wanted and not os.path.lexists(os.path.join(worktree, p))]
    staging = staging_for(worktree)
    shutil.rmtree(staging, ignore_errors=True)
    os.mkdir(staging, 0o700)
    root_fd = os.open(checkout, O_DIR)
    try:
        modes, copied = {}, []
        for path in todo:
            if time.monotonic() > deadline:
                raise Stop("the copy ran out of time")
            if stage_one(root_fd, staging, path, modes, deadline):
                copied.append(path)
        place(worktree, staging, copied, modes, deadline)
    finally:
        os.close(root_fd)
        shutil.rmtree(staging, ignore_errors=True)
    return len(copied), len(entries) - len(copied)


def main():
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGHUP, on_signal)
    args = [os.fsencode(a) for a in sys.argv[1:]]
    if len(args) == 2 and args[0] == b"--discard":
        shutil.rmtree(staging_for(args[1]), ignore_errors=True)
        return 0
    if len(args) != 3:
        print("usage: worktree-include.py CHECKOUT WORKTREE DEADLINE_SECONDS | --discard WORKTREE", file=sys.stderr)
        return 2
    checkout, worktree, seconds = args[0], args[1], float(args[2])
    try:
        copied, skipped = copy(checkout, worktree, time.monotonic() + seconds)
    except (Exception, Stop) as e:
        print(str(e), file=sys.stderr)
        return 1
    print(json.dumps({"copied": copied, "skipped": skipped}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
