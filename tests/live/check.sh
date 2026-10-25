#!/usr/bin/env bash
# Checks of the live harness itself. They need no login, network or model: the harness runs against a fake
# claude and either a fake tmux or a tmux server on a private socket, in a sandbox of its own for each check, so
# they never touch a session, process or directory of the user. Names start with the review finding they cover;
# a d in front marks a finding of the delta review, whose numbers repeat the first review's.
#
# Usage: bash tests/live/check.sh [CHECK...]
#   LIVE_UNDER_TEST  the directory with lib.sh, run.sh, headless.sh and scenarios/ to check (default: this one)
#
# No check starts, queries or stops a tmux server it did not name with -S. A sandbox closes the sessions that its
# own sockets still hold, one by exact name, and ends the processes that run inside its directory.
# shellcheck disable=SC1090,SC1091,SC2030,SC2031 # the sourced files are chosen at run time, and every check runs in a subshell of its own on purpose
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
UNDER=$(cd "${LIVE_UNDER_TEST:-$HERE}" && pwd)
REAL_TMUX=$(command -v tmux || true)

ALL=(
  baseline
  w1_settings w1_permission_mode w1_connectors w1_assertions
  w2_results
  w3_shared_repo
  w4_git_config
  w5_exclude_list
  w6_relative_paths
  w7_wait_budget
  w8_foreign_receipts
  w9_cleanup_exact w9_exit_exact w9_start_duplicate
  w10_kill_escalation w10_reaper w10_forged_state
  i1_memory_line
  i3_executable
  i5_stable_scratch
  s1_private_scratch_root s2_private_tmux_socket s3_no_server_kill
  dw1_slow_footer dw1_trust_dialog
  dw2_dotdot_root dw2_scenario_name dw2_work_inside_root
  di1_tmux_wrapper
  di2_headless_memory
  di3_foreign_server
  di4_existing_root
)

fail() {
  printf '    %s\n' "$*"
  exit 1
}

alive() {
  local state
  state=$(ps -o stat= -p "$1" 2> /dev/null) || return 1
  case $state in '' | Z*) return 1 ;; esac
}

pids_under() {
  find /proc -maxdepth 2 -name cwd \( -lname "$1" -o -lname "$1/*" \) 2> /dev/null |
    sed -n 's|^/proc/\([0-9]*\)/cwd$|\1|p'
}

sandbox() {
  TMP=$1
  mkdir -p "$TMP"/{home,tmp,bin,plugin/.claude-plugin,ev,scratch,fake,log}
  chmod 700 "$TMP/scratch"
  printf '{"name":"cc-orq"}\n' > "$TMP/plugin/.claude-plugin/plugin.json"
  ln -s "$HERE/fake-claude.sh" "$TMP/bin/claude"
  ln -s "$HERE/fake-tmux.sh" "$TMP/bin/tmux"
  export TMP
  export HOME=$TMP/home TMPDIR=$TMP/tmp PLUGIN_DIR=$TMP/plugin CLAUDE_BIN=$TMP/bin/claude
  export ORQ_EVIDENCE_DIR=$TMP/ev ORQ_EVIDENCE=$TMP/ev/sandbox ORQ_SCENARIO=sandbox
  export ORQ_LIVE_SCRATCH_DIR=$TMP/scratch ORQ_LIVE_TMUX_PREFIX=orq-chk
  export FAKE_LOG_DIR=$TMP/log FAKE_TMUX_DIR=$TMP/fake
  export PATH=$TMP/bin:$PATH
  unset TMUX TMUX_TMPDIR XDG_RUNTIME_DIR ORQ_CLAUDE_MD_EXCLUDE_FILES ORQ_LIVE_PERMISSION_MODE FAKE_CLAUDE_CASE
  unset FAKE_TMUX_CASE GIT_CONFIG_GLOBAL LIVE_TMUX_SOCKET
}

# A tmux server exits with its last session, so closing the sessions on the sandbox's sockets, each by exact name,
# is enough.
sandbox_cleanup() {
  local tmp=$1 pid sock name
  for pid in $(pids_under "$tmp"); do kill -9 "$pid" 2> /dev/null || true; done
  if [ -n "$REAL_TMUX" ]; then
    while IFS= read -r sock; do
      for name in $("$REAL_TMUX" -f /dev/null -S "$sock" list-sessions -F '#{session_name}' 2> /dev/null); do
        "$REAL_TMUX" -f /dev/null -S "$sock" kill-session -t "=$name" 2> /dev/null || true
      done
    done < <(find "$tmp" -type s -name 'tmux.sock' 2> /dev/null)
  fi
  for pid in $(pids_under "$tmp"); do kill -9 "$pid" 2> /dev/null || true; done
  rm -rf -- "$tmp"
}

