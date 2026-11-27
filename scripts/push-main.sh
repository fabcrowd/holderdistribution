#!/usr/bin/env bash
# Rebase the current HEAD onto origin/main and push it, retrying on a lost race.
#
# The daily refresh runs one matrix job per project, and the watchdog, manual
# backfills and humans push to main too. A plain `fetch && rebase && push`
# fails with non-fast-forward whenever another push lands between the fetch and
# the push; this retries the whole sequence.
#
# rpc-usage.json files (data/rpc-usage.json, data/<slug>/rpc-usage.json) are
# counters that several jobs add to on the same day (holders refresh, wallet
# flows, ledger). The rebase merges them with scripts/merge-rpc-usage.js as a
# git merge driver, so both runs' counts are kept and the budget guard still
# sees every call. After the rebase, the same three-way merge is computed
# again from the pre-rebase trees (base, our HEAD, origin/main) and written
# back: git does not invoke the driver when both sides made the identical
# edit, and would otherwise keep one increment. If that leaves a change, the
# tip commit is amended, or a new commit is made when the rebase dropped an
# empty replay. Any other rebase conflict is NOT retried: it means two
# writers touched the same file, which needs a human. The conflicted paths
# are printed before the abort.
#
# The driver and its attribute line are set per command (`git -c`), never in
# git config or .gitattributes, so other clones keep git's line merge. The
# driver files are copied out of HEAD first: during a rebase the work tree
# holds origin/main, which may predate them.
#
# Run: bash scripts/push-main.sh
set -euo pipefail

MAX_ATTEMPTS=5

TOOLS=""
MERGE_ARGS=()
if [ -f scripts/merge-rpc-usage.js ]; then
  TOOLS="$(mktemp -d)"
  trap 'rm -rf "$TOOLS"' EXIT
  mkdir -p "$TOOLS/scripts/lib"
  cp scripts/merge-rpc-usage.js "$TOOLS/scripts/"
  cp scripts/lib/rpcUsageMerge.js scripts/lib/runMetricsSummary.js "$TOOLS/scripts/lib/"
  echo "rpc-usage.json merge=rpc-usage" > "$TOOLS/attributes"
  MERGE_ARGS=(
    -c "core.attributesFile=$TOOLS/attributes"
    -c "merge.rpc-usage.name=rpc-usage.json counter merge"
    -c "merge.rpc-usage.driver=node $TOOLS/scripts/merge-rpc-usage.js %O %A %B"
  )
fi

apply_merged_usage() {
  local p
  [ -n "$TOOLS" ] && [ -f "$TOOLS/merged/paths.txt" ] || return 0
  while IFS= read -r p || [ -n "$p" ]; do
    [ -z "$p" ] && continue
    mkdir -p "$(dirname "$p")"
    cp "$TOOLS/merged/$p" "$p"
    git add -- "$p"
  done < "$TOOLS/merged/paths.txt"
  if git diff --cached --quiet; then
    return 0
  fi
  if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
    if [ ! -s "$TOOLS/last-msg.txt" ]; then
      echo "Merge rpc-usage.json counters [skip netlify]" > "$TOOLS/last-msg.txt"
    fi
    git commit -q -F "$TOOLS/last-msg.txt"
  else
    git commit --amend --no-edit -q
  fi
}

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  git fetch origin main
  PRE_HEAD="$(git rev-parse HEAD)"
  if [ -n "$TOOLS" ]; then
    rm -rf "$TOOLS/merged"
    mkdir -p "$TOOLS/merged"
    git log -1 --format=%B > "$TOOLS/last-msg.txt"
    if ! node "$TOOLS/scripts/merge-rpc-usage.js" --from-git "$(git merge-base HEAD origin/main)" "$PRE_HEAD" "origin/main" "$TOOLS/merged"; then
      echo "::error::could not merge rpc-usage.json counters; not retrying"
      exit 1
    fi
  fi
  if ! git "${MERGE_ARGS[@]}" rebase origin/main; then
    echo "conflicted paths:"
    git diff --name-only --diff-filter=U || true
    git rebase --abort || true
    echo "::error::rebase onto origin/main conflicted; not retrying"
    exit 1
  fi
  if [ -n "$TOOLS" ]; then
    if ! apply_merged_usage; then
      git reset --hard -q "$PRE_HEAD" || true
      echo "::error::could not recompute rpc-usage.json counters after rebase; not retrying"
      exit 1
    fi
  fi
  if git push origin HEAD:main; then
    exit 0
  fi
  echo "push rejected (attempt $attempt/$MAX_ATTEMPTS); retrying"
  sleep $((attempt * 5))
done

echo "::error::could not push to main after $MAX_ATTEMPTS attempts"
exit 1
