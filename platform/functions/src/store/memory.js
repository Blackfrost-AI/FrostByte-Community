/**
 * In-memory store.
 *
 * Used by the test suite and by `HUB_STORE=memory` for local development. It is
 * intentionally strict: it deep-clones on read and write so a test cannot pass
 * by mutating a shared object, which is exactly the class of bug that hides in
 * Firestore code until production.
 */

import { COLLECTIONS, encodeRecipeCursor, decodeRecipeCursor, recipeSearchHaystack, recipeMatchesTokens, RECIPE_SCAN_WINDOW, FOLLOW_CAP, PINNED_ANNOUNCEMENT_CAP } from './contract.js';

export function createMemoryStore({ now = () => Date.now() } = {}) {
  /** @type {Map<string, Map<string, object>>} */
  const tables = new Map();
  for (const name of Object.values(COLLECTIONS)) tables.set(name, new Map());

  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };

  const clone = (value) => (value === undefined ? undefined : structuredClone(value));

  // Keep the lowercase email index in lockstep with `email` on every write.
  const withEmailLower = (record) =>
    typeof record?.email === 'string' && record.email
      ? { ...record, emailLower: record.email.toLowerCase() }
      : record;

  const toMs = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  };

  // Newest-first pagination shared by the admin list endpoints. `cursor` is
  // the id of the last item on the previous page.
  const paginate = (rows, { limit = 25, cursor = null } = {}) => {
    let start = 0;
    if (cursor) {
      const index = rows.findIndex((row) => row.id === cursor);
      start = index >= 0 ? index + 1 : 0;
    }
    const items = rows.slice(start, start + limit).map(clone);
    const nextCursor = start + limit < rows.length && items.length ? items[items.length - 1].id : null;
    return { items, nextCursor };
  };

  const byIsoDesc = (field) => (a, b) => String(b[field] || '').localeCompare(String(a[field] || ''));

  return {
    kind: 'memory',

    async getUser(uid) {
      return clone(table(COLLECTIONS.users).get(uid)) || null;
    },

    async setUser(uid, record) {
      table(COLLECTIONS.users).set(uid, clone(withEmailLower({ ...record, uid, updatedAt: new Date(now()).toISOString() })));
      return clone(table(COLLECTIONS.users).get(uid));
    },

    // Atomic create-if-absent: returns the existing record unchanged if the
    // user already exists, otherwise inserts and returns the new one. Single-
    // threaded here, so the check-then-set cannot interleave.
    async createUserIfAbsent(uid, record) {
      const existing = table(COLLECTIONS.users).get(uid);
      if (existing) return { created: false, user: clone(existing) };
      const next = clone(withEmailLower({ ...record, uid, updatedAt: new Date(now()).toISOString() }));
      table(COLLECTIONS.users).set(uid, next);
      return { created: true, user: clone(next) };
    },

    async updateUser(uid, patch) {
      const existing = table(COLLECTIONS.users).get(uid);
      if (!existing) return null;
      const next = withEmailLower({ ...existing, ...clone(patch), uid, updatedAt: new Date(now()).toISOString() });
      table(COLLECTIONS.users).set(uid, next);
      return clone(next);
    },

    async deleteUser(uid) {
      return table(COLLECTIONS.users).delete(uid);
    },

    async getSubscription(uid) {
      return clone(table(COLLECTIONS.subscriptions).get(uid)) || null;
    },

    async setSubscription(uid, record) {
      table(COLLECTIONS.subscriptions).set(uid, clone({ ...record, uid }));
      return clone(table(COLLECTIONS.subscriptions).get(uid));
    },

    async getEntitlement(uid) {
      return clone(table(COLLECTIONS.entitlements).get(uid)) || null;
    },

    async setEntitlement(uid, record) {
      table(COLLECTIONS.entitlements).set(uid, clone({ ...record, uid }));
      return clone(table(COLLECTIONS.entitlements).get(uid));
    },

    async getOrg(orgId) {
      return clone(table(COLLECTIONS.orgs).get(orgId)) || null;
    },

    async setOrg(orgId, record) {
      table(COLLECTIONS.orgs).set(orgId, clone({ ...record, id: orgId }));
      return clone(table(COLLECTIONS.orgs).get(orgId));
    },

    async listOrgsForUser(uid) {
      return [...table(COLLECTIONS.orgs).values()]
        .filter((org) => Array.isArray(org.memberUids) && org.memberUids.includes(uid))
        .map(clone);
    },

    async getApiKey(keyHash) {
      return clone(table(COLLECTIONS.apiKeys).get(keyHash)) || null;
    },

    async setApiKey(keyHash, record) {
      table(COLLECTIONS.apiKeys).set(keyHash, clone({ ...record, keyHash }));
      return clone(table(COLLECTIONS.apiKeys).get(keyHash));
    },

    async deleteApiKey(keyHash) {
      return table(COLLECTIONS.apiKeys).delete(keyHash);
    },

    async listApiKeysForUser(uid) {
      return [...table(COLLECTIONS.apiKeys).values()].filter((key) => key.uid === uid).map(clone);
    },

    async countApiKeysForUser(uid) {
      return [...table(COLLECTIONS.apiKeys).values()].filter((key) => key.uid === uid && !key.revokedAt).length;
    },

    async getUsage(uid, day) {
      return clone(table(COLLECTIONS.usage).get(`${uid}:${day}`)) || null;
    },

    async incrementUsage(uid, day, field, amount = 1) {
      const id = `${uid}:${day}`;
      const existing = table(COLLECTIONS.usage).get(id) || { uid, day };
      const next = { ...existing, [field]: (Number(existing[field]) || 0) + amount };
      table(COLLECTIONS.usage).set(id, next);
      return clone(next);
    },

    async getCache(key) {
      const entry = table(COLLECTIONS.discoveryCache).get(key);
      if (!entry) return null;
      if (entry.expiresAt && Date.parse(entry.expiresAt) <= now()) return null;
      return clone(entry.value);
    },

    async setCache(key, value, ttlMs) {
      table(COLLECTIONS.discoveryCache).set(key, {
        value: clone(value),
        expiresAt: new Date(now() + ttlMs).toISOString(),
      });
    },

    async appendAudit(entry) {
      const id = `audit-${table(COLLECTIONS.auditLog).size + 1}`;
      table(COLLECTIONS.auditLog).set(id, clone({ ...entry, id, at: new Date(now()).toISOString() }));
    },

    async listAudit() {
      return [...table(COLLECTIONS.auditLog).values()].map(clone);
    },

    // ---- Admin console / user dashboard surface (contract v2) ----

    async listUsers({ query = '', limit = 25, cursor = null } = {}) {
      const all = [...table(COLLECTIONS.users).values()];
      const q = String(query || '').trim();
      let rows;
      if (!q) {
        rows = all.sort(byIsoDesc('createdAt'));
      } else {
        const byUid = table(COLLECTIONS.users).get(q);
        if (byUid) {
          rows = [byUid];
        } else {
          const qLower = q.toLowerCase();
          const prefixMatches = all.filter((user) => typeof user.emailLower === 'string' && user.emailLower.startsWith(qLower));
          const exactEmail = all.filter((user) => user.email === q && !prefixMatches.includes(user));
          rows = [...prefixMatches, ...exactEmail].sort(byIsoDesc('createdAt'));
        }
      }
      const page = paginate(rows.map((row) => ({ ...row, id: row.uid })), { limit, cursor });
      return { items: page.items.map(({ id, ...user }) => user), nextCursor: page.nextCursor };
    },

    async countUsers(tenantId = '') {
      if (!tenantId) return table(COLLECTIONS.users).size;
      return [...table(COLLECTIONS.users).values()].filter((user) => user.tenantId === tenantId).length;
    },

    async countActiveSubscriptions(nowMs) {
      return [...table(COLLECTIONS.subscriptions).values()].filter((sub) => {
        if (sub.tier !== 'plus' && sub.tier !== 'pro') return false;
        const end = toMs(sub.currentPeriodEnd);
        return end !== null && end > nowMs;
      }).length;
    },

    async recordStripeEvent(entry) {
      const record = clone({ ...entry });
      table(COLLECTIONS.stripeEvents).set(record.eventId, record);
      return clone(record);
    },

    async listStripeEvents({ limit = 50, cursor = null } = {}) {
      const rows = [...table(COLLECTIONS.stripeEvents).values()]
        .map((row) => ({ ...row, id: row.eventId }))
        .sort(byIsoDesc('processedAt'));
      const page = paginate(rows, { limit, cursor });
      return { items: page.items.map(({ id, ...event }) => event), nextCursor: page.nextCursor };
    },

    async countActiveApiKeys() {
      return [...table(COLLECTIONS.apiKeys).values()].filter((key) => !key.revokedAt).length;
    },

    async revokeAllApiKeysForUser(uid, nowIso = new Date(now()).toISOString()) {
      let revoked = 0;
      for (const [keyHash, key] of table(COLLECTIONS.apiKeys)) {
        if (key.uid === uid && !key.revokedAt) {
          table(COLLECTIONS.apiKeys).set(keyHash, { ...key, revokedAt: nowIso });
          revoked += 1;
        }
      }
      return revoked;
    },

    async listHardwareProfiles(uid) {
      return [...table(COLLECTIONS.hardwareProfiles).values()]
        .filter((profile) => profile.uid === uid)
        .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) || byIsoDesc('createdAt')(a, b))
        .map(clone);
    },

    async upsertHardwareProfile(uid, profile) {
      const id = `${uid}:${profile.id}`;
      const existing = table(COLLECTIONS.hardwareProfiles).get(id);
      const next = clone({
        ...profile,
        uid,
        createdAt: existing?.createdAt || profile.createdAt || new Date(now()).toISOString(),
        updatedAt: new Date(now()).toISOString(),
      });
      if (next.isDefault) {
        for (const [key, other] of table(COLLECTIONS.hardwareProfiles)) {
          if (other.uid === uid && other.id !== profile.id && other.isDefault) {
            table(COLLECTIONS.hardwareProfiles).set(key, { ...other, isDefault: false });
          }
        }
      }
      table(COLLECTIONS.hardwareProfiles).set(id, next);
      return clone(next);
    },

    async deleteHardwareProfile(uid, profileId) {
      return table(COLLECTIONS.hardwareProfiles).delete(`${uid}:${profileId}`);
    },

    async listSavedModels(uid) {
      return [...table(COLLECTIONS.savedModels).values()]
        .filter((item) => item.uid === uid)
        .sort(byIsoDesc('createdAt'))
        .map(clone);
    },

    async upsertSavedModel(uid, item) {
      const id = `${uid}:${item.modelKey}`;
      const existing = table(COLLECTIONS.savedModels).get(id);
      const next = clone({
        ...item,
        uid,
        createdAt: existing?.createdAt || item.createdAt || new Date(now()).toISOString(),
        updatedAt: new Date(now()).toISOString(),
      });
      table(COLLECTIONS.savedModels).set(id, next);
      return clone(next);
    },

    async deleteSavedModel(uid, modelKey) {
      return table(COLLECTIONS.savedModels).delete(`${uid}:${modelKey}`);
    },

    async getAdmin(uid) {
      return clone(table(COLLECTIONS.admins).get(uid)) || null;
    },

    async setAdmin(uid, record) {
      table(COLLECTIONS.admins).set(uid, clone({ ...record, uid, updatedAt: new Date(now()).toISOString() }));
      return clone(table(COLLECTIONS.admins).get(uid));
    },

    async listAdmins() {
      return [...table(COLLECTIONS.admins).values()].map(clone);
    },

    async getEntitlementOverride(uid) {
      return clone(table(COLLECTIONS.entitlementOverrides).get(uid)) || null;
    },

    async setEntitlementOverride(uid, override) {
      table(COLLECTIONS.entitlementOverrides).set(uid, clone({ ...override, uid, updatedAt: new Date(now()).toISOString() }));
      return clone(table(COLLECTIONS.entitlementOverrides).get(uid));
    },

    async clearEntitlementOverride(uid, meta = {}) {
      const existing = table(COLLECTIONS.entitlementOverrides).get(uid);
      if (!existing) return null;
      const next = clone({
        ...existing,
        status: 'revoked',
        revokedAt: new Date(now()).toISOString(),
        revokedBy: meta.revokedBy || null,
        reason: meta.reason || existing.reason || null,
        updatedAt: new Date(now()).toISOString(),
      });
      table(COLLECTIONS.entitlementOverrides).set(uid, next);
      return clone(next);
    },

    async countActiveOverrides(nowMs) {
      return [...table(COLLECTIONS.entitlementOverrides).values()].filter((override) => {
        if (override.status !== 'active' || (override.tier !== 'plus' && override.tier !== 'pro')) return false;
        const end = toMs(override.expiresAt);
        return end === null || end > nowMs;
      }).length;
    },

    async listModerationRules() {
      return [...table(COLLECTIONS.frostnetModeration).values()].sort(byIsoDesc('createdAt')).map(clone);
    },

    async upsertModerationRule(rule) {
      const existing = table(COLLECTIONS.frostnetModeration).get(rule.id);
      const next = clone({ ...rule, createdAt: existing?.createdAt || rule.createdAt || new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString() });
      table(COLLECTIONS.frostnetModeration).set(rule.id, next);
      return clone(next);
    },

    async deleteModerationRule(ruleId) {
      return table(COLLECTIONS.frostnetModeration).delete(ruleId);
    },

    async listFeaturedModels() {
      return [...table(COLLECTIONS.frostnetFeatured).values()]
        .sort((a, b) => (Number(a.rank) || 100) - (Number(b.rank) || 100) || byIsoDesc('createdAt')(a, b))
        .map(clone);
    },

    async upsertFeaturedModel(item) {
      const existing = table(COLLECTIONS.frostnetFeatured).get(item.id);
      const next = clone({ ...item, createdAt: existing?.createdAt || item.createdAt || new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString() });
      table(COLLECTIONS.frostnetFeatured).set(item.id, next);
      return clone(next);
    },

    async deleteFeaturedModel(id) {
      return table(COLLECTIONS.frostnetFeatured).delete(id);
    },

    async getFrostNetConfig() {
      return clone(table(COLLECTIONS.systemConfig).get('frostnet')) || null;
    },

    async setFrostNetConfig(config) {
      const existing = table(COLLECTIONS.systemConfig).get('frostnet') || {};
      const next = clone({ ...existing, ...config, id: 'frostnet', updatedAt: new Date(now()).toISOString() });
      table(COLLECTIONS.systemConfig).set('frostnet', next);
      return clone(next);
    },

    async clearDiscoveryCache() {
      const count = table(COLLECTIONS.discoveryCache).size;
      table(COLLECTIONS.discoveryCache).clear();
      return count;
    },

    async listAuditLog({ limit = 50, cursor = null, action = null, targetId = null } = {}) {
      let rows = [...table(COLLECTIONS.auditLog).values()];
      if (action) rows = rows.filter((entry) => entry.action === action);
      if (targetId) rows = rows.filter((entry) => entry.targetId === targetId);
      rows.sort(byIsoDesc('at'));
      return paginate(rows, { limit, cursor });
    },

    async createDesktopAuthCode(record) {
      const entry = clone({
        codeHash: record.codeHash,
        uid: record.uid,
        tenantId: record.tenantId || '',
        codeChallenge: record.codeChallenge,
        state: record.state,
        createdAt: record.createdAt || new Date(now()).toISOString(),
        expiresAt: record.expiresAt,
        usedAt: null,
      });
      table(COLLECTIONS.desktopAuthCodes).set(entry.codeHash, entry);
      return clone(entry);
    },

    async consumeDesktopAuthCode(codeHash, { nowMs = now() } = {}) {
      const existing = table(COLLECTIONS.desktopAuthCodes).get(codeHash);
      if (!existing) return null;
      if (existing.usedAt) return null;
      const usedIso = new Date(nowMs).toISOString();
      // Burn on first touch regardless of expiry so no second attempt can reuse it.
      existing.usedAt = usedIso;
      if (!existing.expiresAt || Date.parse(existing.expiresAt) <= nowMs) {
        return null;
      }
      return clone(existing);
    },

    async createDesktopSession(record) {
      const entry = clone({
        sessionId: record.sessionId,
        uid: record.uid,
        tenantId: record.tenantId || '',
        userAgent: record.userAgent || '',
        createdAt: record.createdAt || new Date(now()).toISOString(),
        revokedAt: null,
      });
      table(COLLECTIONS.desktopSessions).set(entry.sessionId, entry);
      return clone(entry);
    },

    async getDesktopSession(sessionId) {
      return clone(table(COLLECTIONS.desktopSessions).get(sessionId)) || null;
    },

    async revokeDesktopSession(sessionId, { uid, nowMs = now() } = {}) {
      const existing = table(COLLECTIONS.desktopSessions).get(sessionId);
      if (!existing || existing.uid !== uid) return { revoked: false };
      if (existing.revokedAt) return { revoked: true };
      existing.revokedAt = new Date(nowMs).toISOString();
      return { revoked: true };
    },

    async revokeAllDesktopSessionsForUser(uid, { nowMs = now() } = {}) {
      const revokedIso = new Date(nowMs).toISOString();
      let count = 0;
      for (const entry of table(COLLECTIONS.desktopSessions).values()) {
        if (entry.uid === uid && !entry.revokedAt) {
          entry.revokedAt = revokedIso;
          count += 1;
        }
      }
      return count;
    },

    // ---- Identity plane (ADR 003) -------------------------------------------

    async getHandle(handleLower) {
      return clone(table(COLLECTIONS.handles).get(handleLower)) || null;
    },

    /**
     * Reserve/rename/release a handle atomically against the reservation table.
     * Returns {ok:true, user} or {ok:false, code:'handle_taken'|'handle_reserved'|
     * 'handle_grace'|'not_found'|'not_owner'}. Grace-period (released) handles
     * block re-use by anyone but the original owner until releasedUntil passes.
     */
    async setHandle(uid, handle, { nowMs = now(), graceMs = 0 } = {}) {
      const user = table(COLLECTIONS.users).get(uid);
      if (!user) return { ok: false, code: 'not_found' };
      const handleLower = String(handle || '').toLowerCase();
      if (!handleLower) {
        // Release: tombstone the current handle into history with a grace window.
        const current = user.handleLower;
        if (current) {
          const existing = table(COLLECTIONS.handles).get(current);
          if (existing && existing.uid === uid) {
            table(COLLECTIONS.handles).delete(current);
            table(COLLECTIONS.handleHistory).set(current, {
              uid, handle: user.handle, handleLower: current,
              releasedAt: new Date(nowMs).toISOString(),
              releasedUntil: new Date(nowMs + graceMs).toISOString(),
            });
          }
          delete user.handle;
          delete user.handleLower;
          user.updatedAt = new Date(nowMs).toISOString();
        }
        return { ok: true, user: clone(user) };
      }
      const reservation = table(COLLECTIONS.handles).get(handleLower);
      if (reservation && reservation.uid !== uid) return { ok: false, code: 'handle_taken' };
      // Grace records are keyed by handleLower for cross-owner lookup.
      for (const record of table(COLLECTIONS.handleHistory).values()) {
        if (record.handleLower === handleLower && record.uid !== uid
          && Date.parse(record.releasedUntil) > nowMs) {
          return { ok: false, code: 'handle_grace' };
        }
      }
      const previous = user.handleLower;
      if (previous && previous !== handleLower) {
        const prevReservation = table(COLLECTIONS.handles).get(previous);
        if (prevReservation && prevReservation.uid === uid) {
          table(COLLECTIONS.handles).delete(previous);
          table(COLLECTIONS.handleHistory).set(previous, {
            uid, handle: user.handle, handleLower: previous,
            releasedAt: new Date(nowMs).toISOString(),
            releasedUntil: new Date(nowMs + graceMs).toISOString(),
          });
        }
      }
      table(COLLECTIONS.handles).set(handleLower, {
        handle, handleLower, uid, reservedAt: reservation?.reservedAt || new Date(nowMs).toISOString(),
      });
      user.handle = handle;
      user.handleLower = handleLower;
      user.updatedAt = new Date(nowMs).toISOString();
      return { ok: true, user: clone(user) };
    },

    async getHandleHistory(handleLower) {
      const records = [...table(COLLECTIONS.handleHistory).values()]
        .filter(r => r.handleLower === handleLower);
      return records.length ? clone(records[records.length - 1]) : null;
    },

    async getPublisherKey(pubKey) {
      return clone(table(COLLECTIONS.publisherKeys).get(pubKey)) || null;
    },

    /** Bind a pubkey to a uid. One pubkey → one uid, enforced here. */
    async setPublisherKey(pubKey, uid, { nowMs = now(), challengeId = '' } = {}) {
      const existing = table(COLLECTIONS.publisherKeys).get(pubKey);
      if (existing && existing.uid !== uid && !existing.unboundAt) {
        return { ok: false, code: 'key_bound_elsewhere' };
      }
      const user = table(COLLECTIONS.users).get(uid);
      if (!user) return { ok: false, code: 'not_found' };
      const boundAt = new Date(nowMs).toISOString();
      table(COLLECTIONS.publisherKeys).set(pubKey, { pubKey, uid, boundAt, challengeId, unboundAt: null });
      user.publisherKeys = { ...(user.publisherKeys || {}), [pubKey]: { boundAt, challengeId } };
      user.updatedAt = boundAt;
      return { ok: true, binding: clone(table(COLLECTIONS.publisherKeys).get(pubKey)) };
    },

    /** Owner-only tombstone unbind; attribution history is never rewritten. */
    async deletePublisherKey(pubKey, uid, { nowMs = now() } = {}) {
      const existing = table(COLLECTIONS.publisherKeys).get(pubKey);
      if (!existing || existing.uid !== uid) return { ok: false, code: 'not_owner' };
      if (existing.unboundAt) return { ok: true, already: true };
      existing.unboundAt = new Date(nowMs).toISOString();
      const user = table(COLLECTIONS.users).get(uid);
      if (user?.publisherKeys?.[pubKey]) {
        user.publisherKeys[pubKey].unboundAt = existing.unboundAt;
        user.updatedAt = existing.unboundAt;
      }
      return { ok: true };
    },

    async listPublisherKeysForUser(uid) {
      return [...table(COLLECTIONS.publisherKeys).values()]
        .filter(r => r.uid === uid).map(clone);
    },

    async createPublisherChallenge(record) {
      table(COLLECTIONS.publisherChallenges).set(record.challengeId, clone(record));
      return clone(record);
    },

    async getPublisherChallenge(challengeId) {
      return clone(table(COLLECTIONS.publisherChallenges).get(challengeId)) || null;
    },

    /** Single-use burn: returns the challenge once, null afterwards/expired. */
    async consumePublisherChallenge(challengeId, { nowMs = now() } = {}) {
      const existing = table(COLLECTIONS.publisherChallenges).get(challengeId);
      if (!existing || existing.usedAt) return null;
      existing.usedAt = new Date(nowMs).toISOString();
      if (Date.parse(existing.expiresAt) <= nowMs) return null;
      return clone(existing);
    },

    // ── Recipe share plane (P2) ────────────────────────────────────────
    // Heads are id-keyed; manifests are digest-addressed and immutable; the
    // change log is append-only (never trimmed — offline sync depends on it).
    // Terms / signature / binding checks happen in the route layer BEFORE
    // these methods. The store enforces the publish-time ownership pin
    // (ownerUid, never the live key binding), tombstones, id collisions and
    // idempotency — including under concurrency, because the head check and
    // write are one synchronous block here and one Firestore transaction
    // there.

    async publishRecipe({ manifest, digest, signature, ownerUid, terms, nowMs = now() } = {}) {
      const id = manifest.id;
      const existing = table(COLLECTIONS.recipes).get(id);
      if (existing) {
        if (existing.withdrawnAt) return { ok: false, code: 'withdrawn' };
        if (existing.ownerUid !== ownerUid) return { ok: false, code: 'not_owner' };
        if (existing.digest === digest) return { ok: true, idempotent: true, head: clone(existing) };
        // Same owner, new content: advance the head; old manifest stays immutable.
      }
      const nowIso = new Date(nowMs).toISOString();
      const head = {
        id,
        digest,
        signature,
        ownerUid,
        publisher: manifest.publisher,
        title: manifest.title,
        kind: manifest.kind,
        description: manifest.description || '',
        license: manifest.license.id,
        terms,
        currentVersion: existing ? existing.currentVersion + 1 : 1,
        createdAt: manifest.createdAt,
        publishedAt: nowIso,
        updatedAt: nowIso,
        withdrawnAt: null,
      };
      table(COLLECTIONS.recipes).set(id, clone(head));
      if (!table(COLLECTIONS.recipeManifests).has(digest)) {
        table(COLLECTIONS.recipeManifests).set(digest, { digest, signature, manifest: clone(manifest), storedAt: nowIso });
      }
      const change = {
        seq: table(COLLECTIONS.recipeChanges).size + 1,
        type: 'recipe.published',
        status: 'published',
        id,
        digest,
        publisher: manifest.publisher,
        at: nowIso,
      };
      table(COLLECTIONS.recipeChanges).set(String(change.seq), clone(change));
      return { ok: true, idempotent: false, head: clone(head), change: clone(change) };
    },

    async getRecipeHead(id) {
      return clone(table(COLLECTIONS.recipes).get(id)) || null;
    },

    async getRecipeManifest(digest) {
      return clone(table(COLLECTIONS.recipeManifests).get(digest)) || null;
    },

    async listRecipeHeadsByDigest(digest) {
      return [...table(COLLECTIONS.recipes).values()].filter(head => head.digest === digest).map(clone);
    },

    async withdrawRecipe(id, uid, { nowMs = now(), force = false } = {}) {
      const existing = table(COLLECTIONS.recipes).get(id);
      if (!existing) return { ok: false, code: 'not_found' };
      // Ownership is the publish-time pin. `force` is the operator takedown
      // path (admin route, audited) — the ONLY bypass, never the live binding.
      if (!force && existing.ownerUid !== uid) return { ok: false, code: 'not_owner' };
      if (existing.withdrawnAt) {
        // An owner withdraw arriving AFTER an operator takedown must not
        // clear the takedown flag (that would un-hide the digest).
        if (force && !existing.takedown) {
          existing.takedown = true;
          existing.updatedAt = new Date(nowMs).toISOString();
        }
        return { ok: true, already: true, head: clone(existing) };
      }
      const nowIso = new Date(nowMs).toISOString();
      existing.withdrawnAt = nowIso;
      existing.updatedAt = nowIso;
      if (force) existing.takedown = true;
      const change = {
        seq: table(COLLECTIONS.recipeChanges).size + 1,
        type: 'recipe.withdrawn',
        status: 'withdrawn',
        id,
        digest: existing.digest,
        publisher: existing.publisher,
        at: nowIso,
      };
      table(COLLECTIONS.recipeChanges).set(String(change.seq), clone(change));
      return { ok: true, already: false, head: clone(existing), change: clone(change) };
    },

    /**
     * Metadata search over live heads, `publishedAt DESC, id ASC`, opaque
     * keyset cursor. Token matching is shared with the Firestore store via
     * contract.js so the two backends can never drift: q is case-insensitive
     * substring; quant/format/task tokens match VERBATIM (Q4_K_M ≠ q4_k_m).
     */
    async listRecipes({ q = '', kind = '', task = '', format = '', quant = '', publisher = '', publishers = null, limit = 25, cursor = null } = {}) {
      const after = decodeRecipeCursor(cursor);
      // Mirror the Firestore scan window: newest RECIPE_SCAN_WINDOW heads by
      // publishedAt, then filter. Both backends see exactly the same rows.
      let rows = [...table(COLLECTIONS.recipes).values()]
        .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
        .slice(0, RECIPE_SCAN_WINDOW)
        .filter(head => !head.withdrawnAt);
      if (kind) rows = rows.filter(head => head.kind === kind);
      if (publisher) rows = rows.filter(head => head.publisher === publisher);
      // `publishers` is the following-feed filter: ONE scan against the caller's
      // follow set, never a per-follow fan-out (P3 review S3).
      if (Array.isArray(publishers)) {
        const allowed = new Set(publishers);
        rows = rows.filter(head => allowed.has(head.publisher));
      }
      if (q || task || format || quant) {
        rows = rows.filter(head => {
          const manifest = table(COLLECTIONS.recipeManifests).get(head.digest)?.manifest;
          return recipeMatchesTokens(recipeSearchHaystack(head, manifest), { q, task, format, quant });
        });
      }
      rows.sort((a, b) => (String(b.publishedAt).localeCompare(String(a.publishedAt)) || String(a.id).localeCompare(String(b.id))));
      if (after) {
        rows = rows.filter(head =>
          String(head.publishedAt) < after.publishedAt ||
          (String(head.publishedAt) === after.publishedAt && String(head.id) > after.id));
      }
      const items = rows.slice(0, limit).map(clone);
      const nextCursor = rows.length > limit && items.length ? encodeRecipeCursor(items[items.length - 1]) : null;
      return { items, nextCursor };
    },

    async listRecipeChanges({ limit = 50, cursor = null } = {}) {
      const start = cursor ? Number(cursor) : 0;
      const rows = [...table(COLLECTIONS.recipeChanges).values()]
        .filter(change => change.seq > start)
        .sort((a, b) => a.seq - b.seq);
      const items = rows.slice(0, limit).map(clone);
      const nextCursor = rows.length > limit && items.length ? String(items[items.length - 1].seq) : null;
      return { items, nextCursor };
    },

    async getUpdateFeed() {
      return clone(table(COLLECTIONS.updateFeed).get('current')) || null;
    },

    async setUpdateFeed(feed) {
      table(COLLECTIONS.updateFeed).set('current', clone(feed));
      return clone(feed);
    },

    // ── Community home plane (P3) ──────────────────────────────────────
    // Announcements + release notes are operator-published; the route layer
    // enforces admin auth, validation and audit. The store enforces the
    // pinned cap atomically (synchronous here, Firestore transaction there).
    // Timestamps are stored as ISO strings in BOTH stores (no Date coercion)
    // so hydrate/clone round-trips can never drift between backends.

    async listAnnouncements({ limit = 20 } = {}) {
      // Bounded read, single-field order, in-memory pinned-first sort — no
      // composite index needed (P3 review S9).
      const rows = [...table(COLLECTIONS.announcements).values()]
        .sort(byIsoDesc('publishedAt'))
        .slice(0, 100);
      rows.sort((a, b) => (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))) || byIsoDesc('publishedAt')(a, b));
      return rows.slice(0, limit).map(clone);
    },

    async getAnnouncement(id) {
      return clone(table(COLLECTIONS.announcements).get(id)) || null;
    },

    async putAnnouncement(record, { nowMs = now() } = {}) {
      const existing = table(COLLECTIONS.announcements).get(record.id);
      if (record.pinned) {
        let pinned = 0;
        for (const row of table(COLLECTIONS.announcements).values()) {
          if (row.pinned && row.id !== record.id) pinned += 1;
        }
        if (pinned >= PINNED_ANNOUNCEMENT_CAP) return { ok: false, code: 'pinned_cap' };
      }
      const nowIso = new Date(nowMs).toISOString();
      const next = {
        id: record.id,
        title: record.title,
        body: record.body,
        tag: record.tag || '',
        pinned: Boolean(record.pinned),
        publishedAt: existing?.publishedAt || record.publishedAt || nowIso,
        updatedAt: nowIso,
        authorUid: existing?.authorUid || record.authorUid || '',
      };
      table(COLLECTIONS.announcements).set(record.id, clone(next));
      return { ok: true, announcement: clone(next) };
    },

    async deleteAnnouncement(id) {
      return table(COLLECTIONS.announcements).delete(id);
    },

    async listReleaseNotes({ limit = 5 } = {}) {
      const rows = [...table(COLLECTIONS.releaseNotes).values()]
        .sort(byIsoDesc('released'))
        .slice(0, 100);
      return rows.slice(0, limit).map(clone);
    },

    async getReleaseNote(version) {
      return clone(table(COLLECTIONS.releaseNotes).get(version)) || null;
    },

    async putReleaseNote(record, { nowMs = now() } = {}) {
      const existing = table(COLLECTIONS.releaseNotes).get(record.version);
      const next = {
        version: record.version,
        released: record.released,
        title: record.title,
        body: record.body,
        current: Boolean(record.current),
        updatedAt: new Date(nowMs).toISOString(),
        authorUid: existing?.authorUid || record.authorUid || '',
      };
      table(COLLECTIONS.releaseNotes).set(record.version, clone(next));
      return { ok: true, releaseNote: clone(next) };
    },

    async deleteReleaseNote(version) {
      return table(COLLECTIONS.releaseNotes).delete(version);
    },

    // Follow graph: doc id `${uid}:${pubKey}`. Private per-user writes; only
    // aggregate counts are public. Cap enforced atomically (single-threaded
    // here; Firestore runTransaction there — review S4).
    async addFollow(uid, pubKey, { nowMs = now() } = {}) {
      const id = `${uid}:${pubKey}`;
      const existing = table(COLLECTIONS.follows).get(id);
      if (existing) return { ok: true, already: true, follow: clone(existing) };
      let count = 0;
      for (const row of table(COLLECTIONS.follows).values()) {
        if (row.uid === uid) count += 1;
      }
      if (count >= FOLLOW_CAP) return { ok: false, code: 'follow_cap' };
      const follow = { uid, pubKey, followedAt: new Date(nowMs).toISOString() };
      table(COLLECTIONS.follows).set(id, clone(follow));
      return { ok: true, already: false, follow: clone(follow) };
    },

    async removeFollow(uid, pubKey) {
      return table(COLLECTIONS.follows).delete(`${uid}:${pubKey}`);
    },

    async listFollowsForUser(uid) {
      return [...table(COLLECTIONS.follows).values()]
        .filter(row => row.uid === uid)
        .sort(byIsoDesc('followedAt'))
        .map(clone);
    },

    async countFollowers(pubKey) {
      let count = 0;
      for (const row of table(COLLECTIONS.follows).values()) {
        if (row.pubKey === pubKey) count += 1;
      }
      return count;
    },

    async countRecipesByPublisher(pubKey) {
      // Same scan window as search/feed; counts live heads (moderation-blocked
      // but not withdrawn heads still count — documented divergence, N16).
      const rows = [...table(COLLECTIONS.recipes).values()]
        .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
        .slice(0, RECIPE_SCAN_WINDOW);
      return rows.filter(head => !head.withdrawnAt && head.publisher === pubKey).length;
    },

    async deleteFollowsForUser(uid) {
      let removed = 0;
      for (const [id, row] of [...table(COLLECTIONS.follows).entries()]) {
        if (row.uid === uid) {
          table(COLLECTIONS.follows).delete(id);
          removed += 1;
        }
      }
      return removed;
    },

    // Test helpers — not part of the production contract.
    _dump(collection) {
      return [...table(collection).entries()].map(([key, value]) => [key, clone(value)]);
    },
  };
}