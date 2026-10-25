#!/bin/bash
# lock shell suite: the checkout lock through the Node launcher (server/node-engine.ts and the job core's
# launchTaskFromHeader), every launch in its own OS process, and a fake claude as the worker. The kit cannot
# fork processes, so this is where the lock meets a real mkdir, a real supervisor and a real kill -9.
#
# Usage: bash tests/lock-shell.sh [race|dead]
#   ORQ_ROOT=DIR        launch through the engine of another checkout, such as an older commit
#   ORQ_LOCK_ROUNDS=N   rounds of the twenty-launch scenario (default 1)
#   ORQ_DEAD_ROUNDS=N   rounds of the twenty launches into a dead lock (default 5)
#   race                run only the twenty-launch rounds and print their counts, which is how the race of an
#                       engine without the lock shows
#   dead                run only the dead-lock rounds and print their counts
set -e -o pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENGINE=${ORQ_ROOT:-$ROOT}
ROUNDS=${ORQ_LOCK_ROUNDS:-1}
DEAD_ROUNDS=${ORQ_DEAD_ROUNDS:-5}
T="$ROOT/.ref/tmp/lock-shell-$(date +%s)-$$"
mkdir -p "$T/bin" "$T/slow-bin"
T=$(cd -P "$T" && pwd)
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

