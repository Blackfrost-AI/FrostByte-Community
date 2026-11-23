/**
 * Firestore-backed store.
 *
 * Targets the dedicated `hub` database, never `(default)` — the default database
 * carries live commerce records and the storefront's deployed rules (see
 * docs/adr/002-hub-backend-firebase.md).
 *
 * The Firestore module is injected rather than imported so the whole store can
 * be exercised without the Admin SDK installed and without a network.
 */

import { COLLECTIONS, encodeRecipeCursor, decodeRecipeCursor, recipeSearchHaystack, recipeMatchesTokens, RECIPE_SCAN_WINDOW, FOLLOW_CAP, PINNED_ANNOUNCEMENT_CAP } from './contract.js';

/**
 * @param {object} options
 * @param {object} options.firestore  A Firestore instance (Admin SDK compatible).
 * @param {() => number} [options.now]
 */
export function createFirestoreStore({ firestore, now = () => Date.now() }) {
  if (!firestore) throw new Error('createFirestoreStore requires a Firestore instance.');

  const col = (name) => firestore.collection(name);
  const toIso = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    if (typeof value.seconds === 'number') return new Date(value.seconds * 1000).toISOString();
    return null;
  };
  const fromIso = (value) => (value ? new Date(value) : null);

  const hydrate = (doc) => {
    if (!doc || !doc.exists) return null;
    const data = doc.data() || {};
    const record = { id: doc.id, ...data };
    for (const field of ['createdAt', 'updatedAt', 'currentPeriodEnd', 'expiresAt', 'revokedAt', 'processedAt', 'at', 'grantedAt', 'usedAt', 'boundAt', 'unboundAt', 'reservedAt', 'releasedAt', 'releasedUntil', 'publishedAt', 'withdrawnAt', 'storedAt', 'signedAt']) {
      if (data[field] !== undefined) record[field] = toIso(data[field]);
    }
    return record;
  };

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
    if (value && typeof value.toDate === 'function') return value.toDate().getTime();
    if (value && typeof value.seconds === 'number') return value.seconds * 1000;
    return null;
  };

  return {
    kind: 'firestore',

    async getUser(uid) {
      return hydrate(await col(COLLECTIONS.users).doc(uid).get());
    },

    async setUser(uid, record) {
      const payload = withEmailLower({ ...record, uid, updatedAt: new Date(now()) });
      delete payload.uid_;
      await col(COLLECTIONS.users).doc(uid).set(payload, { merge: false });
      return this.getUser(uid);
    },

    // Atomic create-if-absent using Firestore create() (fails with ALREADY_EXISTS
    // if the document is present). This closes the get-then-set race where two
    // concurrent first-authenticated requests could both provision.
    async createUserIfAbsent(uid, record) {
      const payload = withEmailLower({ ...record, uid, updatedAt: new Date(now()) });
      delete payload.uid_;
      try {
        await col(COLLECTIONS.users).doc(uid).create(payload);
        return { created: true, user: await this.getUser(uid) };
      } catch (error) {
        // gRPC ALREADY_EXISTS === 6; the admin SDK also exposes 'already-exists'.
        if (error && (error.code === 6 || error.code === 'already-exists')) {
          return { created: false, user: await this.getUser(uid) };
        }
        throw error;
      }
    },

    async updateUser(uid, patch) {
      const payload = withEmailLower({ ...patch, updatedAt: new Date(now()) });
      await col(COLLECTIONS.users).doc(uid).set(payload, { merge: true });
      return this.getUser(uid);
    },

    async deleteUser(uid) {
      await col(COLLECTIONS.users).doc(uid).delete();
      return true;
    },

    async getSubscription(uid) {
      const record = hydrate(await col(COLLECTIONS.subscriptions).doc(uid).get());
      return record;
    },

    async setSubscription(uid, record) {
      const payload = { ...record, uid, updatedAt: new Date(now()) };
      if (payload.currentPeriodEnd) payload.currentPeriodEnd = fromIso(payload.currentPeriodEnd) || payload.currentPeriodEnd;
      await col(COLLECTIONS.subscriptions).doc(uid).set(payload, { merge: false });
      return this.getSubscription(uid);
    },

    async getEntitlement(uid) {
      return hydrate(await col(COLLECTIONS.entitlements).doc(uid).get());
    },

    async setEntitlement(uid, record) {
      await col(COLLECTIONS.entitlements).doc(uid).set(
        { ...record, uid, updatedAt: new Date(now()) },
        { merge: false },
      );
      return this.getEntitlement(uid);
    },

    async getOrg(orgId) {
      return hydrate(await col(COLLECTIONS.orgs).doc(orgId).get());
    },

    async setOrg(orgId, record) {
      await col(COLLECTIONS.orgs).doc(orgId).set({ ...record, id: orgId }, { merge: false });
      return this.getOrg(orgId);
    },

    async listOrgsForUser(uid) {
      const snapshot = await col(COLLECTIONS.orgs).where('memberUids', 'array-contains', uid).limit(50).get();
      return snapshot.docs.map(hydrate).filter(Boolean);
    },

    async getApiKey(keyHash) {
      return hydrate(await col(COLLECTIONS.apiKeys).doc(keyHash).get());
    },

    async setApiKey(keyHash, record) {
      await col(COLLECTIONS.apiKeys).doc(keyHash).set({ ...record, keyHash }, { merge: false });
      return this.getApiKey(keyHash);
    },

    async deleteApiKey(keyHash) {
      await col(COLLECTIONS.apiKeys).doc(keyHash).delete();
      return true;
    },

    async listApiKeysForUser(uid) {
      const snapshot = await col(COLLECTIONS.apiKeys).where('uid', '==', uid).limit(100).get();
      return snapshot.docs.map(hydrate).filter(Boolean);
    },

    async countApiKeysForUser(uid) {
      const snapshot = await col(COLLECTIONS.apiKeys).where('uid', '==', uid).limit(200).get();
      return snapshot.docs.filter((doc) => !doc.data().revokedAt).length;
    },

    async getUsage(uid, day) {
      return hydrate(await col(COLLECTIONS.usage).doc(`${uid}:${day}`).get());
    },

    async incrementUsage(uid, day, field, amount = 1) {
      const ref = col(COLLECTIONS.usage).doc(`${uid}:${day}`);
      const { FieldValue } = firestore.constructor?.__fieldValue
        ? firestore.constructor
        : await import('firebase-admin/firestore').catch(() => ({ FieldValue: null }));
      if (FieldValue?.increment) {
        await ref.set({ uid, day, [field]: FieldValue.increment(amount) }, { merge: true });
      } else {
        // Fallback for injected fakes: read-modify-write.
        const current = (await ref.get()).data() || { uid, day };
        await ref.set({ ...current, [field]: (Number(current[field]) || 0) + amount }, { merge: true });
      }
      return this.getUsage(uid, day);
    },

    async getCache(key) {
      const entry = hydrate(await col(COLLECTIONS.discoveryCache).doc(key).get());
      if (!entry) return null;
      if (entry.expiresAt && Date.parse(entry.expiresAt) <= now()) return null;
      return entry.value ?? null;
    },

    async setCache(key, value, ttlMs) {
      await col(COLLECTIONS.discoveryCache).doc(key).set({
        value,
        expiresAt: new Date(now() + ttlMs),
      });
    },

    async appendAudit(entry) {
      await col(COLLECTIONS.auditLog).add({ ...entry, at: new Date(now()) });
    },

    async listAudit() {
      const snapshot = await col(COLLECTIONS.auditLog).limit(100).get();
      return snapshot.docs.map(hydrate).filter(Boolean);
    },

    // ---- Admin console / user dashboard surface (contract v2) ----

    async listUsers({ query = '', limit = 25, cursor = null } = {}) {
      const q = String(query || '').trim();
      const users = col(COLLECTIONS.users);
      if (!q) {
        let ordered = users.orderBy('createdAt', 'desc').limit(limit + 1);
        if (cursor) {
          const cursorDoc = await users.doc(cursor).get();
          if (cursorDoc?.exists) ordered = ordered.startAfter(cursorDoc);
        }
        const snapshot = await ordered.get();
        const docs = snapshot.docs.slice(0, limit);
        const items = docs.map(hydrate).filter(Boolean);
        const nextCursor = snapshot.docs.length > limit && docs.length ? docs[docs.length - 1].id : null;

        // Firestore orderBy('createdAt') excludes documents missing createdAt.
        // On the first page (!cursor), merge any un-timestamped legacy docs so
        // bootstrapped or pre-backfill profiles are never invisible in Admin.
        if (!cursor && items.length < limit) {
          const seen = new Set(items.map((item) => item.uid));
          const fallbackSnap = await users.limit(limit).get();
          for (const doc of fallbackSnap.docs) {
            if (items.length >= limit) break;
            const row = hydrate(doc);
            if (row && !row.createdAt && !seen.has(row.uid)) {
              seen.add(row.uid);
              items.push(row);
            }
          }
        }
        return { items, nextCursor };
      }
      // Exact uid first, then lowercase-email prefix, then exact email for
      // pre-backfill documents that predate the emailLower field.
      const byUid = hydrate(await users.doc(q).get());
      if (byUid) return { items: [byUid], nextCursor: null };
      const qLower = q.toLowerCase();
      const prefixSnapshot = await users
        .where('emailLower', '>=', qLower)
        .where('emailLower', '<', `${qLower}\uf8ff`)
        .limit(limit)
        .get();
      const items = prefixSnapshot.docs.map(hydrate).filter(Boolean);
      if (!items.length) {
        const exactSnapshot = await users.where('email', '==', q).limit(limit).get();
        items.push(...exactSnapshot.docs.map(hydrate).filter(Boolean));
      }
      return { items, nextCursor: null };
    },

    async countUsers(tenantId = '') {
      const query = tenantId
        ? col(COLLECTIONS.users).where('tenantId', '==', tenantId)
        : col(COLLECTIONS.users);
      const snapshot = await query.count().get();
      return snapshot.data().count;
    },

    async countActiveSubscriptions(nowMs) {
      const snapshot = await col(COLLECTIONS.subscriptions)
        .where('currentPeriodEnd', '>', new Date(nowMs))
        .get();
      return snapshot.docs
        .map((doc) => doc.data())
        .filter((sub) => sub.tier === 'plus' || sub.tier === 'pro').length;
    },

    async recordStripeEvent(entry) {
      await col(COLLECTIONS.stripeEvents).doc(entry.eventId).set({ ...entry, processedAt: entry.processedAt ? new Date(entry.processedAt) : new Date(now()) }, { merge: false });
      return entry;
    },

    async listStripeEvents({ limit = 50, cursor = null } = {}) {
      const events = col(COLLECTIONS.stripeEvents);
      let ordered = events.orderBy('processedAt', 'desc').limit(limit + 1);
      if (cursor) {
        const cursorDoc = await events.doc(cursor).get();
        if (cursorDoc?.exists) ordered = ordered.startAfter(cursorDoc);
      }
      const snapshot = await ordered.get();
      const docs = snapshot.docs.slice(0, limit);
      return {
        items: docs.map(hydrate).filter(Boolean),
        nextCursor: snapshot.docs.length > limit && docs.length ? docs[docs.length - 1].id : null,
      };
    },

    async countActiveApiKeys() {
      const snapshot = await col(COLLECTIONS.apiKeys).where('revokedAt', '==', null).count().get();
      return snapshot.data().count;
    },

    async revokeAllApiKeysForUser(uid, nowIso = new Date(now()).toISOString()) {
      const snapshot = await col(COLLECTIONS.apiKeys).where('uid', '==', uid).get();
      let revoked = 0;
      for (const doc of snapshot.docs) {
        if (!doc.data().revokedAt) {
          await doc.ref.set({ revokedAt: new Date(nowIso) }, { merge: true });
          revoked += 1;
        }
      }
      return revoked;
    },

    async listHardwareProfiles(uid) {
      const snapshot = await col(COLLECTIONS.hardwareProfiles).where('uid', '==', uid).limit(100).get();
      return snapshot.docs
        .map(hydrate)
        .filter(Boolean)
        .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },

    async upsertHardwareProfile(uid, profile) {
      const id = `${uid}:${profile.id}`;
      const ref = col(COLLECTIONS.hardwareProfiles).doc(id);
      const existing = hydrate(await ref.get());
      const payload = {
        ...profile,
        uid,
        createdAt: existing?.createdAt ? new Date(existing.createdAt) : new Date(profile.createdAt || now()),
        updatedAt: new Date(now()),
      };
      if (payload.isDefault) {
        const others = await col(COLLECTIONS.hardwareProfiles).where('uid', '==', uid).get();
        for (const doc of others.docs) {
          if (doc.id !== id && doc.data().isDefault) await doc.ref.set({ isDefault: false }, { merge: true });
        }
      }
      await ref.set(payload, { merge: false });
      return hydrate(await ref.get());
    },

    async deleteHardwareProfile(uid, profileId) {
      const ref = col(COLLECTIONS.hardwareProfiles).doc(`${uid}:${profileId}`);
      const existing = await ref.get();
      if (!existing.exists) return false;
      await ref.delete();
      return true;
    },

    async listSavedModels(uid) {
      const snapshot = await col(COLLECTIONS.savedModels).where('uid', '==', uid).limit(300).get();
      return snapshot.docs
        .map(hydrate)
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },

    async upsertSavedModel(uid, item) {
      const id = `${uid}:${item.modelKey}`;
      const ref = col(COLLECTIONS.savedModels).doc(id);
      const existing = hydrate(await ref.get());
      await ref.set(
        {
          ...item,
          uid,
          createdAt: existing?.createdAt ? new Date(existing.createdAt) : new Date(item.createdAt || now()),
          updatedAt: new Date(now()),
        },
        { merge: false },
      );
      return hydrate(await ref.get());
    },

    async deleteSavedModel(uid, modelKey) {
      const ref = col(COLLECTIONS.savedModels).doc(`${uid}:${modelKey}`);
      const existing = await ref.get();
      if (!existing.exists) return false;
      await ref.delete();
      return true;
    },

    async getAdmin(uid) {
      return hydrate(await col(COLLECTIONS.admins).doc(uid).get());
    },

    async setAdmin(uid, record) {
      await col(COLLECTIONS.admins).doc(uid).set({ ...record, uid, updatedAt: new Date(now()) }, { merge: true });
      return this.getAdmin(uid);
    },

    async listAdmins() {
      const snapshot = await col(COLLECTIONS.admins).limit(100).get();
      return snapshot.docs.map(hydrate).filter(Boolean);
    },

    async getEntitlementOverride(uid) {
      return hydrate(await col(COLLECTIONS.entitlementOverrides).doc(uid).get());
    },

    async setEntitlementOverride(uid, override) {
      const payload = { ...override, uid, updatedAt: new Date(now()) };
      if (payload.expiresAt) payload.expiresAt = new Date(payload.expiresAt);
      await col(COLLECTIONS.entitlementOverrides).doc(uid).set(payload, { merge: false });
      return this.getEntitlementOverride(uid);
    },

    async clearEntitlementOverride(uid, meta = {}) {
      const existing = await this.getEntitlementOverride(uid);
      if (!existing) return null;
      await col(COLLECTIONS.entitlementOverrides).doc(uid).set(
        {
          status: 'revoked',
          revokedAt: new Date(now()),
          revokedBy: meta.revokedBy || null,
          reason: meta.reason || existing.reason || null,
          updatedAt: new Date(now()),
        },
        { merge: true },
      );
      return this.getEntitlementOverride(uid);
    },

    async countActiveOverrides(nowMs) {
      const snapshot = await col(COLLECTIONS.entitlementOverrides).where('status', '==', 'active').get();
      return snapshot.docs
        .map((doc) => doc.data())
        .filter((override) => {
          if (override.tier !== 'plus' && override.tier !== 'pro') return false;
          const end = toMs(toIso(override.expiresAt));
          return end === null || end > nowMs;
        }).length;
    },

    async listModerationRules() {
      const snapshot = await col(COLLECTIONS.frostnetModeration).limit(500).get();
      return snapshot.docs
        .map(hydrate)
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },

    async upsertModerationRule(rule) {
      const ref = col(COLLECTIONS.frostnetModeration).doc(rule.id);
      const existing = hydrate(await ref.get());
      await ref.set(
        {
          ...rule,
          createdAt: existing?.createdAt ? new Date(existing.createdAt) : new Date(rule.createdAt || now()),
          updatedAt: new Date(now()),
        },
        { merge: false },
      );
      return hydrate(await ref.get());
    },

    async deleteModerationRule(ruleId) {
      const ref = col(COLLECTIONS.frostnetModeration).doc(ruleId);
      const existing = await ref.get();
      if (!existing.exists) return false;
      await ref.delete();
      return true;
    },

    async listFeaturedModels() {
      const snapshot = await col(COLLECTIONS.frostnetFeatured).limit(200).get();
      return snapshot.docs
        .map(hydrate)
        .filter(Boolean)
        .sort((a, b) => (Number(a.rank) || 100) - (Number(b.rank) || 100) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },

    async upsertFeaturedModel(item) {
      const ref = col(COLLECTIONS.frostnetFeatured).doc(item.id);
      const existing = hydrate(await ref.get());
      await ref.set(
        {
          ...item,
          createdAt: existing?.createdAt ? new Date(existing.createdAt) : new Date(item.createdAt || now()),
          updatedAt: new Date(now()),
        },
        { merge: false },
      );
      return hydrate(await ref.get());
    },

    async deleteFeaturedModel(id) {
      const ref = col(COLLECTIONS.frostnetFeatured).doc(id);
      const existing = await ref.get();
      if (!existing.exists) return false;
      await ref.delete();
      return true;
    },

    async getFrostNetConfig() {
      return hydrate(await col(COLLECTIONS.systemConfig).doc('frostnet').get());
    },

    async setFrostNetConfig(config) {
      await col(COLLECTIONS.systemConfig).doc('frostnet').set({ ...config, id: 'frostnet', updatedAt: new Date(now()) }, { merge: true });
      return this.getFrostNetConfig();
    },

    async clearDiscoveryCache() {
      const snapshot = await col(COLLECTIONS.discoveryCache).get();
      for (const doc of snapshot.docs) await doc.ref.delete();
      return snapshot.size;
    },

    async listAuditLog({ limit = 50, cursor = null, action = null, targetId = null } = {}) {
      const log = col(COLLECTIONS.auditLog);
      let query = log;
      if (action) query = query.where('action', '==', action);
      if (targetId) query = query.where('targetId', '==', targetId);
      let ordered = query.orderBy('at', 'desc').limit(limit + 1);
      if (cursor) {
        const cursorDoc = await log.doc(cursor).get();
        if (cursorDoc?.exists) ordered = ordered.startAfter(cursorDoc);
      }
      const snapshot = await ordered.get();
      const docs = snapshot.docs.slice(0, limit);
      return {
        items: docs.map(hydrate).filter(Boolean),
        nextCursor: snapshot.docs.length > limit && docs.length ? docs[docs.length - 1].id : null,
      };
    },

    async createDesktopAuthCode(record) {
      const ref = col(COLLECTIONS.desktopAuthCodes).doc(record.codeHash);
      await ref.set({
        codeHash: record.codeHash,
        uid: record.uid,
        tenantId: record.tenantId || '',
        codeChallenge: record.codeChallenge,
        state: record.state,
        createdAt: new Date(record.createdAt || now()),
        expiresAt: new Date(record.expiresAt),
        usedAt: null,
      }, { merge: false });
      return hydrate(await ref.get());
    },

    async consumeDesktopAuthCode(codeHash, { nowMs = now() } = {}) {
      const ref = col(COLLECTIONS.desktopAuthCodes).doc(codeHash);
      const runTx = typeof firestore.runTransaction === 'function'
        ? (fn) => firestore.runTransaction(fn)
        : async (fn) => fn({
          get: (r) => r.get(),
          set: (r, data, opts) => r.set(data, opts),
        });
      return runTx(async (tx) => {
        const snap = await tx.get(ref);
        const data = hydrate(snap);
        if (!data || data.usedAt) return null;
        const usedAtDate = new Date(nowMs);
        // Burn on first touch inside the transaction so a leaked or expired code
        // can never be retried under concurrency or clock skew.
        tx.set(ref, { usedAt: usedAtDate }, { merge: true });
        const expiresMs = toMs(data.expiresAt);
        if (!expiresMs || expiresMs <= nowMs) return null;
        return { ...data, usedAt: usedAtDate.toISOString() };
      });
    },

    async createDesktopSession(record) {
      const ref = col(COLLECTIONS.desktopSessions).doc(record.sessionId);
      await ref.set({
        sessionId: record.sessionId,
        uid: record.uid,
        tenantId: record.tenantId || '',
        userAgent: record.userAgent || '',
        createdAt: new Date(record.createdAt || now()),
        revokedAt: null,
      }, { merge: false });
      return hydrate(await ref.get());
    },

    async getDesktopSession(sessionId) {
      return hydrate(await col(COLLECTIONS.desktopSessions).doc(sessionId).get());
    },

    async revokeDesktopSession(sessionId, { uid, nowMs = now() } = {}) {
      const ref = col(COLLECTIONS.desktopSessions).doc(sessionId);
      const runTx = typeof firestore.runTransaction === 'function'
        ? (fn) => firestore.runTransaction(fn)
        : async (fn) => fn({
          get: (r) => r.get(),
          set: (r, data, opts) => r.set(data, opts),
        });
      return runTx(async (tx) => {
        const data = hydrate(await tx.get(ref));
        if (!data || data.uid !== uid) return { revoked: false };
        if (data.revokedAt) return { revoked: true };
        tx.set(ref, { revokedAt: new Date(nowMs) }, { merge: true });
        return { revoked: true };
      });
    },

    async revokeAllDesktopSessionsForUser(uid, { nowMs = now() } = {}) {
      const snapshot = await col(COLLECTIONS.desktopSessions).where('uid', '==', uid).get();
      const activeDocs = snapshot.docs.filter((doc) => !doc.data().revokedAt);
      if (activeDocs.length === 0) return 0;
      const revokedDate = new Date(nowMs);
      if (typeof firestore.batch === 'function') {
        for (let i = 0; i < activeDocs.length; i += 450) {
          const batch = firestore.batch();
          for (const doc of activeDocs.slice(i, i + 450)) {
            batch.set(doc.ref, { revokedAt: revokedDate }, { merge: true });
          }
          await batch.commit();
        }
      } else {
        for (const doc of activeDocs) {
          await doc.ref.set({ revokedAt: revokedDate }, { merge: true });
        }
      }
      return activeDocs.length;
    },

    // ---- Identity plane (ADR 003) -------------------------------------------

    async getHandle(handleLower) {
      return hydrate(await col(COLLECTIONS.handles).doc(handleLower).get());
    },

    /**
     * Transactional handle reservation/rename/release. Reads the reservation,
     * the grace record, and the user doc inside one transaction so two users
     * cannot race the same alias. Same result codes as the memory store.
     */
    async setHandle(uid, handle, { nowMs = now(), graceMs = 0 } = {}) {
      const handleLower = String(handle || '').toLowerCase();
      const userRef = col(COLLECTIONS.users).doc(uid);
      const runTx = typeof firestore.runTransaction === 'function'
        ? (fn) => firestore.runTransaction(fn)
        : async (fn) => fn({
          get: (r) => r.get(),
          set: (r, data, opts) => r.set(data, opts),
          delete: (r) => r.delete(),
        });
      try {
        return await runTx(async (tx) => {
          const user = hydrate(await tx.get(userRef));
          if (!user) return { ok: false, code: 'not_found' };
          const nowIso = new Date(nowMs).toISOString();
          if (!handleLower) {
            const current = user.handleLower;
            if (current) {
              const resRef = col(COLLECTIONS.handles).doc(current);
              const reservation = hydrate(await tx.get(resRef));
              if (reservation && reservation.uid === uid) {
                tx.delete(resRef);
                tx.set(col(COLLECTIONS.handleHistory).doc(current), {
                  uid, handle: user.handle, handleLower: current,
                  releasedAt: nowIso, releasedUntil: new Date(nowMs + graceMs).toISOString(),
                }, { merge: false });
              }
              tx.set(userRef, { handle: null, handleLower: null, updatedAt: new Date(nowMs) }, { merge: true });
            }
            return { ok: true, user: { ...user, handle: null, handleLower: null } };
          }
          const resRef = col(COLLECTIONS.handles).doc(handleLower);
          const reservation = hydrate(await tx.get(resRef));
          if (reservation && reservation.uid !== uid) return { ok: false, code: 'handle_taken' };
          const grace = hydrate(await tx.get(col(COLLECTIONS.handleHistory).doc(handleLower)));
          if (grace && grace.uid !== uid && toMs(grace.releasedUntil) > nowMs) {
            return { ok: false, code: 'handle_grace' };
          }
          const previous = user.handleLower;
          if (previous && previous !== handleLower) {
            const prevRef = col(COLLECTIONS.handles).doc(previous);
            const prevReservation = hydrate(await tx.get(prevRef));
            if (prevReservation && prevReservation.uid === uid) {
              tx.delete(prevRef);
              tx.set(col(COLLECTIONS.handleHistory).doc(previous), {
                uid, handle: user.handle, handleLower: previous,
                releasedAt: nowIso, releasedUntil: new Date(nowMs + graceMs).toISOString(),
              }, { merge: false });
            }
          }
          tx.set(resRef, {
            handle, handleLower, uid,
            reservedAt: reservation?.reservedAt || nowIso,
          }, { merge: false });
          tx.set(userRef, { handle, handleLower, updatedAt: new Date(nowMs) }, { merge: true });
          return { ok: true, user: { ...user, handle, handleLower } };
        });
      } catch (error) {
        if (error && (error.code === 6 || error.code === 'already-exists')) {
          return { ok: false, code: 'handle_taken' };
        }
        throw error;
      }
    },

    async getHandleHistory(handleLower) {
      return hydrate(await col(COLLECTIONS.handleHistory).doc(handleLower).get());
    },

    async getPublisherKey(pubKey) {
      return hydrate(await col(COLLECTIONS.publisherKeys).doc(pubKey).get());
    },

    /** Transactional bind: one pubkey → one uid (reverse index is the lock). */
    async setPublisherKey(pubKey, uid, { nowMs = now(), challengeId = '' } = {}) {
      const keyRef = col(COLLECTIONS.publisherKeys).doc(pubKey);
      const userRef = col(COLLECTIONS.users).doc(uid);
      const runTx = typeof firestore.runTransaction === 'function'
        ? (fn) => firestore.runTransaction(fn)
        : async (fn) => fn({
          get: (r) => r.get(),
          set: (r, data, opts) => r.set(data, opts),
        });
      return runTx(async (tx) => {
        const existing = hydrate(await tx.get(keyRef));
        if (existing && existing.uid !== uid && !existing.unboundAt) {
          return { ok: false, code: 'key_bound_elsewhere' };
        }
        const user = hydrate(await tx.get(userRef));
        if (!user) return { ok: false, code: 'not_found' };
        const boundAt = new Date(nowMs).toISOString();
        const binding = { pubKey, uid, boundAt, challengeId, unboundAt: null };
        tx.set(keyRef, binding, { merge: false });
        tx.set(userRef, {
          publisherKeys: { ...(user.publisherKeys || {}), [pubKey]: { boundAt, challengeId } },
          updatedAt: new Date(nowMs),
        }, { merge: true });
        return { ok: true, binding };
      });
    },

    async deletePublisherKey(pubKey, uid, { nowMs = now() } = {}) {
      const keyRef = col(COLLECTIONS.publisherKeys).doc(pubKey);
      const runTx = typeof firestore.runTransaction === 'function'
        ? (fn) => firestore.runTransaction(fn)
        : async (fn) => fn({
          get: (r) => r.get(),
          set: (r, data, opts) => r.set(data, opts),
        });
      return runTx(async (tx) => {
        const existing = hydrate(await tx.get(keyRef));
        if (!existing || existing.uid !== uid) return { ok: false, code: 'not_owner' };
        if (existing.unboundAt) return { ok: true, already: true };
        const unboundAt = new Date(nowMs).toISOString();
        tx.set(keyRef, { unboundAt }, { merge: true });
        const userRef = col(COLLECTIONS.users).doc(uid);
        const user = hydrate(await tx.get(userRef));
        if (user?.publisherKeys?.[pubKey]) {
          tx.set(userRef, {
            publisherKeys: { ...user.publisherKeys, [pubKey]: { ...user.publisherKeys[pubKey], unboundAt } },
            updatedAt: new Date(nowMs),
          }, { merge: true });
        }
        return { ok: true };
      });
    },

    async listPublisherKeysForUser(uid) {
      const snapshot = await col(COLLECTIONS.publisherKeys).where('uid', '==', uid).get();
      return snapshot.docs.map(hydrate);
    },

    async createPublisherChallenge(record) {
      await col(COLLECTIONS.publisherChallenges).doc(record.challengeId).set({
        ...record,
        createdAt: new Date(record.createdAt || now()),
        expiresAt: new Date(record.expiresAt),
        usedAt: null,
      }, { merge: false });
      return hydrate(await col(COLLECTIONS.publisherChallenges).doc(record.challengeId).get());
    },

    async getPublisherChallenge(challengeId) {
      return hydrate(await col(COLLECTIONS.publisherChallenges).doc(challengeId).get());
    },

    async consumePublisherChallenge(challengeId, { nowMs = now() } = {}) {
      const ref = col(COLLECTIONS.publisherChallenges).doc(challengeId);
      const runTx = typeof firestore.runTransaction === 'function'
        ? (fn) => firestore.runTransaction(fn)
        : async (fn) => fn({
          get: (r) => r.get(),
          set: (r, data, opts) => r.set(data, opts),
        });
      return runTx(async (tx) => {
        const data = hydrate(await tx.get(ref));
        if (!data || data.usedAt) return null;
        const usedAtDate = new Date(nowMs);
        tx.set(ref, { usedAt: usedAtDate }, { merge: true });
        const expiresMs = toMs(data.expiresAt);
        if (!expiresMs || expiresMs <= nowMs) return null;
        return { ...data, usedAt: usedAtDate.toISOString() };
      });
    },

    // ── Recipe share plane (P2) ────────────────────────────────────────
    // Heads are id-keyed; manifests are digest-addressed and create-only;
    // the change log is append-only (never trimmed — offline sync depends on
    // it). The head doc is the transaction lock (same reverse-index pattern
    // as setPublisherKey); the seq counter is read INSIDE the same
    // transaction so concurrent publishes can never collide on a seq. That
    // counter serializes recipe writes through one hot doc (~1 sustained
    // write/sec) — the documented v1 scale ceiling.

    async publishRecipe({ manifest, digest, signature, ownerUid, terms, nowMs = now() } = {}) {
      const id = manifest.id;
      const headRef = col(COLLECTIONS.recipes).doc(id);
      const manifestRef = col(COLLECTIONS.recipeManifests).doc(digest);
      const counterRef = col(COLLECTIONS.systemConfig).doc('recipeChangesSeq');
      const runTx = typeof firestore.runTransaction === 'function'
        ? (fn) => firestore.runTransaction(fn)
        : async (fn) => fn({
          get: (r) => r.get(),
          set: (r, data, opts) => r.set(data, opts),
          create: (r, data) => r.create(data),
        });
      return runTx(async (tx) => {
        // All reads before any write (Firestore transaction requirement).
        const existing = hydrate(await tx.get(headRef));
        if (existing) {
          if (existing.withdrawnAt) return { ok: false, code: 'withdrawn' };
          if (existing.ownerUid !== ownerUid) return { ok: false, code: 'not_owner' };
          if (existing.digest === digest) return { ok: true, idempotent: true, head: existing };
        }
        const manifestDoc = await tx.get(manifestRef);
        const counterDoc = hydrate(await tx.get(counterRef));
        const seq = (Number(counterDoc?.seq) || 0) + 1;
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
        const change = {
          seq,
          type: 'recipe.published',
          status: 'published',
          id,
          digest,
          publisher: manifest.publisher,
          at: nowIso,
        };
        tx.set(headRef, head, { merge: false });
        // Manifest docs are immutable: create-only, never overwrite a digest.
        if (!manifestDoc.exists) {
          tx.create(manifestRef, { digest, signature, manifest, storedAt: nowIso });
        }
        tx.set(col(COLLECTIONS.recipeChanges).doc(String(seq)), change, { merge: false });
        tx.set(counterRef, { seq }, { merge: false });
        return { ok: true, idempotent: false, head, change };
      });
    },

    async getRecipeHead(id) {
      return hydrate(await col(COLLECTIONS.recipes).doc(id).get());
    },

    async getRecipeManifest(digest) {
      return hydrate(await col(COLLECTIONS.recipeManifests).doc(digest).get());
    },

    async listRecipeHeadsByDigest(digest) {
      const snapshot = await col(COLLECTIONS.recipes).where('digest', '==', digest).limit(50).get();
      return snapshot.docs.map(hydrate);
    },

    async withdrawRecipe(id, uid, { nowMs = now(), force = false } = {}) {
      const headRef = col(COLLECTIONS.recipes).doc(id);
      const counterRef = col(COLLECTIONS.systemConfig).doc('recipeChangesSeq');
      const runTx = typeof firestore.runTransaction === 'function'
        ? (fn) => firestore.runTransaction(fn)
        : async (fn) => fn({
          get: (r) => r.get(),
          set: (r, data, opts) => r.set(data, opts),
        });
      return runTx(async (tx) => {
        const existing = hydrate(await tx.get(headRef));
        if (!existing) return { ok: false, code: 'not_found' };
        // Ownership is the publish-time pin; `force` is the audited operator
        // takedown path — the ONLY bypass, never the live key binding.
        if (!force && existing.ownerUid !== uid) return { ok: false, code: 'not_owner' };
        if (existing.withdrawnAt) {
          // Owner withdraw after an operator takedown must not clear the flag.
          if (force && !existing.takedown) {
            const patchAt = new Date(nowMs).toISOString();
            tx.set(headRef, { takedown: true, updatedAt: patchAt }, { merge: true });
            return { ok: true, already: true, head: { ...existing, takedown: true, updatedAt: patchAt } };
          }
          return { ok: true, already: true, head: existing };
        }
        const counterDoc = hydrate(await tx.get(counterRef));
        const seq = (Number(counterDoc?.seq) || 0) + 1;
        const nowIso = new Date(nowMs).toISOString();
        const change = {
          seq,
          type: 'recipe.withdrawn',
          status: 'withdrawn',
          id,
          digest: existing.digest,
          publisher: existing.publisher,
          at: nowIso,
        };
        const patch = { withdrawnAt: nowIso, updatedAt: nowIso };
        if (force) patch.takedown = true;
        tx.set(headRef, patch, { merge: true });
        tx.set(col(COLLECTIONS.recipeChanges).doc(String(seq)), change, { merge: false });
        tx.set(counterRef, { seq }, { merge: false });
        return { ok: true, already: false, head: { ...existing, ...patch }, change };
      });
    },

    async listRecipes({ q = '', kind = '', task = '', format = '', quant = '', publisher = '', publishers = null, limit = 25, cursor = null } = {}) {
      const after = decodeRecipeCursor(cursor);
      // Single-field inequality on withdrawnAt would need a composite index;
      // the plane is small at launch, so filter in memory after a bounded read.
      // Documented v1 ceiling: the RECIPE_SCAN_WINDOW newest heads (shared
      // constant — the memory store mirrors it). Token semantics are shared
      // with the memory store via contract.js (verbatim quant/format/task).
      const snapshot = await col(COLLECTIONS.recipes).orderBy('publishedAt', 'desc').limit(RECIPE_SCAN_WINDOW).get();
      let rows = snapshot.docs.map(hydrate).filter(head => !head.withdrawnAt);
      if (kind) rows = rows.filter(head => head.kind === kind);
      if (publisher) rows = rows.filter(head => head.publisher === publisher);
      // `publishers` is the following-feed filter: ONE scan against the
      // caller's follow set, never a per-follow fan-out (P3 review S3).
      if (Array.isArray(publishers)) {
        const allowed = new Set(publishers);
        rows = rows.filter(head => allowed.has(head.publisher));
      }
      if (q || task || format || quant) {
        const manifests = new Map();
        for (const head of rows) {
          if (!manifests.has(head.digest)) {
            const record = await this.getRecipeManifest(head.digest);
            manifests.set(head.digest, record?.manifest || null);
          }
        }
        rows = rows.filter(head =>
          recipeMatchesTokens(recipeSearchHaystack(head, manifests.get(head.digest)), { q, task, format, quant }));
      }
      rows.sort((a, b) => (String(b.publishedAt).localeCompare(String(a.publishedAt)) || String(a.id).localeCompare(String(b.id))));
      if (after) {
        rows = rows.filter(head =>
          String(head.publishedAt) < after.publishedAt ||
          (String(head.publishedAt) === after.publishedAt && String(head.id) > after.id));
      }
      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit && items.length ? encodeRecipeCursor(items[items.length - 1]) : null;
      return { items, nextCursor };
    },

    async listRecipeChanges({ limit = 50, cursor = null } = {}) {
      const start = cursor ? Number(cursor) : 0;
      let query = col(COLLECTIONS.recipeChanges).orderBy('seq', 'asc');
      if (Number.isFinite(start) && start > 0) query = query.where('seq', '>', start);
      const snapshot = await query.limit(limit + 1).get();
      const rows = snapshot.docs.map(hydrate);
      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit && items.length ? String(items[items.length - 1].seq) : null;
      return { items, nextCursor };
    },

    async getUpdateFeed() {
      return hydrate(await col(COLLECTIONS.updateFeed).doc('current').get());
    },

    async setUpdateFeed(feed) {
      // Stored verbatim; the envelope's signature covers every field except
      // {signature, feedPubKey}, so no server-side field may be added or
      // rewritten here (hydrate only normalizes recognized date fields, and
      // the envelope carries none).
      await col(COLLECTIONS.updateFeed).doc('current').set({ ...feed }, { merge: false });
      return this.getUpdateFeed();
    },

    // ── Community home plane (P3) ──────────────────────────────────────
    // Timestamps are stored as ISO strings (never Date objects) so hydrate
    // round-trips match the memory store byte-for-byte. All queries are
    // single-field reads + in-memory sort/filter: ZERO new composite indexes.
    // `announcements.body` / `releaseNotes.body` are exempted from indexing
    // via fieldOverrides (Firestore rejects indexed strings > 1500 bytes).

    async listAnnouncements({ limit = 20 } = {}) {
      const snapshot = await col(COLLECTIONS.announcements).orderBy('publishedAt', 'desc').limit(100).get();
      const rows = snapshot.docs.map(hydrate);
      rows.sort((a, b) =>
        (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))) ||
        String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
      return rows.slice(0, limit);
    },

    async getAnnouncement(id) {
      return hydrate(await col(COLLECTIONS.announcements).doc(id).get());
    },

    async putAnnouncement(record, { nowMs = now() } = {}) {
      const ref = col(COLLECTIONS.announcements).doc(record.id);
      const runTx = typeof firestore.runTransaction === 'function'
        ? (fn) => firestore.runTransaction(fn)
        : async (fn) => fn({
          get: (r) => r.get(),
          set: (r, data, opts) => r.set(data, opts),
        });
      return runTx(async (tx) => {
        const existing = hydrate(await tx.get(ref));
        if (record.pinned) {
          // Transactional pinned-cap read: equality on a boolean needs no
          // composite index; the count and the write commit atomically.
          const pinnedSnap = await tx.get(col(COLLECTIONS.announcements).where('pinned', '==', true));
          const pinned = pinnedSnap.docs.filter(doc => doc.id !== record.id).length;
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
        tx.set(ref, next, { merge: false });
        return { ok: true, announcement: next };
      });
    },

    async deleteAnnouncement(id) {
      const ref = col(COLLECTIONS.announcements).doc(id);
      const doc = await ref.get();
      if (!doc.exists) return false;
      await ref.delete();
      return true;
    },

    async listReleaseNotes({ limit = 5 } = {}) {
      const snapshot = await col(COLLECTIONS.releaseNotes).orderBy('released', 'desc').limit(100).get();
      return snapshot.docs.map(hydrate).slice(0, limit);
    },

    async getReleaseNote(version) {
      return hydrate(await col(COLLECTIONS.releaseNotes).doc(version).get());
    },

    async putReleaseNote(record, { nowMs = now() } = {}) {
      const ref = col(COLLECTIONS.releaseNotes).doc(record.version);
      const existing = hydrate(await ref.get());
      const next = {
        version: record.version,
        released: record.released,
        title: record.title,
        body: record.body,
        current: Boolean(record.current),
        updatedAt: new Date(nowMs).toISOString(),
        authorUid: existing?.authorUid || record.authorUid || '',
      };
      await ref.set(next, { merge: false });
      return { ok: true, releaseNote: next };
    },

    async deleteReleaseNote(version) {
      const ref = col(COLLECTIONS.releaseNotes).doc(version);
      const doc = await ref.get();
      if (!doc.exists) return false;
      await ref.delete();
      return true;
    },

    // Follow graph: doc id `${uid}:${pubKey}`. Private per-user writes; only
    // aggregate counts are public. The cap is enforced INSIDE the transaction
    // (review S4): two concurrent follows at 255 cannot both pass.
    async addFollow(uid, pubKey, { nowMs = now() } = {}) {
      const ref = col(COLLECTIONS.follows).doc(`${uid}:${pubKey}`);
      const runTx = typeof firestore.runTransaction === 'function'
        ? (fn) => firestore.runTransaction(fn)
        : async (fn) => fn({
          get: (r) => r.get(),
          set: (r, data, opts) => r.set(data, opts),
        });
      return runTx(async (tx) => {
        const existing = hydrate(await tx.get(ref));
        if (existing) return { ok: true, already: true, follow: existing };
        const snap = await tx.get(col(COLLECTIONS.follows).where('uid', '==', uid));
        if (snap.docs.length >= FOLLOW_CAP) return { ok: false, code: 'follow_cap' };
        const follow = { uid, pubKey, followedAt: new Date(nowMs).toISOString() };
        tx.set(ref, follow, { merge: false });
        return { ok: true, already: false, follow };
      });
    },

    async removeFollow(uid, pubKey) {
      const ref = col(COLLECTIONS.follows).doc(`${uid}:${pubKey}`);
      const doc = await ref.get();
      if (!doc.exists) return false;
      await ref.delete();
      return true;
    },

    async listFollowsForUser(uid) {
      // Equality-only query (single-field index); sort in memory — no
      // composite index, bounded by the 256 follow cap.
      const snapshot = await col(COLLECTIONS.follows).where('uid', '==', uid).get();
      const rows = snapshot.docs.map(hydrate);
      rows.sort((a, b) => String(b.followedAt || '').localeCompare(String(a.followedAt || '')));
      return rows;
    },

    async countFollowers(pubKey) {
      // Equality-only query; the plane is small at launch (documented v1
      // ceiling — same posture as listRecipeHeadsByDigest).
      const snapshot = await col(COLLECTIONS.follows).where('pubKey', '==', pubKey).get();
      return snapshot.docs.length;
    },

    async countRecipesByPublisher(pubKey) {
      // Same scan window as search/feed; filter !withdrawnAt in memory (an
      // equality-on-null query would miss legacy docs without the field).
      const snapshot = await col(COLLECTIONS.recipes).orderBy('publishedAt', 'desc').limit(RECIPE_SCAN_WINDOW).get();
      return snapshot.docs.map(hydrate).filter(head => !head.withdrawnAt && head.publisher === pubKey).length;
    },

    async deleteFollowsForUser(uid) {
      // Mandatory wiring when an account-deletion route ships (none exists
      // today — P3 review S7); also usable by operator cleanup.
      const snapshot = await col(COLLECTIONS.follows).where('uid', '==', uid).get();
      let removed = 0;
      for (const doc of snapshot.docs) {
        await doc.ref.delete();
        removed += 1;
      }
      return removed;
    },
  };
}