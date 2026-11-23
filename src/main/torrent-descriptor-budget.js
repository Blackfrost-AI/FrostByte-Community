/**
 * Process-wide budget for long-lived torrent file descriptors.
 *
 * Respect the process's actual soft limit, reserving at least half for
 * Electron, sockets, logs, updates, and native libraries. Older systems with
 * no available POSIX limit report retain the conservative 128-handle fallback.
 * Windows has no RLIMIT_NOFILE report. libuv wraps CreateFile handles with
 * _open_osfhandle, so reserve half of the CRT's 8,192 low-level descriptors
 * instead of relying on the much larger kernel-handle limit.
 * Acquisition is deliberately immediate: a transfer fails with a
 * clear, retryable error instead of building an unbounded waiter queue while
 * existing transfers keep their identity-bound descriptors open.
 */
export function descriptorCapacity(softLimit, platform = process.platform) {
  if (platform === 'win32' && softLimit == null) return 4096;
  if (softLimit === 'unlimited') return 16384;
  if (!Number.isSafeInteger(softLimit) || softLimit <= 0) return 128;
  return Math.max(1, Math.min(16384, Math.floor(softLimit / 2)));
}
function processCapacity() {
  try { return descriptorCapacity(process.report?.getReport()?.userLimits?.open_files?.soft); }
  catch { return descriptorCapacity(undefined); }
}
export const MAX_TORRENT_OPEN_DESCRIPTORS = processCapacity();

let descriptorsInUse = 0;
let descriptorHighWatermark = 0;

export function torrentDescriptorBudgetError() {
  return Object.assign(
    new Error(`The operating-system file-handle budget is full (${descriptorsInUse}/${MAX_TORRENT_OPEN_DESCRIPTORS}). This is not an ALT or item-count limit. Remove an unused transfer to release its file handles, then retry.`),
    { code: 'FROSTBYTE_DESCRIPTOR_BUDGET' },
  );
}

export function acquireTorrentDescriptor() {
  if (descriptorsInUse >= MAX_TORRENT_OPEN_DESCRIPTORS) throw torrentDescriptorBudgetError();
  descriptorsInUse++;
  descriptorHighWatermark = Math.max(descriptorHighWatermark, descriptorsInUse);
  let active = true;
  return Object.freeze({
    release() {
      if (!active) return false;
      active = false;
      descriptorsInUse--;
      return true;
    },
  });
}

/** Read-only diagnostics used by boundary tests and support logs. */
export function torrentDescriptorBudgetSnapshot() {
  return Object.freeze({
    inUse: descriptorsInUse,
    available: MAX_TORRENT_OPEN_DESCRIPTORS - descriptorsInUse,
    limit: MAX_TORRENT_OPEN_DESCRIPTORS,
    highWatermark: descriptorHighWatermark,
  });
}
