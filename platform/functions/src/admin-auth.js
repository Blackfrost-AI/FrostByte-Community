/**
 * Zero-trust admin gate (spec §5.1).
 *
 * Defense in depth — every layer must pass, in order:
 *   1. Interactive Firebase session only (bfk_ API keys are refused outright).
 *   2. Verified email.
 *   3. `frostbyteAdmin` custom claim (minted only by bootstrap / owner action).
 *   4. Live `admins/{uid}` Firestore record with status 'active'. Revoking the
 *      doc kills access even while an old ID token is still valid; token
 *      revocation itself is enforced at verification time (checkRevoked=true
 *      in index.js).
 *   5. For mutations: fresh password re-authentication — `auth_time` within
 *      the last 60 minutes. UNITS: auth_time is Unix SECONDS, now() is ms.
 *
 * This module is deliberately separate from the route handlers so the gate can
 * be unit-tested in isolation and reused by any future admin surface.
 */

import { requireIdentity } from './auth.js';
import { HubError, forbidden, badRequest } from './http.js';

/** Mutations demand a password re-auth this recent (milliseconds). */
export const ADMIN_STEP_UP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * @param {object|null} caller  Resolved identity from resolveIdentity.
 * @param {object} options
 * @param {object} options.store
 * @param {() => number} [options.now]
 * @param {boolean} [options.requireFreshAuth]  Enforce step-up freshness.
 * @param {boolean} [options.requireOwner]      Enforce role === 'owner'.
 * @returns {Promise<object>} the active admins/{uid} record.
 */
export async function requireAdmin(caller, { store, now = () => Date.now(), requireFreshAuth = false, requireOwner = false } = {}) {
  requireIdentity(caller);

  if (caller.authType !== 'firebase') {
    throw forbidden('Admin endpoints require an interactive Firebase session.', 'admin_requires_interactive_session');
  }

  if (caller.emailVerified !== true) {
    throw forbidden('Verified email required for admin access.', 'admin_email_unverified');
  }

  if (caller.claims?.frostbyteAdmin !== true) {
    throw forbidden('Admin access denied.', 'admin_forbidden');
  }

  const adminRecord = await store.getAdmin(caller.uid);
  if (!adminRecord || adminRecord.status !== 'active' || (adminRecord.role !== 'owner' && adminRecord.role !== 'admin')) {
    throw forbidden('Admin access denied.', 'admin_forbidden');
  }
  if (requireOwner && adminRecord.role !== 'owner') {
    throw forbidden('Owner clearance required.', 'admin_owner_required');
  }

  if (requireFreshAuth) {
    const authTimeSec = Number(caller.authTimeSec) || 0;
    const ageMs = now() - authTimeSec * 1000;
    if (!authTimeSec || ageMs > ADMIN_STEP_UP_MAX_AGE_MS) {
      throw new HubError(403, 'admin_reauth_required', 'Please re-enter your password to confirm this admin action.');
    }
  }

  return adminRecord;
}

/**
 * Every mutating admin route requires a substantive, human-readable reason
 * for the immutable audit log. Control characters are stripped; length 8–500.
 */
export function requireAuditReason(body) {
  const raw = typeof body?.reason === 'string' ? body.reason : '';
  const reason = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
  if (reason.length < 8) {
    throw badRequest('An audit reason (8–500 chars) is required.', 'audit_reason_required');
  }
  return reason;
}
