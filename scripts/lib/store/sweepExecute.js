// Executes a plan's deletes through the blob store, by location (design 4.3, 9.5): one
// call at a time, SWEEP_DELETE_GAP_MS apart through the injected `sleep`, at most `cap` of
// them, and stopping at the first 403 or 429 with a count of what was left. Nothing is
// retried here; the release backend already waits through a short rate limit by itself.
// Empty releases go after the objects. The backend re-counts a release right before it
// deletes it, so a release that kept an asset (a stopped run, an upload that landed) is
// skipped, never emptied.
import { StoreNotFoundError, StoreRateLimitError, StoreHttpError, StoreReleaseNotEmptyError } from "./blobStore.js";
import { SWEEP_DELETE_GAP_MS } from "./storeConstants.js";
import { SweepDeleteError } from "./sweepErrors.js";

const RATE = /unexpected status (403|429)\b/;
const isStop = (err) => err instanceof StoreRateLimitError || (err instanceof StoreHttpError && RATE.test(err.message));

function opsOf(plan) {
  return [
    ...plan.delete.map((d) => ({ what: "object", id: d.loc, size: d.size, rule: d.rule })),
    ...plan.releasesToDelete.map((r) => ({ what: "release", id: r.tag, size: 0, rule: r.rule })),
  ];
}

async function perform(blobs, op, result) {
  if (op.what === "object") {
    await blobs.delete(op.id);
    result.deleted.push(op.id);
    result.bytesDeleted += op.size;
  } else {
    await blobs.deleteRelease(op.id);
    result.releasesDeleted.push(op.id);
  }
}

// Returns the outcome of one op: "done", "gone" or "skipped"; throws what must stop the run.
async function attempt(blobs, op, result) {
  try {
    await perform(blobs, op, result);
  } catch (err) {
    if (err instanceof StoreNotFoundError) return result.alreadyGone.push(op.id);
    if (op.what === "release" && err instanceof StoreReleaseNotEmptyError) return result.releasesSkipped.push(op.id);
    throw err;
  }
}

export async function executeDeletes({ blobs, plan, sleep, cap }) {
  const ops = opsOf(plan);
  const allowed = Math.min(ops.length, cap);
  const result = { deleted: [], bytesDeleted: 0, releasesDeleted: [], releasesSkipped: [], alreadyGone: [], stopped: null, left: 0, leftByCap: ops.length - allowed };
  let done = 0;
  for (; done < allowed; done++) {
    if (done > 0) await sleep(SWEEP_DELETE_GAP_MS);
    try {
      await attempt(blobs, ops[done], result);
    } catch (err) {
      if (isStop(err)) {
        result.stopped = { at: ops[done].id, error: err.message };
        break;
      }
      result.left = ops.length - done;
      throw new SweepDeleteError(`delete of ${ops[done].id} failed (rule: ${ops[done].rule}): ${err.message}`, result, { cause: err });
    }
  }
  result.left = ops.length - done;
  return result;
}
