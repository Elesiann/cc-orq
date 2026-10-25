#!/usr/bin/env bash
# A stand-in for tmux in the checks of the live harness (tests/live/check.sh). Sessions are files under
# $FAKE_TMUX_DIR, whatever socket the caller names. A target matches the way tmux matches it: "=name" exactly,
# otherwise the exact name first and then a unique prefix, and anything after a colon is ignored. A session shows
# the pane of an interactive Claude Code session: the status line of the mode its command line asked for, and the
# answer once Enter submitted a prompt.
#
# Environment:
#   FAKE_TMUX_DIR   where the sessions live (required)
#   FAKE_TMUX_CASE  ok (default), silent (the pane stays empty), memory-loaded (the session's debug log does not
#                   say that no memory file loaded), auto-footer (the status line says auto mode whatever the
#                   command line asked for), slow-footer (the pane shows no status line until
#                   FAKE_TMUX_FOOTER_DELAY seconds after the session started), trust-dialog (the pane asks to
#                   trust the folder, with "No, exit" selected, until Down and Enter chose "Yes")
#   FAKE_TMUX_FOOTER_DELAY  seconds before the slow-footer case shows the status line (default: 12)
#   FAKE_LOG_DIR    when set, each call appends its arguments to tmux-calls.txt, and new-session appends the
#                   directory it was given to tmux-cwd.txt
set -uo pipefail

dir=${FAKE_TMUX_DIR:?FAKE_TMUX_DIR is not set}
mkdir -p "$dir"

if [ -n "${FAKE_LOG_DIR:-}" ]; then
  mkdir -p "$FAKE_LOG_DIR"
  printf '%s\n' "$*" >> "$FAKE_LOG_DIR/tmux-calls.txt"
fi
while [ "$#" -gt 0 ]; do
  case $1 in
    -f | -S | -L) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
command=${1:-}
shift || true
target='' name='' cwd='' literal=0
words=()
while [ "$#" -gt 0 ]; do
  case $1 in
    -t) target=${2:-}; shift 2 ;;
    -s) name=${2:-}; shift 2 ;;
    -c) cwd=${2:-}; shift 2 ;;
    -x | -y | -S) shift 2 ;;
    -l) literal=1; shift ;;
    -d | -p) shift ;;
    *) words+=("$1"); shift ;;
  esac
done

resolve() {
  local t=${1%%:*} exact=0 matches=()
  case $t in =*) exact=1; t=${t#=} ;; esac
  if [ -e "$dir/$t.session" ]; then
    printf '%s\n' "$t"
    return 0
  fi
  [ "$exact" -eq 0 ] || return 1
  matches=("$dir/$t"*.session)
  { [ "${#matches[@]}" -eq 1 ] && [ -e "${matches[0]}" ]; } || return 1
  t=${matches[0]##*/}
  printf '%s\n' "${t%.session}"
}

footer() {
  local cmdline=$1 mode=''
  case $cmdline in *'--permission-mode '*) mode=${cmdline#*--permission-mode }; mode=${mode%% *} ;; esac
  [ "${FAKE_TMUX_CASE:-ok}" = auto-footer ] && mode=auto
  case $mode in
    manual | default) printf '%s\n' '⏸ manual mode on · ? for shortcuts' ;;
    '' | auto) printf '%s\n' '⏵⏵ auto mode on (shift+tab to cycle)' ;;
    *) printf '%s mode on · ? for shortcuts\n' "$mode" ;;
  esac
}

dialog_pending() {
  [ "${FAKE_TMUX_CASE:-ok}" = trust-dialog ] && [ ! -e "$dir/$1.trusted" ]
}

footer_pending() {
  local started
  [ "${FAKE_TMUX_CASE:-ok}" = slow-footer ] || return 1
  started=$(cat "$dir/$1.started" 2> /dev/null || echo 0)
  [ "$(($(date +%s) - started))" -lt "${FAKE_TMUX_FOOTER_DELAY:-12}" ]
}

