/** Result of holding a completed download to the AEON origin statement in its
 * model-card.json. One bounded shape for the main process, companions and the
 * renderer. Names are publisher-chosen text; only keys identify anyone. */
const HEX64 = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['verified', 'unsigned', 'failed']);
const REASONS = new Set(['hidden', 'manifest', 'missing', 'extra', 'changed', 'signature']);
const printable = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]|\p{Zl}|\p{Zp}/gu, ' ').trim().slice(0, max) : '';

export const CARD_FILE = 'model-card.json';
export const ORIGIN_SHARE_BLOCKED = 'This copy failed its AEON origin check and cannot be shared. Download the complete, unchanged model again.';

/** Null for anything that is not a recognizable result; never throws. */
export function normalizeOriginResult(raw) {
  if (!raw || typeof raw !== 'object' || !STATUSES.has(raw.status)) return null;
  const verified = raw.status === 'verified', failed = raw.status === 'failed';
  const signer = verified && HEX64.test(raw.signer || '') ? raw.signer : '';
  const identity = verified && HEX64.test(raw.identity || '') ? raw.identity : '';
  // A verified result without both keys is not a result anyone should trust.
  if (verified && (!signer || !identity)) return null;
  if (failed && !REASONS.has(raw.reason)) return null;
  return { status: raw.status, reason: failed ? raw.reason : '', path: failed ? printable(raw.path, 1024) : '',
    signer, identity, delegated: verified && signer !== identity, name: verified ? printable(raw.name, 64) : '',
    fingerprint: HEX64.test(raw.fingerprint || '') ? raw.fingerprint : '',
    checkedAt: Number.isSafeInteger(raw.checkedAt) && raw.checkedAt >= 0 ? raw.checkedAt : 0 };
}

export const originBlocksSharing = result => result?.status === 'failed';

const FAILURES = {
  hidden: path => `it contains a hidden file (${path})`,
  manifest: () => 'its file list is not valid',
  missing: path => `a listed file is not in this copy (${path})`,
  extra: path => `this copy has a file the publisher did not list (${path})`,
  changed: path => `a file differs from what the publisher listed (${path})`,
  signature: () => 'the publisher signature does not match these files',
};

/** Short text for a library card. `tone` is ok, neutral or warn. */
export function originSummary(raw) {
  const result = normalizeOriginResult(raw);
  if (!result) return null;
  if (result.status === 'verified') {
    const who = result.name ? `“${result.name}” · ` : '';
    return { tone: 'ok', label: 'Origin verified', detail: `${who}${result.delegated ? 'identity' : 'key'} ${result.identity.slice(0, 12)}…`, key: result.identity };
  }
  if (result.status === 'unsigned') return { tone: 'neutral', label: 'Origin unsigned', detail: 'The model card names no verifiable publisher.', key: '' };
  return { tone: 'warn', label: 'Origin check failed', detail: `Not shared onward: ${FAILURES[result.reason](result.path)}.`, key: '' };
}
