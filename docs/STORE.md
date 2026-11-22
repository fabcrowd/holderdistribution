# The data store

This document explains the store: why it exists, how it is laid out, how a nightly run writes to it,
what is built and merged, and what is not built yet. It is for a developer who has not seen the plan.
The full design, with every sequence and review, is local and uncommitted (`tasks/scale-100/design/`
in the owner's checkout: `0-architecture.md` for the frame, `2.1-store-and-publish.md` for the store).
Section numbers quoted as "design 14.6" refer to `2.1-store-and-publish.md`.

## Summary

- **Why.** Generated data lives in git today, and the repository grows 31 to 59 MB a day. Git size is the
  first limit at any number of coins. The goal is 100 or more coins for years, with no paid storage and
  little manual work.
- **What.** A store of packed files in GitHub Release assets, with a small manifest per coin in git
  (`data/manifests/`) that names the current state. Large account tables are kept as hash buckets plus one
  small change file per day, so a night writes what changed, not the whole coin.
- **Where it stands (2026-11-22).** The store code is built and merged (#199 to #214) and runs in
  production as a *dual-write* in the nightly: git stays the source of truth, the store receives a copy
  and is compared with it. Today every stored file is a whole file ("blob") in the `live` series. No table
  format is wired into the nightly yet, no data leaves git, and no release is ever deleted. See
  [Status](#status).

## Why: the size model

Everything is stated in these numbers (design `0-architecture.md`):

| Symbol | Meaning |
|---|---|
| N | coins |
| H | accounts with a balance, per coin |
| C | accounts whose balance changed, per coin per day (r = C/H is the change rate) |
| T | transfers per coin per day |
| D | days of history |
| B | buckets of one account table (about H / 262,144, minimum 1) |
| L | bytes and requests the ledger makes us read per day to find one coin's changes (a fifth size, measured when a coin is sized; it matters only for assets found by reading every block) |

The rules the store follows:

1. A night costs what changed, not what exists. Per coin, the bytes kept per night grow with C. H appears
   only in stated places: the first run, a rolling full check, one full copy of the account table per
   year, upkeep of old buckets, and reads of our own store.
2. No file, request reply or in-memory structure holds a whole coin. The unit of work is a fixed-size piece
   (a bucket of about 262,144 rows); a coin with 100 million accounts runs the same code as one with 10
   thousand, in more pieces.
3. A coin is a row of config. Nothing in the store names a coin or a chain; per-ledger differences are
   adapter capabilities.

Cost by size (design planning values; the row sizes are to be re-measured when tables are wired):

| H (accounts) | Buckets B | Restore, worst case (228 bytes per account) | Time at 35 MiB/s, one stream |
|---|---|---|---|
| 100 thousand | 1 | 22.8 MB | under 1 s |
| 1 million | 4 | 228 MB | 6 s |
| 10 million | 39 | 2.3 GB | 62 s |
| 100 million | 382 | 22.8 GB | 10.4 min |

Standing size of the store at a 1% daily change rate is about 346 bytes per account plus 36 MiB per coin
(35.8 GiB at N = 100, H = 1 million) and does not grow with D. Yearly growth of the permanent part is
about 38 bytes per account plus 3.7 MiB per coin. These are design estimates, not measurements of the
running store.

What is kept, and for how long (owner decisions of 2026-11-18 and 2026-11-19):

- Kept for good: every published history file (small, does not grow with H) and one full copy of the
  account table per year.
- Kept for `historyDays` (400, never below 371): the account table's daily change files. Inside that
  horizon any past day is rebuilt exactly from the store. Older per-account detail is not stored: the
  ledger is the archive, and on a ledger that can be read in the past an old day is read again on request.
- Everything that can be derived again is cleaned up when nothing refers to it.

## The pack and release model

Code: `scripts/lib/store/` (`pack.js`, `packNames.js`, `blobStore*.js`, `packItemStore.js`).

**Series.** Five series of GitHub prereleases named `data-<series>-<n>` (the names come from
`packNames.js`):

| Series | Class | What goes in | Kept |
|---|---|---|---|
| `keep` | kept for good | history files, classification list versions, closed years' index files, the yearly copy | for good; no automatic rule deletes from it |
| `hist` | by age | the account table's change files | the horizon (400 days) |
| `live` | by reference | bases, scan change files, whole-file blobs, bundle records, current index | while a coin's current or recent records name them |
| `events` | by age | every transfer of a day (design 11) | four days |
| `site` | by reference | the site root (design 12) | the newest 17 |

**Pack.** One uploaded asset holds many items. Layout: the bytes `HDB1`, a 4-byte header length, a JSON
header (class, kind, day, run, lane, coin list, and per item its type, coin, path, offset, length and
sha256), then each item compressed alone with brotli, so one item is read by HTTP Range. Pack names carry
the class, kind, newest data day, run id and attempt, lane and flush counter. A pack holds at most 16
coins and stays near a byte target.

**Locations are never replaced.** A reference is `<pack name>#<item id>`. The table from pack name to
release, size and hashes is written after the upload and saved with the coin's records; it is the only way
to resolve a reference. The same pack name in two releases is two objects. A stored location is never
overwritten: equal bytes are "already stored", different bytes are an error.

**Uploader.** A process uploads only into the newest release of a series or a newer one, never back. It
counts the release before every upload and rolls over to a new release at 900 assets (GitHub's limit is
1,000). It re-learns the newest release at least once an hour, never re-creates a release number that was
used (it checks the surviving git tag), and writes its own creation instant into the release body,
because GitHub's `created_at` is the commit date. A read by location costs no API request (public
download URL with Range, no token).

**Bundle.** One coin's record for one kind of run (`holders`, `ledger` or `walletFlows`): its item
references, the pack rows that resolve them without a listing, its parent bundle and its provider usage.
A bundle is identified by its full key `<release>/<pack name>#<item id>@<sha256>`, because up to 16 coins
share a pack and a crash and rerun can leave two copies of a pack name.

**Sweep (cleanup).** The sweep decides, with no I/O (`sweepPlan.js`, `sweepRules.js`), which stored packs
nothing needs any more; `sweep.js` lists each series once, reads only the headers it must and deletes by
location (`sweepExecute.js`). The rules:

- A pack a readable coin still names is kept in every class. A pack that lists a coin whose state could not
  be read that night, or an unknown coin, is kept. A removed coin's packs are held 30 days.
- Waits counted from an upload (18 days; 1 day for an upload that never finished) use elapsed time. The
  current site root and the 16 before it are kept. The `keep` series and any name the store did not make
  are never touched.
- If a coin's reference lookup throws, nothing is deleted that night.
- Deletes are paced one second apart, capped at twice the packs written in the run, and stop at the first
  403 or 429.
- `runSweep` is a dry run unless the caller says otherwise, and release deletes are a separate switch.
  **Release deletes are off** in the nightly. They stay off until the GitHub behaviors listed in design
  14.6 are measured by `scripts/store-probe.js` (by hand, on a throwaway `probe-` series; never run by a
  workflow). The probe has not been run yet.

## Tables

Code: `buckets.js`, `codec.js`, `tableWrite.js`, `tableRead.js`, `pastDay.js`, `yearlyCopy.js`,
`stateCheck.js`, `itemStore.js`.

A table is a generated file made of rows keyed by account. The store keeps it in hash buckets (linear
hashing: a bucket holds about 262,144 rows on average and splits one at a time as the table grows;
buckets never merge). Per bucket there is one **base** (every row at one position, a day and a part) plus
that bucket's rows in the **change files** written since. A change row carries the old and the new value,
so a past day can be read forward from a base or undone backward from a newer one. A day holds an ordered
list of parts: a second publish of the same day appends a part and never replaces the first. A past day
that is rewritten (gap fill, rebuild) also rewrites the next day's change file, so every later day reads
as before. A base is rewritten when its change rows reach its row count, or, once it has any change, by
age, so no base depends on a change file outside the horizon. A yearly copy of the account table is
written over 28 nights (`yearlyCopy.js`). Every rebuilt bucket is checked against a recorded row count and
hash (`stateCheck.js`); a mismatch is a named error that stops that coin.

**Formats.** A format is the code that turns a file into rows plus a header and back, byte for byte. The
store checks the rebuilt file's sha256 on every restore. Formats that exist today:

- The ever-held list `holders-ever-checkpoint.json` (`tableFormats.js`): read as a stream (one 1 MiB chunk
  in memory) and rebuilt from buckets through sorted runs on disk (`keyRuns.js`). The committed files of
  all four coins round-trip with equal sha256 (the 4.84 million row file in 11 seconds). The spec for it is
  `tableSpecs.js` (`tableSpecsFor(slug, layout)`; a coin gets it only if its registry entry requires that
  file).

Files that are refused as tables, because a file cannot be rebuilt byte for byte from its rows:

- The holder snapshot `tel-holders.json` (and the slim and legacy layouts): rows with equal balances
  followed the scan's insertion order, which cannot be rebuilt. #214 made the order deterministic (balance
  descending, then address ascending, `holderOrder.js`); the next nightly rewrites the tied rows once.
  Until that nightly is checked, no format is stacked on it.
- The raw-balance checkpoint `holders-checkpoint.json` (keys now in code-unit order since #214; its
  balances are JS doubles, so a format must store the IEEE-754 bits).
- The sharded snapshot (`tel-holders.d/wallets-NNN.tsv`): one table over many files, and the lane cannot
  yet name companion files in a spec.

A file with no format is stored whole as a blob (`laneBlobs.js`): whole up to 16 MiB, in 8 MiB slices
above. Which files a kind stores comes from `scripts/lib/storeFiles.js`: every file under the kind's
directories, minus scratch copies (`*-previous.json`), `.gitkeep`, hand-kept files and per-coin
`excludedFiles` in the registry (TEL's disposition UI file). A file that is neither stored nor excluded,
or that cannot be stored faithfully, fails the coin.

## Lanes and publish

A nightly run has per-coin **lane** work and one **publish** job. Lane code: `laneRestore.js`,
`lanePack.js`, `laneCli.js`, `packLane.js`; publish code: `publish.js`, `publishIndex.js`,
`publishSweep.js`, `publishFiles.js`; CLIs in `scripts/`.

1. **Restore** (`scripts/store-restore.js`). Reads the coin's manifest and `store.json` from facts about
   `origin/main` (written by `scripts/store-origin-facts.js`, the only script that runs git for them;
   a missing file fails closed instead of resetting a coin). Runs the stale-code guard, adoption, then
   restores the start bundle into a scratch folder (never the checkout), removing the coin's previously
   stored files first so deleted files stay deleted, and checking rebuilt tables against recorded hashes.
   Writes `start.json`.
2. **Stale-code guard** (`staleCodeGuard.js`). A rerun of an old run must not mix old code with today's
   data: it stops when code under `scripts`, `.github` or the package files changed on `main` after the
   attempt started. The plan job records the attempt's start (UTC, with a zone); an empty start is a named
   error, not a guess.
3. **Adoption** (`adoption.js`, `adoptionLane.js`). Finds bundles that earlier runs uploaded but never
   published, from the release listing and pack headers, verifies them by hash and by coin label, and links
   them into the longest chain the publish side accepts (at most 15, so the run's own entry makes 16). A
   failure to read bytes never shortens a chain: the coin fails for the night and retries; only a pack
   past a three-day bound is given up, after a second look 30 seconds later and with an alert.
4. **Pack** (`scripts/store-pack.js`). Lists the coin's stored files, settles blobs, writes table change
   files, uploads packs and bundles, and writes the lane's **candidate** (the coin's chain plus a sha256
   per generated file) as a small artifact.
5. **Publish** (`scripts/store-publish.js`, phase `publish`). Accepts each coin's candidate only through
   `acceptChain` (`acceptChain.js`), which applies the parent rule (a candidate is accepted only if its
   parent is the entry on `main` now), checks every named pack at its location and size, and reads and
   verifies every bundle it publishes; a chain longer than 16 days is refused. It writes the manifest
   `data/manifests/<slug>.json` (about 0.7 KB: the current bundle per kind, its parent, day, run and
   usage), one **index row** per published holders entry (`data/manifests/index/<slug>.json`), and
   `data/manifests/store.json` (the current release of each series, by the maximum rule over accepted
   coins). One coin's failure never blocks another, a bad manifest is never overwritten, and output is
   built in a temporary folder and moved into place only on success.
6. **Restore check and compare** (`store-overlay.js`, `store-restore.js`, `store-compare.js`). Each
   accepted coin is restored from the manifests as they will be after the publish, and every restored
   file's sha256 is compared with the lane's generated file. A difference is reported, never a failure.
7. **Commit.** `data/manifests/` goes into its own commit through `scripts/push-main.sh`.
8. **Sweep** (phase `sweep`): a dry run that reports what it would delete.

## Dual-write in `refresh-holders.yml`

Git stays the source of truth. The store steps run only after both git data commits of a coin are pushed,
so the store can only add to the git path. Steps:

- `plan` job: decides the switch (below) and records the attempt start.
- Per coin lane: `store_start` (origin facts, restore), `store_pack` (pack), upload of the candidate
  artifact, a store summary and a small status artifact.
- `store-publish` job: downloads candidates and lane status artifacts, publishes, restore-checks and
  compares, commits `data/manifests/`, runs the dry-run sweep, writes the summary and the issue.

**Non-blocking guarantees.** Every store command runs through `scripts/store-guard.sh`, which always
exits 0, records `ok` or `failed (exit N)` per step, and runs each command under a timeout. Lane store
steps use `continue-on-error` and are deliberately not part of the nightly's Stage verdict, so a store
failure cannot stop or redden the git path. A failed store step shows in the job summary, in an issues
artifact and in one issue titled "Store dual-write failure", filed once per run by the `store-publish`
job (it comments on the open issue with that title, or opens one).

**Kill switch.** The repository variable `HD_STORE` (set by the owner; takes effect from the next
scheduled night) or the `store` dispatch input (only for a dispatch that is allowed anyway, such as a
recovery run; never dispatch just to switch the store off, that is a second run for every coin that
already has the day's data): anything but `on`
(or an empty value, which means on) turns every store step off, and so does the switch step itself
failing, so a broken switch can only switch the store off, never the git data path. Only the holders
workflow writes to the store; no other workflow does yet.

## Failure table (summary)

The full table is design 9.5.

| Where it dies | State left | Next run |
|---|---|---|
| Lane, before its packs upload | nothing | starts from the entry on `main` |
| Lane, during an upload | an asset not in state `uploaded` | ignored by adoption, swept after 1 day |
| Lane, after all uploads | a complete bundle, maybe a candidate | adopted |
| Publish, before or during the push | bundles and candidates | adopted |
| Candidate refused as stale (another publish of the same coin landed) | its bundle is never named | starts from the `main` entry |
| State check fails on current state | that coin stops, others go on, an issue is filed | design 9.5: rebuild from git while git holds the data, later a fresh full read from the ledger |
| Sweep stopped by 403 or 429 | some deletes done | the rest later |
| Re-run of an old run | fresh lanes | stopped by the stale-code guard if `main` code changed before the attempt |

## Rollback

While git still holds every file, rollback is switching the store off (`HD_STORE=off`) or reverting the
workflow change; nothing reads the store. After a file has left git (not done for any file yet), the
design's rollback is: revert, export each day since the cutover from the store (`store-export.js`, not
built) and commit it. If the whole store were lost, the design restores published files from an archive on
the second data host, re-reads each coin's current holders from its ledger, and starts a new chain; per-
account history inside the horizon is then lost from the store (design 16).

## Status

As of 2026-11-22. "Merged" means the code is on `main` with tests; "running" means a scheduled nightly
executes it.

### Built and merged

| PR | What |
|---|---|
| #199 | Table code: buckets, bases, change files, forward and undo reads, past-day writes, yearly copy, state check (no network) |
| #201 | Packs and the blob store (folder and GitHub Releases backends, injected HTTP client, fake release server) |
| #203 | Records: bundle, manifest, usage, pointer files, candidate, chain acceptance, references |
| #204 | The sweep and the uploader's newest-only rule |
| #205 | Pack headers carry item type and coin; lane plumbing |
| #206 | Adoption, stale-code guard, start record |
| #207 | Lane restore and pack scripts, `storeFiles.js` |
| #208 | Publish step: manifests, index rows, `store.json` |
| #209 | Nightly dual-write in `refresh-holders.yml` |
| #211, #212 | Fixes found by the first runs: run start time, restore-check overlay markers for new coins |
| #213 | First real table format (the ever-held list) and `tableSpecs.js` |
| #214 | Deterministic holder tie order (prepares the balance-table formats) |
| #215 | This document; `npm run check:store-files` (every file a coin writes is stored or excluded; runs in the `verify` CI job); onboarding updated for the store |

### Running in production

The dual-write runs in the scheduled nightly for all four registered coins. The nightly of 2026-11-22
ran with the store on: all four coins restored, packed, published and passed the restore check; the issue
from the first runs (#210) was closed. What it does today: every stored file is a blob in the `live`
series (`data/manifests/store.json` names only a `live` release); manifests and index rows are committed
under `data/manifests/` (one manifest and one index file per coin exist for the four coins); the sweep
is a dry run and no release is deleted.

After #214 merged, the next nightly rewrites the tied wallet rows and the raw-balance checkpoint's key
order once. Check that nightly (gates green, holder counts and balances unchanged, no store failures)
before building the balance-table formats.

### Not built yet

In the order the owner's handoff gives (items 1 to 8), then the remaining items of the design:

| # | Item | Why it matters |
|---|---|---|
| 1 | Table formats for the balance table (slim-v1 and legacy snapshot, and the raw-balance checkpoint, storing IEEE-754 bits) | the account table is the large file; until it is a table the store keeps whole copies |
| 2 | Lane seam for the sharded snapshot (a spec that names companion files) | the sharded layout is one table over many files |
| 3 | Wire `--table-specs` into the nightly (`store-restore.js` and `store-pack.js` accept it; no workflow in `.github` passes it) | until then the ever-held format is unused in production |
| 4 | Run `scripts/store-probe.js` (design 14.6) | required before any release delete is switched on |
| 5 | Forced-failure tests (design 2.3a: five faults on an unlisted test coin) | proof of the failure table before data leaves git |
| 6 | Fix the manifest-commit race with other writers to `main` | needed before the ledger and wallet-flows publishes (more writers per night) |
| 7 | Dual-write for the other data workflows (ledger, wallet flows, others) | the lane CLIs accept the three kinds; only holders is wired |
| 8 | Yearly copy in the nightly; the `keep` and `events` classes; account-table history (change files, index, backfill from git) | the permanent and the by-age classes are not used yet; `hist`, `keep` and `events` hold nothing today |
| 9 | A second data host (GitHub Pages first, Cloudflare Pages as an equal second target; the `deploy` job, site root, run-time coin list, redirects from the old paths) | the site still reads data through `netlify/functions/live-data.mjs` and committed `public/data/` |

Stated as uncertain: the sizes and times in this document are design estimates (row sizes, bucket size,
25 minutes per coin), to be measured when tables are wired. Whether GitHub's terms allow Releases as
bulk storage at the sizes in design 15, and several GitHub behaviors (asset counts during upload, replies
to an upload into a deleted release, prerelease notifications), are unmeasured (design 14.6).
