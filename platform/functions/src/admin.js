/**
 * Owner/operator admin console API (`/v1/admin/*`) — spec §5.3.
 *
 * The zero-trust gate lives in admin-auth.js and is applied here to EVERY
 * admin route before its handler runs; mutating verbs additionally demand a
 * fresh password re-auth (step-up). Every mutation requires a human-readable
 * audit reason and appends an immutable auditLog entry (timestamp field `at`).
 * Secrets (API key hashes, reset links, passwords) never enter audit records
 * or responses.
 *
 * `adminDirectory` is the tenant-scoped Firebase Auth adapter injected by
 * index.js (hermetic fake in tests): getUser, updateUser, setCustomUserClaims,
 * revokeRefreshTokens, and sendPasswordResetEmail / generatePasswordResetLink.
 */

import { createHash, randomBytes } from 'node:crypto';

import { requireAdmin, requireAuditReason, ADMIN_STEP_UP_MAX_AGE_MS } from './admin-auth.js';
import { resolveEntitlement, publicEntitlement, capabilitiesFor } from './entitlements.js';
import { PROVIDERS } from './providers/model.js';
import { badRequest, notFound, conflict, unavailable, readJsonBody, sendJson } from './http.js';
import { consume } from './rate-limit.js';

const MAX_ADMIN_BODY_BYTES = 64 * 1024;

export const DEFAULT_FROSTNET_CONFIG = Object.freeze({
  enabledProviders: Object.freeze([...PROVIDERS]),
});

/** Strip control characters, bound length — used for every free-text field. */
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Validate + normalize a moderation target. Throws 400 with a clear message. */
export function normalizeModerationTarget(targetType, targetValue) {
  const type = cleanText(targetType, 20).toLowerCase();
  const value = cleanText(targetValue, 200);
  if (type === 'repo') {
    const lower = value.toLowerCase();
    const isOrgPrefix = /^[a-z0-9][a-z0-9._-]*\/\*$/.test(lower);
    const isRepo = /^(?:[a-z0-9]+:)?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._*-]*$/.test(lower);
    if (!isOrgPrefix && !isRepo) {
      throw badRequest('A repo target must look like owner/name (optionally provider:owner/name), or org/* for a prefix rule.');
    }
    return { targetType: 'repo', targetValue: lower, id: `repo-${sha256Hex(lower).slice(0, 24)}` };
  }
  if (type === 'infohash') {
    const lower = value.toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(lower)) {
      throw badRequest('An infohash target must be exactly 40 hexadecimal characters.');
    }
    return { targetType: 'infohash', targetValue: lower, id: `ih-${lower}` };
  }
  throw badRequest('targetType must be "repo" or "infohash".');
}

function redactApiKey(record) {
  return {
    prefix: record.prefix,
    label: record.label || '',
    createdAt: record.createdAt || null,
    lastUsedAt: record.lastUsedAt || null,
    expiresAt: record.expiresAt || null,
    revokedAt: record.revokedAt || null,
  };
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), min), max);
}

/**
 * Register every /v1/admin route on the shared router.
 *
 * Handler adapter: the router calls handlers with {req,res,params,identity,url}
 * and JSON-encodes plain return values as 200. Admin handlers here work with
 * {caller,params,query,req} and may return {status,body} for non-200 replies;
 * the adapter sends those directly.
 */
