#!/usr/bin/env bash
# The store's dual-write steps must never block the git data path (design 2.1 section 16, 2.3a part 1).
# Every store command in a workflow runs through here: this script always exits 0, records what happened in
# $HD_STORE_DIR/status/<name>, and leaves the command's output beside it.
#
#   bash scripts/store-guard.sh run [--after <name>] <name> <command> [args...]
#       Runs the command (under `timeout $HD_STORE_TIMEOUT`, 900 seconds when unset, so a hung store call cannot eat the job).
#       Records "ok", "failed (exit N)" or "skipped (<name> did not succeed)" when --after names a
#       step that is not "ok". A failure prints a ::warning:: line and the tail of the output.
#   bash scripts/store-guard.sh summary <heading>
#       Appends every recorded step, every step of every lane under $HD_STORE_DIR/lanes/<artifact>/ (the publish job
#       downloads the lanes' status artifacts there) and every $HD_STORE_DIR/issues/*.json issue to $GITHUB_STEP_SUMMARY, writes the
#       markdown body of a problem report to $HD_STORE_DIR/report.md and creates $HD_STORE_DIR/problem when a
#       step failed or an issue has severity error (a later step in the same job tests for the file).
#   bash scripts/store-guard.sh issue <title>
#       Comments the report on the open issue with that title, or opens one (needs GH_TOKEN and gh).
set -u

DIR="${HD_STORE_DIR:-${RUNNER_TEMP:-/tmp}/hd-store}"
STATUS="$DIR/status"
mkdir -p "$STATUS" "$DIR/issues"

run() {
  local after=""
  if [ "${1:-}" = "--after" ]; then after="$2"; shift 2; fi
  local name="$1"; shift
  if [ -n "$after" ] && [ "$(cat "$STATUS/$after" 2>/dev/null)" != "ok" ]; then
    echo "skipped ($after did not succeed)" > "$STATUS/$name"
    echo "store step $name skipped: $after did not succeed"
    return 0
  fi
  if declare -F "$1" >/dev/null; then "$@" > "$STATUS/$name.log" 2>&1; else timeout "${HD_STORE_TIMEOUT:-900}" "$@" > "$STATUS/$name.log" 2>&1; fi
  local rc=$?
  cat "$STATUS/$name.log"
  if [ "$rc" -eq 0 ]; then
    echo "ok" > "$STATUS/$name"
  else
    echo "failed (exit $rc)" > "$STATUS/$name"
    echo "::warning title=Store step failed (dual-write; the git data path is unaffected)::$name exited $rc"
  fi
  return 0
}

summary() {
  local heading="$1" problem=false report="$DIR/report.md"
  : > "$report"
  {
    echo "### $heading"
    echo ""
    echo "| Step | Result |"
    echo "|---|---|"
  } > "$DIR/summary.md"
  local f name result
  for f in "$STATUS"/*; do
    case "$f" in *.log) continue ;; esac
    [ -f "$f" ] || continue
    name=$(basename "$f"); result=$(cat "$f")
    echo "| $name | $result |" >> "$DIR/summary.md"
    case "$result" in
      failed*) problem=true; { echo "- step \`$name\`: $result"; echo '```'; tail -n 15 "$f.log" 2>/dev/null; echo '```'; } >> "$report" ;;
    esac
  done
  local lane
  for lane in "$DIR"/lanes/*/; do
    [ -d "$lane" ] || continue
    for f in "$lane"*; do
      case "$f" in *.log) continue ;; esac
      [ -f "$f" ] || continue
      name="$(basename "$lane")/$(basename "$f")"; result=$(cat "$f")
      echo "| $name | $result |" >> "$DIR/summary.md"
      case "$result" in
        failed*) problem=true; { echo "- lane step \`$name\`: $result"; echo '```'; tail -n 15 "$f.log" 2>/dev/null; echo '```'; } >> "$report" ;;
      esac
    done
  done
  for f in "$DIR"/issues/*.json; do
    [ -f "$f" ] || continue
    if command -v jq >/dev/null 2>&1; then
      jq -r '.phase as $p | .issues[] | "- **\(.severity)** `\(.code)` (\($p)) \(.slug // "-"): \(.title). \(.detail)"' "$f" >> "$DIR/summary.md" 2>/dev/null || true
      jq -r '.phase as $p | .issues[] | select(.severity == "error") | "- `\(.code)` (\($p)) \(.slug // "-"): \(.title). \(.detail)"' "$f" >> "$report" 2>/dev/null || true
      [ "$(jq '[.issues[] | select(.severity == "error")] | length' "$f" 2>/dev/null || echo 0)" != "0" ] && problem=true
    fi
  done
  cat "$DIR/summary.md" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  [ "$problem" = true ] && touch "$DIR/problem"
  return 0
}

issue() {
  local title="$1" run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
  local body="$DIR/issue-body.md"
  { echo "Store dual-write problem (the git data path was not affected). Run: $run_url"; echo ""; cat "$DIR/report.md"; } > "$body"
  local number
  number=$(gh issue list --state open --search "\"$title\" in:title" --json number,title --jq "[.[] | select(.title == \"$title\")][0].number // empty")
  if [ -n "$number" ]; then gh issue comment "$number" --body-file "$body"; else gh issue create --title "$title" --body-file "$body"; fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
  run) run "$@" ;;
  summary) summary "$@" ;;
  issue) run issue-filing issue "$@" ;;
  *) echo "usage: store-guard.sh run|summary|issue ..." >&2 ;;
esac
exit 0