# Put the real tmux in the sandbox's PATH. Every call starts with the sandbox's own socket, so none reaches the
# user's default server; a socket that the call names itself comes later, and the last -S wins.
use_real_tmux() {
  [ -n "$REAL_TMUX" ] || fail "tmux is not installed"
  rm -f "$TMP/bin/tmux"
  cat > "$TMP/bin/tmux" << EOF
#!/bin/sh
exec $(printf '%q' "$REAL_TMUX") -S $(printf '%q' "$TMP/tmux.sock") "\$@"
EOF
  chmod +x "$TMP/bin/tmux"
  hash -r
}

harness_tmux() {
  if [ -n "${LIVE_TMUX_SOCKET:-}" ]; then
    "$REAL_TMUX" -f /dev/null -S "$LIVE_TMUX_SOCKET" "$@"
  else
    tmux "$@"
  fi
}

live_copy() {
  cp -a "$UNDER" "$TMP/live"
  cat > "$TMP/live/scenarios/noop.sh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
live_setup
printf '%s\n' "$ORQ_EVIDENCE" > "$ORQ_EVIDENCE/evidence-path.txt"
printf '%s\n' "$LIVE_REPO" > "$ORQ_EVIDENCE/repo-path.txt"
EOF
}

run_scenario() { bash "$TMP/live/run.sh" "$@" 2>&1; }

expect_fail() {
  local scenario=$1 pattern=$2 why=$3 out
  if out=$(run_scenario "$scenario"); then fail "$why: run.sh printed '$out' and exited 0"; fi
  grep -q "^FAIL $scenario: .*$pattern" <<< "$out" || fail "$why: run.sh printed '$out'"
}

check_baseline() {
  live_copy
  out=$(run_scenario smoke) || fail "smoke does not pass against the fakes: $out"
  out=$(run_scenario smoke-mods) || fail "smoke-mods does not pass against the fakes: $out"
  [ ! -e "$HOME/.claude" ] || fail "the harness wrote under \$HOME/.claude"
}

check_w1_settings() {
  source "$UNDER/lib.sh"
  for mods in on off; do
    live_settings "$mods" | jq -e '.disableClaudeAiConnectors == true' > /dev/null ||
      fail "live_settings $mods does not disable the claude.ai connectors"
  done
  live_settings off | jq -e '.disableAllHooks == true' > /dev/null || fail "live_settings off keeps the hooks on"
  live_settings on | jq -e 'has("disableAllHooks") | not' > /dev/null || fail "live_settings on disables the hooks"
}

check_w1_permission_mode() {
  source "$UNDER/lib.sh"
  mode_of() { live_build_claude_cmd off "$TMP/debug.log" && printf '%s\n' "${LIVE_CLAUDE_CMD[@]}" | grep -A1 -x -- '--permission-mode' | tail -1; }
  [ "$(mode_of)" = manual ] || fail "the nested session is not pinned to the manual mode: '$(mode_of)'"
  export ORQ_LIVE_PERMISSION_MODE=plan
  [ "$(mode_of)" = plan ] || fail "ORQ_LIVE_PERMISSION_MODE does not override the mode: '$(mode_of)'"
  export ORQ_LIVE_PERMISSION_MODE=auto
  ( live_build_claude_cmd off "$TMP/debug.log" ) > /dev/null 2>&1 && fail "the auto mode is accepted"
  return 0
}

check_w1_connectors() {
  live_copy
  out=$(run_scenario smoke) || fail "smoke does not pass against the fakes: $out"
  if grep -q '^mcp__claude_ai_' "$ORQ_EVIDENCE_DIR/smoke/init-tools.txt"; then
    fail "the nested session got the claude.ai connectors: $(grep -m1 '^mcp__claude_ai_' "$ORQ_EVIDENCE_DIR/smoke/init-tools.txt")"
  fi
  [ -s "$ORQ_EVIDENCE_DIR/smoke/init-tools.txt" ] || fail "the scenario left no init-tools.txt"
}

check_w1_assertions() {
  live_copy
  for scenario in smoke smoke-mods; do
    FAKE_CLAUDE_CASE=connector expect_fail "$scenario" 'claude.ai connector' "a session with connectors passed $scenario"
    FAKE_CLAUDE_CASE=auto-mode expect_fail "$scenario" 'permission mode' "a session in auto mode passed $scenario"
  done
  FAKE_TMUX_CASE=auto-footer expect_fail smoke 'auto mode' "an interactive session in auto mode passed smoke"
}

