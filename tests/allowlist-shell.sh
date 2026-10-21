#!/bin/bash
# allowlist shell suite: the repository holds only what a user of the plugin needs. Every tracked
# path must sit under one of the allowed directories or be one of the allowed files, so a plan, a
# log or a local note never reaches the public tree.
#
# Usage: bash tests/allowlist-shell.sh
set -e -o pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

DIRS='.claude-plugin .github hooks opencode scripts tests types'
FILES='.gitignore CHANGELOG.md CONTRIBUTING.md LICENSE NOTICE README.md SECURITY.md instructions.md package-lock.json package.json tsconfig.json'

PASS=0; FAIL=0
while IFS= read -r path; do
  allowed=0
  for d in $DIRS; do case "$path" in "$d"/*) allowed=1 ;; esac; done
  for f in $FILES; do [ "$path" = "$f" ] && allowed=1; done
  if [ "$allowed" -eq 1 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: not on the allowlist: $path"; fi
done < <(git ls-files)

for f in $FILES; do
  [ -f "$f" ] || { FAIL=$((FAIL+1)); echo "FAIL: allowed file missing: $f"; }
done

echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