# The dialog as Claude Code draws it: the selection starts on "No, exit", and the screen has no status line.
dialog() {
  local n=$1 no='❯ No, exit' yes='  Yes, I trust this folder'
  if [ "$(cat "$dir/$n.sel" 2> /dev/null)" = yes ]; then
    no='  No, exit'
    yes='❯ Yes, I trust this folder'
  fi
  printf '\n────\n Accessing workspace:\n\n %s\n\n Quick safety check: Is this a project you created or one you trust?\n\n Security guide\n\n %s\n %s\n\n Enter to confirm · Esc to cancel\n' \
    "$(cat "$dir/$n.cwd" 2> /dev/null)" "$no" "$yes"
}

# One write, as tmux does: a reader that stops at the first match must not break the writer's pipe.
pane() {
  local n=$1 text
  if dialog_pending "$n"; then
    dialog "$n"
    return
  fi
  text=$(printf ' ▐▛███▛█   Claude Code vfake\n ▝▝   ▝▝   %s\n\n' "$(cat "$dir/$n.cwd" 2> /dev/null)")
  if footer_pending "$n"; then
    printf '%s\n' "$text"
    return
  fi
  if [ -e "$dir/$n.submitted" ]; then
    text+=$(printf '\n❯ %s\n\n  Called plugin:cc-orq:orq (ctrl+o to expand)\n\n● DONE\n' "$(cat "$dir/$n.typed")")
  fi
  text+=$(printf '\n────\n❯ \n────\n  %s' "$(footer "$(cat "$dir/$n.session")")")
  printf '%s\n' "$text"
}

case $command in
  new-session)
    [ -n "$name" ] || exit 1
    if [ -e "$dir/$name.session" ]; then
      echo "duplicate session: $name" >&2
      exit 1
    fi
    printf '%s\n' "${words[*]:-}" > "$dir/$name.session"
    printf '%s\n' "$cwd" > "$dir/$name.cwd"
    date +%s > "$dir/$name.started"
    if [ -n "${FAKE_LOG_DIR:-}" ]; then printf '%s\n' "$cwd" >> "$FAKE_LOG_DIR/tmux-cwd.txt"; fi
    debug=$(grep -o -- '--debug-file [^ ]*' "$dir/$name.session" | head -1 | cut -d' ' -f2)
    if [ -n "$debug" ]; then
      printf '%s\n' "$debug" > "$dir/$name.debug"
      {
        echo 'MCP server "plugin:cc-orq:orq": Successfully connected (transport: stdio) in 12 ms'
        [ "${FAKE_TMUX_CASE:-ok}" = memory-loaded ] || echo 'No CLAUDE.md/rules files found'
      } > "$debug"
    fi
    ;;
  has-session)
    resolve "$target" > /dev/null
    ;;
  kill-session)
    n=$(resolve "$target") || exit 1
    rm -f "$dir/$n".*
    ;;
  capture-pane)
    n=$(resolve "$target") || exit 1
    [ "${FAKE_TMUX_CASE:-ok}" = silent ] && exit 0
    pane "$n"
    ;;
  send-keys)
    n=$(resolve "$target") || exit 1
    if [ "$literal" -eq 1 ]; then
      printf '%s' "${words[*]}" > "$dir/$n.typed"
    elif dialog_pending "$n"; then
      case ${words[0]:-} in
        Down) echo yes > "$dir/$n.sel" ;;
        Up) echo no > "$dir/$n.sel" ;;
        Enter)
          if [ "$(cat "$dir/$n.sel" 2> /dev/null)" = yes ]; then
            touch "$dir/$n.trusted"
          else
            rm -f "$dir/$n".*
          fi
          ;;
      esac
    elif [ "${words[0]:-}" = Enter ]; then
      if [ "$(cat "$dir/$n.typed" 2> /dev/null)" = /exit ]; then
        rm -f "$dir/$n".*
      else
        touch "$dir/$n.submitted"
        if [ -f "$dir/$n.debug" ]; then
          {
            echo 'MCP server "plugin:cc-orq:orq": Calling MCP tool: list'
            echo "Tool 'list' completed successfully"
          } >> "$(cat "$dir/$n.debug")"
        fi
      fi
    fi
    ;;
  *)
    echo "fake tmux: unsupported command: $command" >&2
    exit 1
    ;;
esac
