#!/usr/bin/env bash
# Rebase the current HEAD onto origin/main and push it, retrying on a lost race.
#
# The daily refresh runs one matrix job per project, and the watchdog, manual
# backfills and humans push to main too. A plain `fetch && rebase && push`
# fails with non-fast-forward whenever another push lands between the fetch and
# the push; this retries the whole sequence. A rebase conflict is NOT retried:
# it means two writers touched the same file, which needs a human.
#
# Run: bash scripts/push-main.sh
set -euo pipefail

MAX_ATTEMPTS=5

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  git fetch origin main
  if ! git rebase origin/main; then
    git rebase --abort || true
    echo "::error::rebase onto origin/main conflicted; not retrying"
    exit 1
  fi
  if git push origin HEAD:main; then
    exit 0
  fi
  echo "push rejected (attempt $attempt/$MAX_ATTEMPTS); retrying"
  sleep $((attempt * 5))
done

echo "::error::could not push to main after $MAX_ATTEMPTS attempts"
exit 1