check_w2_results() {
  live_copy
  FAKE_CLAUDE_CASE=error-result expect_fail smoke 'answered with an error' "an error result of list passed"
  FAKE_CLAUDE_CASE=bad-shape expect_fail smoke 'documented shape' "a list answer without jobs passed"
  FAKE_CLAUDE_CASE=not-json expect_fail smoke 'not JSON' "a list answer that is not JSON passed"
}

check_w3_shared_repo() {
  mkdir -p "$TMP/repo"
  repo=$(cd "$TMP/repo" && pwd -P)
  printf 'x\n' > "$TMP/prompt.txt"
  (cd "$TMP" && LIVE_REPO=$repo bash "$UNDER/headless.sh" "$TMP/prompt.txt" "$TMP/out") ||
    fail "headless.sh exited $?"
  seen=$(tail -1 "$FAKE_LOG_DIR/cwd.txt")
  [ "$seen" = "$repo" ] || fail "headless.sh ran the session in $seen, not in LIVE_REPO $repo"

  live_copy
  : > "$FAKE_LOG_DIR/cwd.txt"
  out=$(run_scenario smoke) || fail "smoke does not pass against the fakes: $out"
  headless=$(readlink -m "$(head -1 "$FAKE_LOG_DIR/cwd.txt")")
  interactive=$(readlink -m "$(head -1 "$FAKE_LOG_DIR/tmux-cwd.txt")")
  [ "$headless" = "$interactive" ] || fail "the headless session ran in $headless and the tmux session in $interactive"
}

check_w4_git_config() {
  mkdir -p "$TMP/hooks"
  printf '#!/bin/sh\ntouch "%s/hook-ran"\nexit 1\n' "$TMP" > "$TMP/hooks/pre-commit"
  chmod +x "$TMP/hooks/pre-commit"
  printf '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /bin/false\n[core]\n\thooksPath = %s\n' "$TMP/hooks" > "$TMP/gitconfig"
  export GIT_CONFIG_GLOBAL=$TMP/gitconfig
  out=$( (
    source "$UNDER/lib.sh"
    live_setup
  ) 2>&1) || fail "live_setup fails under a global git config that signs and hooks every commit: $(printf '%s' "$out" | head -1)"
  [ ! -e "$TMP/hook-ran" ] || fail "a global git hook ran in the scratch repository"
}

check_w5_exclude_list() {
  (
    source "$UNDER/lib.sh"
    export ORQ_CLAUDE_MD_EXCLUDE_FILES="$TMP/a b/CLAUDE.md"
    live_settings off | jq -e --arg f "$TMP/a b/CLAUDE.md" '.claudeMdExcludes == [$f]' > /dev/null
  ) || fail "a path with a space was split into several excludes"
  (
    HOME="$TMP/h h"
    source "$UNDER/lib.sh"
    live_settings on | jq -e --arg f "$HOME/.claude/CLAUDE.md" '.claudeMdExcludes == [$f]' > /dev/null
  ) || fail "the default excludes are not exactly \$HOME/.claude/CLAUDE.md when HOME has a space"
  (
    source "$UNDER/lib.sh"
    export ORQ_CLAUDE_MD_EXCLUDE_FILES=$'/x/one.md\n/y/two.md'
    live_settings on | jq -e '.claudeMdExcludes == ["/x/one.md", "/y/two.md"]' > /dev/null
  ) || fail "a newline-separated list is not read as one exclude per line"
}