export function registerAdminRoutes(router, { store, now = () => Date.now(), adminDirectory, tenantId = '' } = {}) {
  const addRoute = (method, path, handler, { ownerOnly = false } = {}) => {
    router[method](path, async ({ req, res, params, identity, url }) => {
      const mutating = method.toUpperCase() !== 'GET';
      // Gate first (401/403 before any budget is spent), then the dedicated
      // 60 req/min admin bucket, then the handler.
      const adminRecord = await requireAdmin(identity, {
        store,
        now,
        requireFreshAuth: mutating,
        requireOwner: ownerOnly,
      });
      await consume({ store, uid: identity.uid, tier: identity.tier, bucket: 'admin', now });

      const result = await handler({
        caller: identity,
        adminRecord,
        params: params || {},
        query: Object.fromEntries(url.searchParams.entries()),
        req,
      });
      if (result && typeof result === 'object' && typeof result.status === 'number' && 'body' in result) {
        sendJson(res, result.status, result.body);
        return undefined;
      }
      return result;
    });
  };

  const writeAudit = async (caller, { action, targetType, targetId, reason, before = null, after = null }) => {
    await store.appendAudit({
      actorUid: caller.uid,
      actorEmail: caller.email || '',
      action,
      targetType,
      targetId,
      reason,
      before,
      after,
      at: new Date(now()).toISOString(),
    });
  };

  const isoFromAuthUser = (authUser) => {
    const parsed = Date.parse(authUser?.metadata?.creationTime || '');
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(now()).toISOString();
  };

  const isForeignTenantUser = (user) => {
    if (!tenantId || !user) return false;
    return user.tenantId !== tenantId;
  };

  /**
   * Ensure a tenant Auth user has a corresponding `users/{uid}` profile row
   * with ISO-8601 `createdAt` and matching `tenantId`, while refusing pre-tenant
   * quarantined records from another pool.
   */
  const materializeDirectoryUser = async (authUser) => {
    if (!authUser || !authUser.uid) return null;
    if (tenantId && authUser.tenantId && authUser.tenantId !== tenantId) return null;
    const existing = await store.getUser(authUser.uid);
    if (existing) {
      // Explicit non-empty foreign tenantId is always refused; missing tenantId
      // on a verified tenantAuth record is backfilled to this tenant.
      if (tenantId && existing.tenantId && existing.tenantId !== tenantId) return null;
      const patch = {};
      if (!existing.createdAt) patch.createdAt = isoFromAuthUser(authUser);
      if (tenantId && !existing.tenantId) patch.tenantId = tenantId;
      if (!existing.emailLower && (existing.email || authUser.email)) {
        patch.emailLower = String(existing.email || authUser.email || '').toLowerCase();
      }
      if (Object.keys(patch).length > 0) {
        return (await store.updateUser(authUser.uid, patch)) || { ...existing, ...patch };
      }
      return existing;
    }
    const email = String(authUser.email || '').trim();
    const resolvedTenantId = tenantId || String(authUser.tenantId || '');
    const created = await store.createUserIfAbsent(authUser.uid, {
      uid: authUser.uid,
      email,
      emailLower: email.toLowerCase(),
      displayName: String(authUser.displayName || '').trim(),
      photoUrl: String(authUser.photoURL || '').trim(),
      disabled: authUser.disabled === true,
      ...(resolvedTenantId ? { tenantId: resolvedTenantId } : {}),
      createdAt: isoFromAuthUser(authUser),
    });
    return created?.user || (await store.getUser(authUser.uid));
  };

  const ensureTargetUser = async (uid) => {
    const existing = await store.getUser(uid);
    if (existing) {
      if (tenantId) {
        if (existing.tenantId && existing.tenantId !== tenantId) {
          throw notFound('No such user.');
        }
        if (!existing.tenantId) {
          // Pre-tenant root-pool docs lack tenantId (or carry ''). Never stamp
          // tenantId onto a profile unless tenantAuth proves the UID lives here.
          if (!adminDirectory || typeof adminDirectory.getUser !== 'function') {
            throw notFound('No such user.');
          }
          const authUser = await adminDirectory.getUser(uid).catch(() => null);
          const materialized = await materializeDirectoryUser(authUser);
          if (!materialized) throw notFound('No such user.');
          return materialized;
        }
      }
      if (!existing.createdAt) {
        const patch = { createdAt: new Date(now()).toISOString() };
        return (await store.updateUser(uid, patch)) || { ...existing, ...patch };
      }
      return existing;
    }
    if (adminDirectory && typeof adminDirectory.getUser === 'function') {
      const authUser = await adminDirectory.getUser(uid).catch(() => null);
      const materialized = await materializeDirectoryUser(authUser);
      if (materialized) return materialized;
    }
    throw notFound('No such user.');
  };

  const syncRecentDirectoryUsers = async () => {
    if (!adminDirectory || typeof adminDirectory.listUsers !== 'function') return;
    let pageToken;
    for (let pageIdx = 0; pageIdx < 5; pageIdx += 1) {
      const result = await adminDirectory.listUsers(100, pageToken).catch(() => null);
      const authUsers = Array.isArray(result?.users) ? result.users : [];
      for (let i = 0; i < authUsers.length; i += 20) {
        const chunk = authUsers.slice(i, i + 20);
        await Promise.all(chunk.map((authUser) => materializeDirectoryUser(authUser)));
      }
      if (!result?.pageToken || authUsers.length === 0) break;
      pageToken = result.pageToken;
    }
  };

  const entitlementRow = async (uid, authUser = null) => {
    const [subscription, override, adminDoc] = await Promise.all([
      store.getSubscription(uid),
      store.getEntitlementOverride(uid),
      typeof store.getAdmin === 'function' ? store.getAdmin(uid) : Promise.resolve(null),
    ]);
    const isActiveAdmin = Boolean(
      adminDoc?.status === 'active'
      && (authUser ? (authUser.customClaims?.frostbyteAdmin === true && authUser.emailVerified !== false) : true),
    );
    return {
      subscription: subscription || null,
      entitlementOverride: override || null,
      adminRole: adminDoc?.status === 'active' ? adminDoc.role : null,
      entitlement: publicEntitlement(resolveEntitlement(subscription, now(), override, { isAdmin: isActiveAdmin })),
    };
  };

  // ---- Session / overview --------------------------------------------------

  addRoute('get', '/v1/admin/session', async ({ caller, adminRecord }) => {
    const authTimeSec = Number(caller.authTimeSec) || 0;
    const ageMs = now() - authTimeSec * 1000;
    return {
      admin: {
        uid: caller.uid,
        email: caller.email || '',
        role: adminRecord.role,
        authTime: authTimeSec ? new Date(authTimeSec * 1000).toISOString() : null,
        stepUpValidUntil: authTimeSec ? new Date(authTimeSec * 1000 + ADMIN_STEP_UP_MAX_AGE_MS).toISOString() : null,
        stepUpFresh: Boolean(authTimeSec) && ageMs <= ADMIN_STEP_UP_MAX_AGE_MS,
      },
    };
  });

  addRoute('get', '/v1/admin/overview', async () => {
    await syncRecentDirectoryUsers();
    const nowMs = now();
    const [totalUsers, activePaidSubscriptions, activeOverrides, activeApiKeys, blocked, featured, config, events, entries] =
      await Promise.all([
        store.countUsers(tenantId),
        store.countActiveSubscriptions(nowMs),
        store.countActiveOverrides(nowMs),
        store.countActiveApiKeys(),
        store.listModerationRules(),
        store.listFeaturedModels(),
        store.getFrostNetConfig(),
        store.listStripeEvents({ limit: 10 }),
        store.listAuditLog({ limit: 10 }),
      ]);
    return {
      metrics: {
        totalUsers,
        activePaidSubscriptions,
        activeOverrides,
        activeApiKeys,
        blockedModels: blocked.length,
        featuredModels: featured.length,
      },
      providerSettings: config || { ...DEFAULT_FROSTNET_CONFIG, enabledProviders: [...PROVIDERS] },
      recentWebhookEvents: events.items,
      recentAuditEntries: entries.items,
    };
  });

  // ---- Users ---------------------------------------------------------------

  addRoute('get', '/v1/admin/users', async ({ query }) => {
    const q = cleanText(query.q, 200);
    const cursor = typeof query.cursor === 'string' && query.cursor ? query.cursor.slice(0, 200) : null;
    if (!cursor && !q) {
      await syncRecentDirectoryUsers();
    } else if (!cursor && q.includes('@') && adminDirectory && typeof adminDirectory.getUserByEmail === 'function') {
      const authMatch = await adminDirectory.getUserByEmail(q.toLowerCase()).catch(() => null);
      if (authMatch) await materializeDirectoryUser(authMatch);
    }
    const requestedLimit = clampInt(query.limit, 25, 1, 50);
    const matchedUsers = [];
    let scanCursor = cursor;
    for (let pageIdx = 0; pageIdx < 5 && matchedUsers.length < requestedLimit; pageIdx += 1) {
      const page = await store.listUsers({
        query: q,
        limit: requestedLimit,
        cursor: scanCursor,
      });
      for (const user of page.items) {
        if (isForeignTenantUser(user)) continue;
        matchedUsers.push(user);
        if (matchedUsers.length >= requestedLimit) break;
      }
      scanCursor = page.nextCursor;
      if (!scanCursor || q) break;
    }
    const items = await Promise.all(
      matchedUsers.map(async (user) => ({
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || '',
        tenantId: user.tenantId || '',
        disabled: user.disabled === true,
        createdAt: user.createdAt || null,
        ...(await entitlementRow(user.uid)),
      })),
    );
    return { items, nextCursor: scanCursor };
  });

  addRoute('post', '/v1/admin/users', async ({ caller, req }) => {
    const body = await readJsonBody(req, MAX_ADMIN_BODY_BYTES);
    const reason = requireAuditReason(body);
    const email = cleanText(body.email, 254).toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw badRequest('A valid customer email address is required.');
    }
    const displayName = cleanText(body.displayName, 120);
    const tier = body.tier ? cleanText(body.tier, 10).toLowerCase() : 'free';
    if (tier !== 'free' && tier !== 'plus' && tier !== 'pro') {
      throw badRequest('tier must be "free", "plus", or "pro".');
    }
    let expiresAt = null;
    if ((tier === 'plus' || tier === 'pro') && body.expiresAt !== null && body.expiresAt !== undefined && body.expiresAt !== '') {
      const parsed = Date.parse(String(body.expiresAt));
      if (!Number.isFinite(parsed) || parsed <= now()) throw badRequest('expiresAt must be a future ISO date or null.');
      expiresAt = new Date(parsed).toISOString();
    }
    const sendSetupEmail = body.sendSetupEmail !== false;

    if (!adminDirectory || typeof adminDirectory.createUser !== 'function') {
      throw unavailable('Customer provisioning is not configured on this Hub.');
    }
    const emailSenderReady = typeof adminDirectory.sendPasswordResetEmail === 'function'
      && (typeof adminDirectory.canSendEmail !== 'function' || adminDirectory.canSendEmail());
    if (sendSetupEmail && !emailSenderReady) {
      throw unavailable('Password-setup email delivery is not configured on this deployment.');
    }

    if (typeof adminDirectory.getUserByEmail === 'function') {
      const existingAuth = await adminDirectory.getUserByEmail(email).catch(() => null);
      if (existingAuth) {
        await materializeDirectoryUser(existingAuth);
        throw conflict('A customer with that email already exists in FrostByte.', 'user_already_exists');
      }
    }

    const tempPassword = `${randomBytes(24).toString('base64url')}Aa1!`;
    let createdAuth;
    try {
      createdAuth = await adminDirectory.createUser({
        email,
        password: tempPassword,
        ...(displayName ? { displayName } : {}),
        emailVerified: false,
        disabled: false,
      });
    } catch (err) {
      if (err?.code === 'auth/email-already-exists' || String(err?.message || '').includes('EMAIL_EXISTS')) {
        throw conflict('A customer with that email already exists in FrostByte.', 'user_already_exists');
      }
      throw err;
    }

    const nowIso = new Date(now()).toISOString();
    const resolvedTenantId = tenantId || String(createdAuth.tenantId || '');
    await store.createUserIfAbsent(createdAuth.uid, {
      uid: createdAuth.uid,
      email,
      emailLower: email,
      displayName,
      photoUrl: '',
      disabled: false,
      ...(resolvedTenantId ? { tenantId: resolvedTenantId } : {}),
      createdAt: nowIso,
    });

    let override = null;
    if (tier === 'plus' || tier === 'pro') {
      override = await store.setEntitlementOverride(createdAuth.uid, {
        tier,
        status: 'active',
        expiresAt,
        reason,
        grantedBy: caller.uid,
        grantedAt: nowIso,
      });
    }

    let setupEmailSent = false;
    let warning = null;
    if (sendSetupEmail) {
      try {
        await adminDirectory.sendPasswordResetEmail(email);
        setupEmailSent = true;
      } catch {
        warning = 'Customer account was created, but sending the password-setup email failed. Use "Send password reset email" in the user drawer to retry.';
      }
    }

    await writeAudit(caller, {
      action: 'user.provisioned',
      targetType: 'user',
      targetId: createdAuth.uid,
      reason,
      before: null,
      after: { email, displayName, tier, expiresAt, setupEmailSent },
    });

    return {
      status: 201,
      body: {
        ok: true,
        uid: createdAuth.uid,
        email,
        displayName,
        tier,
        override,
        setupEmailSent,
        ...(warning ? { warning } : {}),
      },
    };
  });

  addRoute('get', '/v1/admin/users/:uid', async ({ params }) => {
    const profile = await ensureTargetUser(params.uid);
    const authUser = adminDirectory ? await adminDirectory.getUser(params.uid).catch(() => null) : null;
    const [row, apiKeys, hardware, saved, adminDoc] = await Promise.all([
      entitlementRow(params.uid, authUser),
      store.listApiKeysForUser(params.uid),
      store.listHardwareProfiles(params.uid),
      store.listSavedModels(params.uid),
      typeof store.getAdmin === 'function' ? store.getAdmin(params.uid) : Promise.resolve(null),
    ]);
    return {
      profile,
      ...row,
      admin: adminDoc || null,
      authUser: authUser
        ? {
            uid: authUser.uid,
            email: authUser.email || '',
            emailVerified: authUser.emailVerified === true,
            disabled: authUser.disabled === true,
            tenantId: authUser.tenantId || '',
            creationTime: authUser.metadata?.creationTime || null,
            lastSignInTime: authUser.metadata?.lastSignInTime || null,
          }
        : null,
      apiKeys: apiKeys.map(redactApiKey),
      hardwareProfileCount: hardware.length,
      savedModelCount: saved.length,
    };
  });

  addRoute('post', '/v1/admin/users/:uid/entitlement-override', async ({ caller, params, req }) => {
    const body = await readJsonBody(req, MAX_ADMIN_BODY_BYTES);
    const reason = requireAuditReason(body);
    await ensureTargetUser(params.uid);

    const tier = cleanText(body.tier, 10).toLowerCase();
    const before = await store.getEntitlementOverride(params.uid);

    if (tier === 'none') {
      const after = await store.clearEntitlementOverride(params.uid, { revokedBy: caller.uid, reason });
      await writeAudit(caller, { action: 'user.entitlement_override', targetType: 'user', targetId: params.uid, reason, before, after });
      return { ok: true, override: after };
    }

    if (tier !== 'plus' && tier !== 'pro') throw badRequest('tier must be "plus", "pro", or "none".');
    let expiresAt = null;
    if (body.expiresAt !== null && body.expiresAt !== undefined && body.expiresAt !== '') {
      const parsed = Date.parse(String(body.expiresAt));
      if (!Number.isFinite(parsed) || parsed <= now()) throw badRequest('expiresAt must be a future ISO date or null.');
      expiresAt = new Date(parsed).toISOString();
    }
    const after = await store.setEntitlementOverride(params.uid, {
      tier,
      status: 'active',
      expiresAt,
      reason,
      grantedBy: caller.uid,
      grantedAt: new Date(now()).toISOString(),
    });
    await writeAudit(caller, { action: 'user.entitlement_override', targetType: 'user', targetId: params.uid, reason, before, after });
    return { ok: true, override: after };
  });

  addRoute('post', '/v1/admin/users/:uid/status', async ({ caller, params, req }) => {
    const body = await readJsonBody(req, MAX_ADMIN_BODY_BYTES);
    const reason = requireAuditReason(body);
    if (params.uid === caller.uid) throw badRequest('You cannot disable your own admin account.', 'cannot_disable_self');
    if (typeof body.disabled !== 'boolean') throw badRequest('disabled must be a boolean.');
    const user = await ensureTargetUser(params.uid);

    const before = { disabled: user.disabled === true };
    if (adminDirectory) {
      await adminDirectory.updateUser(params.uid, { disabled: body.disabled });
      await adminDirectory.revokeRefreshTokens(params.uid);
    }
    if (body.disabled && typeof store.revokeAllDesktopSessionsForUser === 'function') {
      await store.revokeAllDesktopSessionsForUser(params.uid, { nowMs: now() });
    }
    await store.updateUser(params.uid, { disabled: body.disabled });
    let revokedKeys = 0;
    if (body.disabled && body.revokeApiKeys === true) {
      revokedKeys = await store.revokeAllApiKeysForUser(params.uid, new Date(now()).toISOString());
    }
    await writeAudit(caller, {
      action: 'user.status_change',
      targetType: 'user',
      targetId: params.uid,
      reason,
      before,
      after: { disabled: body.disabled, revokedApiKeys: revokedKeys },
    });
    return { ok: true, disabled: body.disabled, revokedApiKeys: revokedKeys };
  });

  // ADR 003 moderation hook: operator forced-release of an abusive handle.
  // The alias enters the same 30-day grace window as a voluntary rename, so a
  // squatter cannot immediately re-register it under a fresh account.
  addRoute('post', '/v1/admin/users/:uid/handle/release', async ({ caller, params, req }) => {
    const body = await readJsonBody(req, MAX_ADMIN_BODY_BYTES);
    const reason = requireAuditReason(body);
    const user = await ensureTargetUser(params.uid);
    if (!user.handleLower) throw notFound('That account has no handle to release.', 'no_handle');
    const before = { handle: user.handle, handleLower: user.handleLower };
    const result = await store.setHandle(params.uid, '', { nowMs: now(), graceMs: 30 * 24 * 60 * 60 * 1000 });
    if (!result.ok) throw notFound('That account has no handle to release.', 'no_handle');
    await writeAudit(caller, {
      action: 'user.handle_force_release',
      targetType: 'user',
      targetId: params.uid,
      reason,
      before,
      after: { handle: null },
    });
    return { ok: true, released: before.handleLower };
  });

  addRoute('post', '/v1/admin/users/:uid/reset-password', async ({ caller, params, req }) => {
    const body = await readJsonBody(req, MAX_ADMIN_BODY_BYTES);
    const reason = requireAuditReason(body);
    const user = await ensureTargetUser(params.uid);
    if (!user || !user.email) throw notFound('No such user.');
    if (!adminDirectory) throw conflict('Auth directory is not configured on this deployment.');
    // The reset is delivered by Firebase to the user's inbox. The raw link /
    // token never enters the response body or the audit log. A deployment
    // without an email sender must fail honestly rather than report "sent"
    // for a link that is generated and discarded.
    const emailSenderReady = typeof adminDirectory.sendPasswordResetEmail === 'function'
      && (typeof adminDirectory.canSendEmail !== 'function' || adminDirectory.canSendEmail());
    if (!emailSenderReady) {
      throw conflict('Password-reset email delivery is not configured on this deployment.');
    }
    await adminDirectory.sendPasswordResetEmail(user.email);
    await writeAudit(caller, { action: 'user.password_reset_triggered', targetType: 'user', targetId: params.uid, reason });
    return { ok: true, sentTo: user.email };
  });

  addRoute('delete', '/v1/admin/users/:uid/api-keys/:prefix', async ({ caller, params, req }) => {
    const body = await readJsonBody(req, MAX_ADMIN_BODY_BYTES);
    const reason = requireAuditReason(body);
    if (!/^[a-z0-9]{8}$/.test(params.prefix)) throw badRequest('Malformed key prefix.');
    const keys = await store.listApiKeysForUser(params.uid);
    const target = keys.find((key) => key.prefix === params.prefix && !key.revokedAt);
    if (!target) throw notFound('No active key with that prefix for this user.');
    await store.deleteApiKey(target.keyHash);
    await writeAudit(caller, {
      action: 'user.api_key_revoked',
      targetType: 'apiKey',
      targetId: `${params.uid}:${params.prefix}`,
      reason,
      before: redactApiKey(target),
      after: null,
    });
    return { ok: true };
  });

  addRoute('post', '/v1/admin/users/:uid/admin-role', async ({ caller, params, req }) => {
    const body = await readJsonBody(req, MAX_ADMIN_BODY_BYTES);
    const reason = requireAuditReason(body);
    const role = cleanText(body.role, 10).toLowerCase();
    if (role !== 'admin' && role !== 'owner' && role !== 'none') throw badRequest('role must be "admin", "owner", or "none".');
    if (params.uid === caller.uid && role !== 'owner') {
      throw badRequest('The acting owner cannot demote their own account.', 'cannot_demote_self');
    }
    const user = await ensureTargetUser(params.uid);
    if (!user) throw notFound('No such user.');
    if (!adminDirectory) throw conflict('Auth directory is not configured on this deployment.');

    const before = await store.getAdmin(params.uid);
    const authUser = await adminDirectory.getUser(params.uid).catch(() => null);
    const existingClaims = { ...(authUser?.customClaims || {}) };
    let revokedApiKeys = 0;
    if (role === 'none') {
      delete existingClaims.frostbyteAdmin;
      await adminDirectory.setCustomUserClaims(params.uid, existingClaims);
      await store.setAdmin(params.uid, { status: 'revoked', role: 'none', email: user.email || '', revokedBy: caller.uid, reason });
      revokedApiKeys = await store.revokeAllApiKeysForUser(params.uid, new Date(now()).toISOString());
    } else {
      existingClaims.frostbyteAdmin = true;
      await adminDirectory.setCustomUserClaims(params.uid, existingClaims);
      await store.setAdmin(params.uid, {
        status: 'active',
        role,
        email: user.email || '',
        emailLower: (user.email || '').toLowerCase(),
        grantedBy: caller.uid,
        reason,
      });
    }
    await adminDirectory.revokeRefreshTokens(params.uid);
    if (role === 'none' && typeof store.revokeAllDesktopSessionsForUser === 'function') {
      await store.revokeAllDesktopSessionsForUser(params.uid, { nowMs: now() });
    }
    const after = await store.getAdmin(params.uid);
    await writeAudit(caller, {
      action: 'admin.role_change',
      targetType: 'user',
      targetId: params.uid,
      reason,
      before,
      after: { ...(after || {}), ...(revokedApiKeys ? { revokedApiKeys } : {}) },
    });
    return { ok: true, role, admin: after, ...(revokedApiKeys ? { revokedApiKeys } : {}) };
  }, { ownerOnly: true });

  // ---- FrostNet moderation / featured / providers ---------------------------

  addRoute('get', '/v1/admin/frostnet/moderation', async () => {
    const [blocked, featured, config] = await Promise.all([
      store.listModerationRules(),
      store.listFeaturedModels(),
      store.getFrostNetConfig(),
    ]);
    return {
      blocked,
      featured,
      providerConfig: config || { ...DEFAULT_FROSTNET_CONFIG, enabledProviders: [...PROVIDERS] },
    };
  });

  addRoute('post', '/v1/admin/frostnet/moderation', async ({ caller, req }) => {
    const body = await readJsonBody(req, MAX_ADMIN_BODY_BYTES);
    const reason = requireAuditReason(body);
    const target = normalizeModerationTarget(body.targetType, body.targetValue);
    const after = await store.upsertModerationRule({
      id: target.id,
      targetType: target.targetType,
      targetValue: target.targetValue,
      reason,
      createdBy: caller.uid,
    });
    await writeAudit(caller, { action: 'frostnet.block_add', targetType: 'moderationRule', targetId: after.id, reason, after });
    return { status: 201, body: { ok: true, rule: after } };
  });

  addRoute('delete', '/v1/admin/frostnet/moderation/:ruleId', async ({ caller, params, req }) => {
    const body = await readJsonBody(req, MAX_ADMIN_BODY_BYTES);
    const reason = requireAuditReason(body);
    const rules = await store.listModerationRules();
    const before = rules.find((rule) => rule.id === params.ruleId) || null;
    const removed = await store.deleteModerationRule(params.ruleId);
    if (!removed) throw notFound('No such moderation rule.');
    await writeAudit(caller, { action: 'frostnet.block_remove', targetType: 'moderationRule', targetId: params.ruleId, reason, before });
    return { ok: true };
  });

  addRoute('post', '/v1/admin/frostnet/featured', async ({ caller, req }) => {
    const body = await readJsonBody(req, MAX_ADMIN_BODY_BYTES);
    const reason = requireAuditReason(body);
    const provider = cleanText(body.provider, 20).toLowerCase();
    if (!PROVIDERS.includes(provider)) throw badRequest(`provider must be one of: ${PROVIDERS.join(', ')}.`);
    const providerId = cleanText(body.providerId, 200);
    if (!providerId) throw badRequest('providerId is required.');
    const id = `feat-${sha256Hex(`${provider}:${providerId}`).slice(0, 24)}`;
    const after = await store.upsertFeaturedModel({
      id,
      provider,
      providerId,
      badge: cleanText(body.badge, 40) || 'Featured',
      note: cleanText(body.note, 200),
      rank: clampInt(body.rank, 50, 1, 100),
      reason,
      createdBy: caller.uid,
    });
    await writeAudit(caller, { action: 'frostnet.feature_upsert', targetType: 'featuredModel', targetId: id, reason, after });
    return { status: 201, body: { ok: true, featured: after } };
  });

  addRoute('delete', '/v1/admin/frostnet/featured/:id', async ({ caller, params, req }) => {
    const body = await readJsonBody(req, MAX_ADMIN_BODY_BYTES);
    const reason = requireAuditReason(body);
    const featured = await store.listFeaturedModels();
    const before = featured.find((item) => item.id === params.id) || null;
    const removed = await store.deleteFeaturedModel(params.id);
    if (!removed) throw notFound('No such featured entry.');
    await writeAudit(caller, { action: 'frostnet.feature_remove', targetType: 'featuredModel', targetId: params.id, reason, before });
    return { ok: true };
  });

  addRoute('post', '/v1/admin/frostnet/providers', async ({ caller, req }) => {
    const body = await readJsonBody(req, MAX_ADMIN_BODY_BYTES);
    const reason = requireAuditReason(body);
    if (!Array.isArray(body.enabledProviders) || body.enabledProviders.length === 0) {
      throw badRequest('enabledProviders must be a non-empty array.');
    }
    const enabled = [];
    for (const entry of body.enabledProviders) {
      const provider = cleanText(entry, 20).toLowerCase();
      if (!PROVIDERS.includes(provider)) throw badRequest(`Unknown provider: ${provider}`);
      if (!enabled.includes(provider)) enabled.push(provider);
    }
    const before = await store.getFrostNetConfig();
    const after = await store.setFrostNetConfig({ enabledProviders: enabled, updatedBy: caller.uid, reason });
    let flushed = 0;
    if (body.flushCache === true) flushed = await store.clearDiscoveryCache();
    await writeAudit(caller, {
      action: 'frostnet.providers_update',
      targetType: 'systemConfig',
      targetId: 'frostnet',
      reason,
      before,
      after: { ...after, cacheFlushed: flushed },
    });
    return { ok: true, providerConfig: after, cacheFlushed: flushed };
  });

  // ---- Billing ledger / audit log -------------------------------------------

  addRoute('get', '/v1/admin/billing/events', async ({ query }) => {
    return store.listStripeEvents({
      limit: clampInt(query.limit, 50, 1, 100),
      cursor: typeof query.cursor === 'string' && query.cursor ? query.cursor.slice(0, 200) : null,
    });
  });

  addRoute('get', '/v1/admin/audit-log', async ({ query }) => {
    return store.listAuditLog({
      limit: clampInt(query.limit, 50, 1, 100),
      cursor: typeof query.cursor === 'string' && query.cursor ? query.cursor.slice(0, 200) : null,
      action: typeof query.action === 'string' && query.action ? cleanText(query.action, 80) : null,
      targetId: typeof query.targetId === 'string' && query.targetId ? cleanText(query.targetId, 200) : null,
    });
  });
}