cleanup() {
  rm -f "$T"/hold-* 2>/dev/null || true
  for f in "$T"/jobs*/*/pgid; do
    [ -s "$f" ] && kill -9 -- "-$(cat "$f")" 2>/dev/null || true
  done
  rm -rf "$T"
}
trap cleanup EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=orq-test GIT_AUTHOR_EMAIL=orq-test@example.invalid
export GIT_COMMITTER_NAME=orq-test GIT_COMMITTER_EMAIL=orq-test@example.invalid
export ORQ_ROOT="$ENGINE"

cat > "$T/bin/claude" <<'EOF'
#!/bin/bash
printf '%s\n' '{"type":"system","subtype":"init","session_id":"ses-fake"}'
n=0
while [ -n "$ORQ_FAKE_HOLD" ] && [ -e "$ORQ_FAKE_HOLD" ] && [ "$n" -lt 900 ]; do sleep 0.1; n=$((n+1)); done
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"ses-fake","result":"FAKE-CLAUDE","usage":{"input_tokens":1,"output_tokens":1},"modelUsage":{"fake":{}}}'
exit 0
EOF
chmod +x "$T/bin/claude"

# A systemd-run that fails sends the start script to setsid, and this setsid pauses: a job with no pgid yet.
REAL_SETSID=$(command -v setsid || true)
printf '#!/bin/bash\nexit 1\n' > "$T/slow-bin/systemd-run"
printf '#!/bin/bash\nsleep "${ORQ_SLOW_START:-3}"\nexec "%s" "$@"\n' "$REAL_SETSID" > "$T/slow-bin/setsid"
chmod +x "$T/slow-bin/systemd-run" "$T/slow-bin/setsid"
export PATH="$T/bin:$PATH"

cat > "$T/driver.mjs" <<'JS'
import { existsSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [mode, jobsDir, sessionDir, cwd, isolation, readyFile, goFile] = process.argv.slice(2)
const root = process.env.ORQ_ROOT
const load = (path) => import(pathToFileURL(`${root}/${path}`).href)
const { defaultConfig } = await load('hooks/config.ts')
const { launchTaskFromHeader, launchTaskJob } = await load('hooks/engine.ts')
const { parseTaskHeader } = await load('hooks/task-header.ts')
const { parentRuntimeModeFromPermissionMode } = await load('hooks/target.ts')
const { nodeEngine } = await load('server/node-engine.ts')

const ceiling = parentRuntimeModeFromPermissionMode('acceptEdits')
const engine = nodeEngine({ env: { ...process.env }, pluginRoot: root })
const hold = process.env.HOLD
const instance = { id: 'claudeAgent', driver: 'claudeAgent', ...(hold ? { env: { ORQ_FAKE_HOLD: hold } } : {}) }
const config = { ...defaultConfig(sessionDir), jobsDir, instances: [instance] }
const agentId = `agent-${process.pid}`

// header goes through launchTaskFromHeader, which resolves cwd and scopes it; raw hands the cwd to the job core as given.
async function launch() {
  if (mode === 'raw') {
    return launchTaskJob(engine, config, {
      agentId, instance, model: 'haiku', cwd, prompt: 'say PONG', flags: [],
      runtimeMode: ceiling.runtimeMode, interactionMode: ceiling.interactionMode, isolation, scopeRoots: [sessionDir],
    })
  }
  const header = parseTaskHeader(`target: claudeAgent haiku\ncwd: ${cwd}\nisolation: ${isolation}\n\nsay PONG`)
  return launchTaskFromHeader(engine, config, { agentId, header, ceiling, sessionDir })
}

if (readyFile) writeFileSync(readyFile, '')
if (goFile) while (!existsSync(goFile)) await new Promise((resolve) => setTimeout(resolve, 1))
try {
  const r = await launch()
  console.log('job' in r ? `launched ${r.job.id}` : `${r.refusal.includes('worktree_busy') ? 'busy' : 'refused'} ${r.refusal}`)
} catch (err) {
  console.log(`error ${String(err)}`)
}
JS

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
real() { (cd -P "$1" && pwd); }
lock_of() { echo "$JOBS/.locks/$(printf '%s' "$(real "$1")" | sha256)"; }
owner_of() { tr -d '\n' < "$(lock_of "$1")/owner" 2>/dev/null || true; }

backdate() {
  local stamp
  stamp=$(node -e 'const d=new Date(Date.now()-Number(process.argv[1])*1000);const p=(n)=>String(n).padStart(2,"0");console.log(`${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}.${p(d.getSeconds())}`)' "$2")
  touch -t "$stamp" "$1"
}

new_repo() {
  git init -q "$1"
  mkdir -p "$1/sub"
  printf 'kept\n' > "$1/sub/kept.txt"
  git -C "$1" add sub
  git -C "$1" commit -q -m init
}

launch_one() {
  node "$T/driver.mjs" "${3:-header}" "$JOBS" "$SESSION" "$1" "$2"
}

launch_many() {
  local count=$1 i pids=()
  rm -rf "$T/ready" "$T/go" "$T/many"; mkdir -p "$T/ready" "$T/many"
  for i in $(seq 1 "$count"); do
    node "$T/driver.mjs" header "$JOBS" "$SESSION" "$2" "$3" "$T/ready/$i" "$T/go" > "$T/many/$i" 2>&1 &
    pids+=($!)
  done
  until [ "$(ls "$T/ready" | wc -l)" -ge "$count" ]; do sleep 0.05; done
  : > "$T/go"
  for i in "${pids[@]}"; do wait "$i" || true; done
  cat "$T"/many/* > "$T/many.out"
}
tally() { grep -c "^$1 " "$T/many.out" || true; }

wait_until() {
  local limit=$(( $1 * 20 )); shift
  while ! "$@" 2>/dev/null; do
    limit=$((limit - 1)); [ "$limit" -gt 0 ] || return 1
    sleep 0.05
  done
}
has_file() { [ -e "$1" ]; }
group_gone() { ! kill -0 -- "-$1" 2>/dev/null; }

id_of() { echo "${1#* }"; }
words() { echo "$1" | cut -d' ' -f1; }

round() {
  local n=$1 repo
  SESSION="$T/session-r$n"; JOBS="$T/jobs-r$n"; HOLD="$T/hold-r$n"; export HOLD
  : > "$HOLD"
  repo="$SESSION/repo"; new_repo "$repo"
  launch_many 20 "$repo" shared
  echo "round $n: launched=$(tally launched) busy=$(tally busy) other=$(grep -vc '^launched \|^busy ' "$T/many.out" || true)"
}

dead_round() {
  local n=$1 repo
  repo="$SESSION/repo-$n"; new_repo "$repo"
  mkdir -p "$JOBS/dead-$n" "$(lock_of "$repo")"
  printf '0\n' > "$JOBS/dead-$n/exit"
  printf 'dead-%s\n' "$n" > "$(lock_of "$repo")/owner"
  launch_many 20 "$repo" shared
  echo "dead-lock round $n: launched=$(tally launched) busy=$(tally busy) could-not-lock=$(grep -c 'could not lock' "$T/many.out" || true) other=$(grep -vc '^launched \|^busy ' "$T/many.out" || true)"
}
dead_session() { SESSION="$T/session-dead"; JOBS="$T/jobs-dead"; HOLD="$T/hold-dead"; export HOLD; : > "$HOLD"; }

if [ "${1:-}" = race ]; then
  for n in $(seq 1 "$ROUNDS"); do round "$n"; done
  exit 0
fi
if [ "${1:-}" = dead ]; then
  dead_session
  for n in $(seq 1 "$DEAD_ROUNDS"); do dead_round "$n"; done
  exit 0
fi

for n in $(seq 1 "$ROUNDS"); do
  round "$n"
  [ "$(tally launched)" -eq 1 ] && [ "$(tally busy)" -eq 19 ] && ok "round $n: twenty simultaneous shared launches give one job and nineteen worktree_busy" \
    || { bad "round $n: twenty simultaneous shared launches (see counts above)"; sed -n 1,3p "$T/many.out"; }
  grep -q "is in use by" "$T/many.out" && ok "round $n: a refusal names the owner or the launch in progress" || bad "round $n: no refusal names an owner"
done
SESSION="$T/session-r1"; JOBS="$T/jobs-r1"; HOLD="$T/hold-r1"; export HOLD; repo="$SESSION/repo"
holder=$(owner_of "$repo")

rm -f "$HOLD"
wait_until 20 has_file "$JOBS/$holder/exit" && ok "the owner's job ended" || bad "the owner's job did not end"
unset HOLD
out=$(launch_one "$repo" shared)
[ "$(words "$out")" = launched ] && ok "a launch after the owner's job ended passes" || bad "a launch after the owner ended: $out"
[ "$(owner_of "$repo")" = "$(id_of "$out")" ] && ok "the new job owns the lock" || bad "the lock owner is $(owner_of "$repo"), not $(id_of "$out")"
[ "$(ls "$JOBS/.locks" | wc -l)" -eq 1 ] && ok "one lock directory, no tombstone and no mutex left" || bad ".locks holds: $(ls "$JOBS/.locks")"

if [ -n "$REAL_SETSID" ]; then
  SESSION="$T/session-slow"; JOBS="$T/jobs-slow"; HOLD="$T/hold-slow"; export HOLD; : > "$HOLD"
  repo="$SESSION/repo"; new_repo "$repo"
  PATH="$T/slow-bin:$PATH" ORQ_SLOW_START=3 launch_one "$repo" shared > "$T/slow-first.out" &
  first=$!
  wait_until 10 has_file "$(lock_of "$repo")/owner" || bad "the first launch never claimed its lock"
  starter=$(owner_of "$repo")
  sleep 0.5
  [ ! -s "$JOBS/$starter/pgid" ] && ok "the owner has no pgid yet" || bad "the owner already has a pgid"
  out=$(launch_one "$repo" shared)
  [ "$(words "$out")" = busy ] && echo "$out" | grep -q "is in use by job $starter" && ok "a concurrent launch is refused naming the owner that has no pgid yet" || bad "concurrent launch: $out"
  [ "$(owner_of "$repo")" = "$starter" ] && ok "the lock of the starting owner was not broken" || bad "the lock owner changed to $(owner_of "$repo")"
  wait "$first" || true
  [ "$(words "$(cat "$T/slow-first.out")")" = launched ] && ok "the first launch went on to start its job" || bad "first launch: $(cat "$T/slow-first.out")"
  rm -f "$HOLD"; unset HOLD
fi

SESSION="$T/session-stuck"; JOBS="$T/jobs-stuck"; repo="$SESSION/repo"; new_repo "$repo"
mkdir -p "$JOBS/stuck-job" "$(lock_of "$repo")"
printf 'stuck-job\n' > "$(lock_of "$repo")/owner"
out=$(launch_one "$repo" shared)
[ "$(words "$out")" = busy ] && echo "$out" | grep -q "is in use by job stuck-job" && ok "a lock under 10 s old with an owner that has no pgid is kept" || bad "young stuck lock: $out"
backdate "$(lock_of "$repo")" 30
out=$(launch_one "$repo" shared)
[ "$(words "$out")" = launched ] && [ "$(owner_of "$repo")" = "$(id_of "$out")" ] && ok "a lock over 10 s old with an owner that has no pgid is broken and the launch passes" || bad "old stuck lock: $out"

SESSION="$T/session-kill"; JOBS="$T/jobs-kill"; HOLD="$T/hold-kill"; export HOLD; : > "$HOLD"
repo="$SESSION/repo"; new_repo "$repo"
out=$(launch_one "$repo" shared); victim=$(id_of "$out")
[ "$(words "$out")" = launched ] && ok "the job to kill started" || bad "victim launch: $out"
pgid=$(tr -d '[:space:]' < "$JOBS/$victim/pgid")
kill -9 -- "-$pgid"
wait_until 10 group_gone "$pgid" && ok "its process group is gone" || bad "its process group survived kill -9"
[ ! -e "$JOBS/$victim/exit" ] && ok "the killed job left no exit file" || bad "the killed job has an exit file"
out=$(launch_one "$repo" shared)
[ "$(words "$out")" = launched ] && [ "$(owner_of "$repo")" = "$(id_of "$out")" ] && ok "the launch after kill -9 breaks the lock and passes" || bad "launch after kill -9: $out"
rm -f "$HOLD"; unset HOLD

SESSION="$T/session-break"; JOBS="$T/jobs-break"; HOLD="$T/hold-break"; export HOLD; : > "$HOLD"
two_holders=0; no_holder=0
for n in $(seq 1 20); do
  repo="$SESSION/repo-$n"; new_repo "$repo"
  mkdir -p "$JOBS/dead-$n" "$(lock_of "$repo")"
  printf '0\n' > "$JOBS/dead-$n/exit"
  printf 'dead-%s\n' "$n" > "$(lock_of "$repo")/owner"
  launch_many 2 "$repo" shared
  held=$(tally launched)
  [ "$held" -gt 1 ] && two_holders=$((two_holders+1))
  [ "$held" -lt 1 ] && no_holder=$((no_holder+1))
done
[ "$two_holders" -eq 0 ] && ok "two launchers breaking one dead lock: never two holders, over 20 tries" || bad "two holders in $two_holders of 20 tries"
[ "$no_holder" -eq 0 ] && ok "and one of them always got the lock" || bad "no holder in $no_holder of 20 tries"
[ -z "$(ls "$JOBS/.locks" | grep '\.' || true)" ] && ok "no mutex or tombstone is left behind" || bad "left in .locks: $(ls "$JOBS/.locks" | grep '\.')"
rm -f "$HOLD"; unset HOLD

dead_session
for n in $(seq 1 "$DEAD_ROUNDS"); do
  dead_round "$n"
  [ "$(tally launched)" -eq 1 ] && [ "$(tally busy)" -eq 19 ] && [ "$(grep -c 'could not lock' "$T/many.out" || true)" -eq 0 ] \
    && ok "dead-lock round $n: twenty launches give one job and nineteen worktree_busy, none could not lock" \
    || { bad "dead-lock round $n: twenty launches into a dead lock (see counts above)"; grep -v '^launched ' "$T/many.out" | cut -c1-200 | sort | uniq -c | sed -n 1,4p; }
done
[ -z "$(ls "$JOBS/.locks" | grep '\.' || true)" ] && ok "the dead-lock rounds left no mutex or tombstone behind" || bad "left in .locks: $(ls "$JOBS/.locks" | grep '\.')"
rm -f "$HOLD"; unset HOLD

SESSION="$T/session-same"; JOBS="$T/jobs-same"; HOLD="$T/hold-same"; export HOLD; : > "$HOLD"
repo="$SESSION/repo"; new_repo "$repo"; ln -s "$repo" "$SESSION/link"
out=$(launch_one "$repo" shared); first=$(id_of "$out")
[ "$(words "$out")" = launched ] && ok "the first launch holds the checkout" || bad "first launch: $out"
for spelling in "$repo/sub" "$SESSION/link" "$SESSION/link/sub"; do
  for mode in header raw; do
    out=$(launch_one "$spelling" shared "$mode")
    [ "$(words "$out")" = busy ] && echo "$out" | grep -q "is in use by job $first" && ok "$mode launch at ${spelling#"$SESSION"/} is refused naming $first" || bad "$mode launch at $spelling: $out"
  done
done
[ "$(ls "$JOBS/.locks" | wc -l)" -eq 1 ] && ok "all those spellings map to one lock directory" || bad ".locks holds: $(ls "$JOBS/.locks")"
[ "$(cat "$(lock_of "$repo")/key")" = "$(real "$repo")" ] && ok "the lock keeps the checkout's real path in key" || bad "key holds: $(cat "$(lock_of "$repo")/key")"

out=$(launch_one "$repo" worktree)
[ "$(words "$out")" = launched ] && ok "a worktree launch passes while a shared job holds the lock" || bad "worktree launch: $out"
[ "$(owner_of "$repo")" = "$first" ] && ok "and it neither claimed nor changed the lock" || bad "the lock owner is $(owner_of "$repo")"
rm -f "$HOLD"; unset HOLD

SESSION="$T/session-wt"; JOBS="$T/jobs-wt"; HOLD="$T/hold-wt"; export HOLD; : > "$HOLD"
repo="$SESSION/repo"; new_repo "$repo"
out=$(launch_one "$repo/sub" worktree); wt=$(id_of "$out")
[ "$(words "$out")" = launched ] && ok "a worktree job started from a subdirectory is live" || bad "worktree launch: $out"
out=$(launch_one "$repo" shared)
[ "$(words "$out")" = busy ] && echo "$out" | grep -q "is in use by job $wt" && ok "a shared launch at the top level is refused for the live worktree job" || bad "shared launch beside a worktree job: $out"
[ ! -d "$(lock_of "$repo")" ] && ok "the refused launch gave its lock back" || bad "its lock is still there, owned by $(owner_of "$repo")"
rm -f "$HOLD"; unset HOLD

SESSION="$T/session-link"; JOBS="$T/jobs-link"; HOLD="$T/hold-link"; export HOLD; : > "$HOLD"
repo="$SESSION/repo"; new_repo "$repo"; ln -s "$repo" "$SESSION/link"
out=$(launch_one "$SESSION/link" worktree raw); wt=$(id_of "$out")
[ "$(words "$out")" = launched ] && ok "a worktree job launched at a symlink spelling of the checkout is live" || bad "worktree launch at the link: $out"
out=$(launch_one "$SESSION/link" shared raw)
[ "$(words "$out")" = busy ] && echo "$out" | grep -q "is in use by job $wt" && ok "a shared launch at that same spelling is refused for the worktree job" || bad "shared launch at the link: $out"
[ ! -d "$(lock_of "$repo")" ] && ok "and it gave its lock back" || bad "its lock is still there, owned by $(owner_of "$repo")"
rm -f "$HOLD"; unset HOLD

echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