check_w6_relative_paths() {
  mkdir -p "$TMP/cwd" "$TMP/repo"
  printf 'x\n' > "$TMP/cwd/p.txt"
  (cd "$TMP/cwd" && PLUGIN_DIR=../plugin CLAUDE_BIN=../bin/claude LIVE_REPO=$TMP/repo \
    bash "$UNDER/headless.sh" p.txt out) || fail "headless.sh does not run with relative paths (exit $?)"
  [ -s "$TMP/cwd/out/stream.jsonl" ] || fail "the receipts did not land in the caller's directory"
  args=$(find "$FAKE_LOG_DIR" -name 'args.*.txt' | tail -1)
  for flag in --plugin-dir --debug-file; do
    value=$(grep -A1 -x -- "$flag" "$args" | tail -1)
    case $value in /*) ;; *) fail "$flag reached claude as '$value', which is relative to the caller" ;; esac
  done

  live_copy
  (cd "$TMP/cwd" && ORQ_EVIDENCE_DIR=rel-ev bash "$TMP/live/run.sh" noop > /dev/null 2>&1) ||
    fail "run.sh does not run with a relative ORQ_EVIDENCE_DIR"
  case $(cat "$TMP/cwd/rel-ev/noop/evidence-path.txt" 2> /dev/null) in
    /*) ;; *) fail "the scenario got a relative ORQ_EVIDENCE: '$(cat "$TMP/cwd/rel-ev/noop/evidence-path.txt" 2> /dev/null)'" ;; esac
}

check_w7_wait_budget() {
  rm -f "$TMP/bin/tmux"
  printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/tmux"
  chmod +x "$TMP/bin/tmux"
  hash -r
  start=$SECONDS
  (
    source "$UNDER/lib.sh"
    LIVE_TMUX_SOCKET=$TMP/w7.sock
    live_tmux_wait orq-chk-w7 'never shown' 4
  ) && fail "live_tmux_wait found a pattern in an empty pane"
  elapsed=$((SECONDS - start))
  [ "$elapsed" -ge 4 ] || fail "live_tmux_wait gave up after ${elapsed}s of a 4s budget"
  [ "$elapsed" -le 7 ] || fail "live_tmux_wait took ${elapsed}s for a 4s budget"
}

check_w8_foreign_receipts() {
  live_copy
  mkdir -p "$ORQ_EVIDENCE_DIR/noop"
  printf 'mine\n' > "$ORQ_EVIDENCE_DIR/noop/keep.txt"
  out=$(run_scenario noop) && fail "run.sh used a receipt directory it did not create: $out"
  [ -f "$ORQ_EVIDENCE_DIR/noop/keep.txt" ] || fail "run.sh deleted a file it did not write"
  grep -q '^FAIL noop: ' <<< "$out" || fail "run.sh printed '$out' for a receipt directory it did not create"

  rm -rf "$ORQ_EVIDENCE_DIR/noop"
  out=$(run_scenario noop) || fail "run.sh failed on a new receipt directory: $out"
  printf 'old\n' > "$ORQ_EVIDENCE_DIR/noop/stale.txt"
  out=$(run_scenario noop) || fail "run.sh failed on its own receipt directory: $out"
  [ ! -e "$ORQ_EVIDENCE_DIR/noop/stale.txt" ] || fail "a rerun kept a receipt of the earlier run"
}

check_w9_cleanup_exact() {
  use_real_tmux
  (
    source "$UNDER/lib.sh"
    live_setup
    harness_tmux new-session -d -s orq-chk-w9-2 -c "$TMP" 'sleep 300' || fail "could not start a tmux session"
    harness_tmux list-panes -a -F '#{pane_pid}' > "$TMP/foreign.pid"
    export LIVE_TMUX_SESSION=orq-chk-w9
    live_cleanup
  ) || exit 1
  alive "$(cat "$TMP/foreign.pid")" || fail "cleanup killed a session whose name only starts with its own"
}

check_w9_exit_exact() {
  use_real_tmux
  (
    source "$UNDER/lib.sh"
    live_setup
    harness_tmux new-session -d -s orq-chk-w9-2 -c "$TMP" 'sleep 300' || fail "could not start a tmux session"
    harness_tmux list-panes -a -F '#{pane_pid}' > "$TMP/foreign.pid"
    live_tmux_exit orq-chk-w9
  ) || exit 1
  alive "$(cat "$TMP/foreign.pid")" || fail "live_tmux_exit closed a session whose name only starts with its own"
}

check_w9_start_duplicate() {
  use_real_tmux
  (
    source "$UNDER/lib.sh"
    live_setup
    harness_tmux new-session -d -s orq-chk-w9-dup -c "$TMP" 'sleep 300' || fail "could not start a tmux session"
    harness_tmux list-panes -a -F '#{pane_pid}' > "$TMP/foreign.pid"
    live_tmux_start orq-chk-w9-dup off "$TMP/debug.log" tool
  ) > "$TMP/start.out" 2>&1
  [ -s "$TMP/foreign.pid" ] || fail "could not start a tmux session: $(head -1 "$TMP/start.out")"
  alive "$(cat "$TMP/foreign.pid")" || fail "a start that could not create its session killed the one that has that name"
}

check_w10_kill_escalation() {
  (
    source "$UNDER/lib.sh"
    live_setup
    (cd "$LIVE_REPO" && exec -a claude-chk bash -c 'trap "" TERM; while :; do sleep 1; done') > /dev/null 2>&1 &
    echo $! > "$TMP/stubborn.pid"
    sleep 0.5
    live_cleanup
  )
  pid=$(cat "$TMP/stubborn.pid")
  if alive "$pid"; then
    kill -9 "$pid"
    fail "cleanup left a process that ignores TERM"
  fi
}

check_w10_reaper() {
  use_real_tmux
  live_copy
  cat > "$TMP/doomed.sh" << EOF
source "$UNDER/lib.sh"
live_setup
live_tmux_start orq-chk-w10 off "\$ORQ_EVIDENCE/debug.log" tool
if [ -n "\${LIVE_TMUX_SOCKET:-}" ]; then
  $(printf '%q' "$REAL_TMUX") -f /dev/null -S "\$LIVE_TMUX_SOCKET" list-panes -a -F '#{pane_pid}' > "$TMP/pane.pid"
else
  tmux list-panes -a -F '#{pane_pid}' > "$TMP/pane.pid"
fi
(cd "\$LIVE_REPO" && exec -a claude-chk bash -c 'trap "" TERM HUP; while :; do sleep 1; done') > /dev/null 2>&1 &
echo \$! > "$TMP/stray.pid"
echo "\$LIVE_WORK" > "$TMP/work.txt"
sleep 300
EOF
  (cd "$TMP" && exec bash "$TMP/doomed.sh") > /dev/null 2>&1 &
  doomed=$!
  for _ in $(seq 1 40); do
    [ -s "$TMP/work.txt" ] && break
    sleep 0.25
  done
  [ -s "$TMP/work.txt" ] || fail "the run that was meant to be killed never started"
  kill -9 "$doomed"
  wait "$doomed" 2> /dev/null
  work=$(cat "$TMP/work.txt")
  stray=$(cat "$TMP/stray.pid")
  pane=$(cat "$TMP/pane.pid")
  alive "$pane" || fail "the pane of the doomed run is gone before the reaper ran"
  alive "$stray" || fail "the stray process of the doomed run is gone before the reaper ran"

  out=$(run_scenario noop) || fail "run.sh failed after a run was killed: $out"
  if alive "$pane"; then fail "the next run.sh left the tmux session of the killed run"; fi
  if alive "$stray"; then
    kill -9 "$stray"
    fail "the next run.sh left a process of the killed run"
  fi
  [ ! -e "$work" ] || fail "the next run.sh left the scratch directory of the killed run"
}

check_w10_forged_state() {
  use_real_tmux
  live_copy
  root=$ORQ_LIVE_SCRATCH_DIR
  mkdir -p "$root" "$TMP/outside"
  chmod 700 "$root"
  printf 'precious\n' > "$TMP/outside/precious.txt"
  (cd "$TMP/outside" && exec -a claude-chk bash -c 'trap "" TERM; while :; do sleep 1; done') > /dev/null 2>&1 &
  outside=$!

  forge() { printf 'pid=999999\nstart=1\nwork=%s\ntmux=%s\n' "$2" "${3:-}" > "$root/$1.state"; }
  forge outside-1 "$TMP/outside"
  mkdir -p "$root/other-2/repo"
  printf 'keep\n' > "$root/other-2/repo/keep"
  forge forged-3 "$root/other-2"
  forge forged-4 "$root/forged-4/../../outside"
  mkdir -p "$root/session-5/repo"
  "$REAL_TMUX" -f /dev/null -S "$root/session-5/tmux.sock" new-session -d -s foreign-session -c "$TMP/outside" 'sleep 300' ||
    fail "could not start a tmux session"
  foreign=$("$REAL_TMUX" -f /dev/null -S "$root/session-5/tmux.sock" list-panes -a -F '#{pane_pid}')
  forge session-5 "$root/session-5" foreign-session
  ln -s "$root/outside-1.state" "$root/linked-6.state"

  out=$(run_scenario noop) || fail "run.sh failed beside forged state files: $out"
  [ -f "$TMP/outside/precious.txt" ] || fail "a forged state file made the run remove a directory outside the scratch directory"
  alive "$outside" || fail "a forged state file made the run kill a process outside the scratch directory"
  [ -f "$root/other-2/repo/keep" ] || fail "a state file naming another scratch directory made the run remove it"
  alive "$foreign" || fail "a state file naming a foreign tmux session made the run close it"
  [ -d "$root/session-5/repo" ] || fail "a state file naming a foreign tmux session made the run remove its directory"
  for state in outside-1 forged-3 forged-4 session-5 linked-6; do
    [ -e "$root/$state.state" ] || [ -L "$root/$state.state" ] || fail "the run removed the forged state file $state"
  done
  grep -q 'ignoring the state file' <<< "$out" || fail "the run did not say why it ignored the forged state files: $out"
}

check_i1_memory_line() {
  live_copy
  FAKE_TMUX_CASE=memory-loaded expect_fail smoke 'no CLAUDE.md or rules file' "a session that may have loaded a CLAUDE.md passed smoke"
}

check_i3_executable() {
  local file missing=''
  for file in "$UNDER"/*.sh "$UNDER"/scenarios/*.sh; do
    [ -x "$file" ] || missing="$missing ${file#"$UNDER"/}"
  done
  [ -z "$missing" ] || fail "not executable:$missing"
}

check_i5_stable_scratch() {
  first=$( (
    ORQ_SCENARIO=smoke
    source "$UNDER/lib.sh"
    live_setup
    printf '%s\n' "$LIVE_REPO"
  ))
  second=$( (
    ORQ_SCENARIO=smoke
    source "$UNDER/lib.sh"
    live_setup
    printf '%s\n' "$LIVE_REPO"
  ))
  other=$( (
    ORQ_SCENARIO=smoke-mods
    source "$UNDER/lib.sh"
    live_setup
    printf '%s\n' "$LIVE_REPO"
  ))
  [ -n "$first" ] || fail "live_setup printed no repository"
  [ "$first" = "$second" ] || fail "two runs of one scenario used $first and $second"
  [ "$first" != "$other" ] || fail "two scenarios share $first"
  [ ! -e "$first" ] || fail "the scratch repository is still there after the run"
  [ ! -e "$HOME/.claude" ] || fail "the harness wrote under \$HOME/.claude"
}

check_s1_private_scratch_root() {
  mkdir -p "$TMP/xdg"
  chmod 700 "$TMP/xdg"
  root_of() ( unset ORQ_LIVE_SCRATCH_DIR; export XDG_RUNTIME_DIR=$1; source "$UNDER/lib.sh"; printf '%s\n' "$ORQ_LIVE_SCRATCH_DIR" )
  [ "$(root_of "$TMP/xdg/")" = "$TMP/xdg/cc-orq-live" ] ||
    fail "the default scratch directory is not under XDG_RUNTIME_DIR: '$(root_of "$TMP/xdg/")'"
  [ "$(root_of "$TMP/nowhere")" = "$TMP/home/.cache/cc-orq-live" ] ||
    fail "without a runtime directory the default scratch directory is not under ~/.cache: '$(root_of "$TMP/nowhere")'"
  [ "$(root_of "")" = "$TMP/home/.cache/cc-orq-live" ] ||
    fail "with an empty XDG_RUNTIME_DIR the default scratch directory is not under ~/.cache"

  (
    unset ORQ_LIVE_SCRATCH_DIR
    export XDG_RUNTIME_DIR=$TMP/xdg
    source "$UNDER/lib.sh"
    live_setup
  ) > "$TMP/setup.out" 2>&1 || fail "live_setup fails under a default scratch directory: $(head -1 "$TMP/setup.out")"
  [ "$(stat -c %a "$TMP/xdg/cc-orq-live")" = 700 ] || fail "the scratch directory is not mode 700"

  live_copy
  rm -rf "$TMP/fresh"
  ORQ_LIVE_SCRATCH_DIR=$TMP/fresh/root run_scenario noop > /dev/null || fail "run.sh failed under a new scratch directory"
  [ "$(stat -c %a "$TMP/fresh/root")" = 700 ] || fail "run.sh made the scratch directory with mode $(stat -c %a "$TMP/fresh/root")"

  mkdir -p "$TMP/real-root"
  ln -s "$TMP/real-root" "$TMP/link-root"
  ORQ_LIVE_SCRATCH_DIR=$TMP/link-root expect_fail noop 'symlink' "a symlinked scratch directory was used"
  if [ ! -O /usr ]; then
    before=$(stat -c %a /usr)
    ORQ_LIVE_SCRATCH_DIR=/usr expect_fail noop 'not a directory owned by you' "a scratch directory owned by someone else was used"
    [ "$(stat -c %a /usr)" = "$before" ] || fail "the harness changed the mode of a directory it does not own"
  fi
}

check_s2_private_tmux_socket() {
  live_copy
  out=$(run_scenario smoke) || fail "smoke does not pass against the fakes: $out"
  calls=$FAKE_LOG_DIR/tmux-calls.txt
  [ -s "$calls" ] || fail "the harness made no tmux call"
  bad=$(grep -v -F -e "-S $ORQ_LIVE_SCRATCH_DIR/" "$calls" | head -1 || true)
  [ -z "$bad" ] || fail "a tmux call without a socket inside the scratch directory: $bad"

  (
    source "$UNDER/lib.sh"
    : > "$calls"
    LIVE_TMUX_SOCKET=
    live_tmux_has anything
    live_tmux_kill anything
    live_tmux_on relative/path has-session -t anything
    [ ! -s "$calls" ]
  ) > /dev/null 2>&1 || fail "the harness called tmux without a socket of its own"

  long=$ORQ_LIVE_SCRATCH_DIR/$(printf 'x%.0s' $(seq 1 100))
  : > "$calls"
  ORQ_LIVE_SCRATCH_DIR=$long expect_fail noop 'unix socket allows' "a socket path over the limit was used"
  [ ! -s "$calls" ] || fail "the harness called tmux although its socket path was too long"
}

check_s3_no_server_kill() {
  local files hits
  files=("$UNDER"/*.sh "$UNDER"/scenarios/*.sh "$HERE"/check.sh "$HERE"/fake-*.sh)
  hits=$(grep -n 'kill-serve[r]' "${files[@]}" | grep -v -E '^[^:]+:[0-9]+:[[:space:]]*#' || true)
  [ -z "$hits" ] || fail "a tmux server kill: $hits"
}

check_dw1_slow_footer() {
  live_copy
  export FAKE_TMUX_CASE=slow-footer FAKE_TMUX_FOOTER_DELAY=12
  out=$(run_scenario smoke) || fail "a trusted folder whose TUI shows its status line after ${FAKE_TMUX_FOOTER_DELAY}s fails smoke: $out"
  [ ! -e "$ORQ_EVIDENCE_DIR/smoke/pane-failed-1.txt" ] || fail "the first interactive attempt failed and only its retry passed"
  grep -qF '● DONE' "$ORQ_EVIDENCE_DIR/smoke/pane.txt" || fail "the interactive round left no answer in pane.txt"
}

check_dw1_trust_dialog() {
  live_copy
  out=$(FAKE_TMUX_CASE=trust-dialog run_scenario smoke) || fail "smoke does not pass a TUI that asks to trust the folder: $out"
  [ ! -e "$ORQ_EVIDENCE_DIR/smoke/pane-failed-1.txt" ] || fail "the first interactive attempt failed and only its retry passed"
  grep -q 'send-keys .* Down' "$FAKE_LOG_DIR/tmux-calls.txt" || fail "the harness never moved the selection to Yes"
  grep -qF '● DONE' "$ORQ_EVIDENCE_DIR/smoke/pane.txt" || fail "the interactive round left no answer in pane.txt"
}

check_dw2_dotdot_root() {
  live_copy
  mkdir -p "$TMP/scratch/sub"
  for root in "$TMP/scratch/sub/.." "$TMP/scratch/odd..name"; do
    ORQ_LIVE_SCRATCH_DIR=$root expect_fail noop "contains '\.\.'" "the scratch directory $root was used"
  done
  left=$(find "$TMP/scratch" -mindepth 1 -maxdepth 1 ! -name sub)
  [ -z "$left" ] || fail "a refused scratch directory still got files: $left"
}

check_dw2_scenario_name() {
  local name
  for name in '../escape' 'a/b' 'a b' '.hidden' 'x..y' ''; do
    out=$( (
      source "$UNDER/lib.sh"
      live_acquire "$name"
    ) 2>&1) && fail "live_acquire took the scenario name '$name'"
  done
  left=$(find "$TMP/scratch" -mindepth 1)
  [ -z "$left" ] || fail "a refused scenario name left files in the scratch directory: $left"
  left=$(find "$TMP" -maxdepth 1 \( -name 'escape-*' -o -name '-*' \))
  [ -z "$left" ] || fail "a scenario name made the harness create files outside the scratch directory: $left"
  out=$( (
    source "$UNDER/lib.sh"
    live_acquire 'my_scenario-2.x'
  ) 2>&1) || fail "live_acquire refused a plain scenario name: $out"
}

check_dw2_work_inside_root() {
  out=$( (
    source "$UNDER/lib.sh"
    # shellcheck disable=SC2317,SC2329 # live_acquire calls it
    live_scratch_path() { printf '%s\n' "$TMP/outside-1"; }
    live_acquire anything
  ) 2>&1) && fail "live_acquire took a work directory outside the scratch directory"
  left=$(find "$TMP" -maxdepth 1 -name 'outside-*')
  [ -z "$left" ] || fail "live_acquire created files outside the scratch directory: $left"
}

check_di1_tmux_wrapper() {
  local call
  printf '#!/bin/sh\nprintf "%%s\\n" "$@" > "%s/call.$$"\n' "$TMP" > "$TMP/recorder.sh"
  chmod +x "$TMP/recorder.sh"
  (
    REAL_TMUX=$TMP/recorder.sh
    use_real_tmux
    tmux new-session -d -s orq-chk-di1 'sleep 9 -S y'
    tmux has-session -t 'a -S b'
    tmux -f /dev/null list-sessions
  )
  [ "$(find "$TMP" -maxdepth 1 -name 'call.*' | wc -l)" -eq 3 ] || fail "the wrapper did not pass its three calls on"
  for call in "$TMP"/call.*; do
    if [ "$(sed -n 1p "$call")" != -S ] || [ "$(sed -n 2p "$call")" != "$TMP/tmux.sock" ]; then
      fail "a call reached tmux without the sandbox socket first: $(tr '\n' ' ' < "$call")"
    fi
  done

  use_real_tmux
  mkdir "$TMP/own"
  tmux -f /dev/null -S "$TMP/own/tmux.sock" new-session -d -s orq-chk-di1 -c "$TMP" 'sleep 300' ||
    fail "a call that names its own socket failed"
  "$REAL_TMUX" -f /dev/null -S "$TMP/own/tmux.sock" has-session -t =orq-chk-di1 2> /dev/null ||
    fail "a call that names its own socket did not reach it"
  ! "$REAL_TMUX" -f /dev/null -S "$TMP/tmux.sock" has-session -t =orq-chk-di1 2> /dev/null ||
    fail "a call that names its own socket also reached the sandbox socket"
}

check_di2_headless_memory() {
  live_copy
  for scenario in smoke smoke-mods; do
    FAKE_CLAUDE_CASE=memory-loaded expect_fail "$scenario" 'InstructionsLoaded' "a headless session that loaded a memory file passed $scenario"
  done
}

check_di3_foreign_server() {
  live_copy
  for scenario in smoke smoke-mods; do
    FAKE_CLAUDE_CASE=foreign-server expect_fail "$scenario" 'does not come from the plugin' "a session with an MCP server of the user passed $scenario"
    FAKE_CLAUDE_CASE=no-source expect_fail "$scenario" 'does not come from the plugin' "a session whose servers name no source passed $scenario"
  done
}

check_di4_existing_root() {
  local root=$ORQ_LIVE_SCRATCH_DIR mode
  live_copy
  for mode in 755 750 705 777; do
    chmod "$mode" "$root"
    expect_fail noop 'group or others' "a scratch directory with mode $mode was used"
    [ "$(stat -c %a "$root")" = "$mode" ] ||
      fail "the harness changed the mode of a scratch directory it did not create: $mode to $(stat -c %a "$root")"
  done
  chmod 700 "$root"
  out=$(run_scenario noop) || fail "an existing scratch directory with mode 700 was refused: $out"
  [ "$(stat -c %a "$root")" = 700 ] || fail "the mode of an existing private scratch directory changed to $(stat -c %a "$root")"
  rm -rf "$TMP/fresh"
  out=$( (umask 000 && ORQ_LIVE_SCRATCH_DIR=$TMP/fresh/root run_scenario noop)) || fail "run.sh failed under a new scratch directory and umask 000: $out"
  [ "$(stat -c %a "$TMP/fresh/root")" = 700 ] || fail "a new scratch directory got mode $(stat -c %a "$TMP/fresh/root") under umask 000"
}

selected=("$@")
[ "${#selected[@]}" -gt 0 ] || selected=("${ALL[@]}")
printf 'live harness under test: %s\n' "$UNDER"

passed=0
failed=0
for name in "${selected[@]}"; do
  if ! declare -F "check_$name" > /dev/null; then
    printf 'not ok - %s: no such check\n' "$name"
    failed=$((failed + 1))
    continue
  fi
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/orq-live-check.XXXXXX")
  log=$(mktemp "${TMPDIR:-/tmp}/orq-live-check-log.XXXXXX")
  (
    sandbox "$tmp"
    "check_$name"
  ) > "$log" 2>&1
  rc=$?
  sandbox_cleanup "$tmp"
  if [ "$rc" -eq 0 ]; then
    printf 'ok - %s\n' "$name"
    passed=$((passed + 1))
  else
    printf 'not ok - %s\n' "$name"
    head -5 "$log"
    failed=$((failed + 1))
  fi
  rm -f "$log"
done
printf 'checks: %s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
