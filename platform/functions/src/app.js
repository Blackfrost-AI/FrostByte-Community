/**
 * Hub API application.
 *
 * `createApp` returns a Node request handler. It is constructed with its
 * dependencies injected so the whole surface can be exercised in tests without
 * the Admin SDK, without Firestore, and without network access.
 */

import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';

import { Router } from './router.js';
import {
  HubError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
  sendError,
  sendJson,
  readJsonBody,
} from './http.js';
import { resolveIdentity, requireIdentity, generateApiKey, API_KEY_PATTERN } from './auth.js';
import {
  capabilitiesFor,
  publicEntitlement,
  resolveEntitlement,
  isPaidTier,
} from './entitlements.js';
import { discover, applyFrostNetModeration } from './discovery.js';
import { PROVIDERS } from './providers/model.js';
import { consume } from './rate-limit.js';
import { applyCors, parseAllowedOrigins, sendPreflight } from './cors.js';
import { CLIENT_WRITABLE_USER_FIELDS, FOLLOW_CAP } from './store/contract.js';
import { validateHandle, validateBio, validatePubKey, validateDisplayName, validatePhotoUrl, publicCreatorProjection } from './identity.js';
import { registerAdminRoutes } from './admin.js';
import { registerRecipeRoutes } from './recipes.js';
import { createDesktopAuthRoutes } from './desktop-auth.js';

const MAX_BODY_BYTES = 64 * 1024;
const DISCOVERY_CACHE_TTL_MS = 60_000;
const HUB_VERSION = '0.1.0';

/**
 * @param {object} options
 * @param {object} options.store
 * @param {(token: string) => Promise<object|null>} [options.verifyIdToken]
 * @param {Function} [options.fetcher]     Injected outbound fetch (tests).
 * @param {() => number} [options.now]
 * @param {string|string[]} [options.allowedOrigins]  CORS allowlist.
 * @param {string} [options.tenantId]  FrostByte Identity Platform tenant.
 * @param {object} [options.adminDirectory]  Tenant-scoped Firebase Auth adapter.
 */
export function createApp({
  store,
  verifyIdToken,
  fetcher,
  now = () => Date.now(),
  allowedOrigins,
  tenantId = '',
  adminDirectory,
  mintDesktopCustomToken,
} = {}) {
  if (!store) throw new Error('createApp requires a store.');

  const router = new Router();
  const ctx = { store, verifyIdToken, fetcher, now };
  const corsAllowlist = parseAllowedOrigins(allowedOrigins);

  // Owner/operator console. The gate inside each route runs before any budget
  // is spent; the hermetic adminDirectory is injected by index.js in prod.
  registerAdminRoutes(router, { store, now, adminDirectory, tenantId });

  const desktopAuth = createDesktopAuthRoutes({
    store,
    mintDesktopCustomToken,
    expectedTenantId: tenantId,
    now,
  });
  router.post('/v1/auth/desktop/authorize', (args) => desktopAuth.authorize(args));
  router.post('/v1/auth/desktop/exchange', (args) => desktopAuth.exchange(args));
  router.post('/v1/auth/desktop/revoke', (args) => desktopAuth.revoke(args));

  const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

  /**
   * Discovery response cache key. Includes every upstream binding (query,
   * providers, limit, cursor, sort) plus the plan tier — a Free response must
   * never be served to a Pro caller or vice versa. The moderation fingerprint
   * rotates the key whenever operator blocks/featured/provider settings change.
   */
  function discoveryCacheKey({ query, providers, limit, tier, cursor, sort, moderation }) {
    return sha256Hex(JSON.stringify({ query, providers, limit, tier, cursor, sort, moderation })).slice(0, 40);
  }

  /**
   * Provision a free profile on first authenticated access. A freshly created
   * Firebase account has no Firestore user document yet; without this, /v1/me
   * would 404 and the account could never sign in to the Hub. Provisioning only
   * ever grants tier 'free' — paid tiers come exclusively from the billing
   * webhook. API-key identities never provision (they belong to an existing
   * user). Returns the existing or newly created record.
   */
  async function ensureProfile(caller) {
    const existing = await store.getUser(caller.uid);
    if (existing) return existing;
    // Only Firebase user identities provision; API keys belong to an existing
    // user and must never create a profile.
    if (caller.authType !== 'firebase') return null;
    const stamp = new Date(now()).toISOString();
    const email = typeof caller.email === 'string' ? caller.email : '';
    const record = {
      uid: caller.uid,
      email,
      emailLower: email.toLowerCase(),
      tenantId: caller.tenantId || tenantId || '',
      displayName: '',
      photoUrl: '',
      tier: 'free',
      subscription: null,
      stripeCustomerId: '',
      roles: [],
      disabled: false,
      createdAt: stamp,
      updatedAt: stamp,
      lastSeenAt: stamp,
    };
    // Atomic create-if-absent closes the get-then-set race under concurrency.
    const result = await store.createUserIfAbsent(caller.uid, record);
    return result.user;
  }

  // Recipe share plane (P2). Registered after ensureProfile so publish/withdraw
  // can enforce the same session-profile gate as the P1 identity routes
  // (API keys → 403 profile_required). The plane owns its admin routes too.
  registerRecipeRoutes(router, { store, now, ensureProfile });

  /** Backfill emailLower/tenantId/createdAt on legacy profile docs (firebase only). */
  async function backfillProfile(caller, user) {
    if (!user || caller.authType !== 'firebase') return user;
    const patch = {};
    if (typeof user.emailLower !== 'string' || user.emailLower === '') {
      patch.emailLower = String(user.email || caller.email || '').toLowerCase();
    }
    if (!user.tenantId && (caller.tenantId || tenantId)) {
      patch.tenantId = caller.tenantId || tenantId;
    }
    if (!user.createdAt) {
      patch.createdAt = new Date(now()).toISOString();
    }
    if (Object.keys(patch).length === 0) return user;
    return (await store.updateUser(caller.uid, patch)) || user;
  }

  router.get('/v1/health', async () => ({
    status: 'ok',
    service: 'blackfrost-hub-api',
    version: HUB_VERSION,
    store: store.kind || 'unknown',
    time: new Date(now()).toISOString(),
  }));

  router.get('/v1/discovery/models', async ({ req, identity }) => {
    const caller = requireIdentity(identity);
    await consume({ store, uid: caller.uid, tier: caller.tier, bucket: 'discovery', now });

    const url = new URL(req.url || '/', 'https://hub.invalid');
    const params = url.searchParams;
    const query = params.get('q') || '';
    const providersParam = params.get('providers') || undefined;
    const limit = params.get('limit') || undefined;
    const cursor = params.get('cursor') || '';
    const sort = params.get('sort') || 'downloads';

    // Operator settings drive the cache fingerprint so a block/feature/provider
    // change never serves a stale cached page.
    const [config, blockedRules, featuredEntries] = await Promise.all([
      store.getFrostNetConfig(),
      store.listModerationRules(),
      store.listFeaturedModels(),
    ]);
    const moderationFingerprint = sha256Hex(JSON.stringify({
      p: Array.isArray(config?.enabledProviders) ? config.enabledProviders : [...PROVIDERS],
      b: blockedRules.map((rule) => rule.id).sort(),
      f: featuredEntries.map((entry) => entry.id).sort(),
    })).slice(0, 16);

    const cacheKey = discoveryCacheKey({
      query,
      providers: providersParam || '',
      limit: limit || '',
      tier: caller.tier,
      cursor,
      sort,
      moderation: moderationFingerprint,
    });

    const cached = await store.getCache(cacheKey);
    if (cached) {
      // POST-CACHE enforcement: a rule added after a page was cached still
      // applies. Re-applying moderation is idempotent and self-correcting.
      const items = applyFrostNetModeration(cached.items, {
        blockedRules,
        featuredEntries,
        sort,
        enabledProviders: Array.isArray(config?.enabledProviders) ? config.enabledProviders : null,
      });
      return { ...cached, items, cached: true };
    }

    const result = await discover({
      query,
      tier: caller.tier,
      providers: providersParam,
      limit,
      cursor,
      sort,
      fetcher,
      now,
      store,
    });

    // Cache the moderated result (never an error page). Provider failures stay
    // visible in the response but are not frozen for the TTL.
    if (result && Array.isArray(result.items)) {
      await store.setCache(cacheKey, result, DISCOVERY_CACHE_TTL_MS);
    }

    return result;
  });

  router.get('/v1/me', async ({ identity }) => {
    const caller = requireIdentity(identity);
    const user = await backfillProfile(caller, caller.user || (await ensureProfile(caller)));
    if (!user) throw notFound('No profile for this account yet.');

    const subscription = await store.getSubscription(caller.uid);
    const hasBillingAccount = Boolean(
      (typeof user.stripeCustomerId === 'string' && user.stripeCustomerId.startsWith('cus_'))
      || (typeof subscription?.providerCustomerId === 'string' && subscription.providerCustomerId.startsWith('cus_'))
      || (typeof subscription?.stripeCustomerId === 'string' && subscription.stripeCustomerId.startsWith('cus_')),
    );

    // Flat shape — desktop, web, and api.test.js all consume this directly.
    return {
      uid: caller.uid,
      email: user.email || caller.email || '',
      emailVerified: caller.emailVerified === true,
      isAdmin: caller.isAdmin === true,
      hasBillingAccount,
      tenantId: caller.tenantId || '',
      displayName: user.displayName || '',
      photoUrl: user.photoUrl || '',
      // ADR 003: own-profile view includes the alias + bio + bound publisher keys.
      handle: user.handle || '',
      bio: user.bio || '',
      publisherKeys: Object.entries(user.publisherKeys || {}).map(([pubKey, binding]) => ({
        pubKey,
        boundAt: binding?.boundAt || null,
        unboundAt: binding?.unboundAt || null,
      })),
      locale: user.locale || '',
      timezone: user.timezone || '',
      preferences: user.preferences || {},
      createdAt: user.createdAt || null,
      entitlement: publicEntitlement(caller.entitlement),
      orgs: (await store.listOrgsForUser(caller.uid)).map((org) => ({
        id: org.id,
        name: org.name,
        role: (org.roles && org.roles[caller.uid]) || 'member',
      })),
    };
  });

  router.patch('/v1/me', async ({ req, identity }) => {
    const caller = requireIdentity(identity);
    await consume({ store, uid: caller.uid, tier: caller.tier, bucket: 'writes', now });

    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const patch = {};

    for (const [key, value] of Object.entries(body)) {
      if (!CLIENT_WRITABLE_USER_FIELDS.includes(key)) {
        // ADR 003: handle is a reserved alias — dedicated transactional route.
        if (key === 'handle') throw badRequest('Use POST /v1/me/handle to set a handle.', 'handle_route_required');
        throw badRequest(`Field "${key}" is not client-writable.`);
      }
      if (key === 'bio') {
        const bioCheck = validateBio(value);
        if (!bioCheck.ok) throw badRequest(bioCheck.message, bioCheck.code);
        patch.bio = bioCheck.bio;
        continue;
      }
      if (key === 'displayName') {
        const nameCheck = validateDisplayName(value);
        if (!nameCheck.ok) throw badRequest(nameCheck.message, nameCheck.code);
        patch.displayName = nameCheck.displayName;
        continue;
      }
      if (key === 'photoUrl') {
        const photoCheck = validatePhotoUrl(value);
        if (!photoCheck.ok) throw badRequest(photoCheck.message, photoCheck.code);
        patch.photoUrl = photoCheck.photoUrl;
        continue;
      }
      if (key === 'preferences') {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw badRequest('preferences must be an object.');
        }
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 8 * 1024) {
          throw badRequest('preferences is too large.');
        }
        patch.preferences = value;
        continue;
      }
      if (typeof value !== 'string' || value.length > 200) {
        throw badRequest(`Field "${key}" must be a string under 200 characters.`);
      }
      patch[key] = value;
    }

    if (Object.keys(patch).length === 0) throw badRequest('No writable fields supplied.');

    await backfillProfile(caller, await ensureProfile(caller));
    const updated = await store.updateUser(caller.uid, patch);
    if (!updated) throw notFound('No profile for this account yet.');

    await store.appendAudit({
      action: 'user.update',
      uid: caller.uid,
      fields: Object.keys(patch),
      actor: caller.authType,
    });

    return { ok: true, updated: Object.keys(patch) };
  });

  // ---- Identity plane (ADR 003): handles + publisher-key binding ------------

  const HANDLE_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, ADR 003 §5
  const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes, ADR 003 §3

  router.post('/v1/me/handle', async ({ req, identity }) => {
    const caller = requireIdentity(identity);
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const check = validateHandle(body?.handle);
    if (!check.ok) throw badRequest(check.message, check.code);
    const profile = await ensureProfile(caller);
    if (!profile) throw forbidden('API keys cannot set handles; sign in with your account.', 'profile_required');
    const result = await store.setHandle(caller.uid, check.handle, { nowMs: now(), graceMs: HANDLE_GRACE_MS });
    if (!result.ok) {
      if (result.code === 'handle_taken') throw conflict('That handle is already taken.', 'handle_taken');
      if (result.code === 'handle_grace') throw conflict('That handle was recently released. Try again later.', 'handle_grace');
      throw notFound('No profile for this account yet.');
    }
    await store.appendAudit({ action: 'user.handle.set', uid: caller.uid, handle: check.handleLower, actor: caller.authType });
    return { ok: true, handle: result.user.handle, handleLower: result.user.handleLower };
  });

  router.delete('/v1/me/handle', async ({ identity }) => {
    const caller = requireIdentity(identity);
    const result = await store.setHandle(caller.uid, '', { nowMs: now(), graceMs: HANDLE_GRACE_MS });
    if (!result.ok) throw notFound('No profile for this account yet.');
    await store.appendAudit({ action: 'user.handle.release', uid: caller.uid, actor: caller.authType });
    return { ok: true, released: true };
  });

  router.get('/v1/me/publisher-keys', async ({ identity }) => {
    const caller = requireIdentity(identity);
    const keys = await store.listPublisherKeysForUser(caller.uid);
    return { ok: true, keys: keys.map(k => ({ pubKey: k.pubKey, boundAt: k.boundAt, unboundAt: k.unboundAt || null })) };
  });

  router.post('/v1/me/publisher-key/challenge', async ({ req, identity }) => {
    const caller = requireIdentity(identity);
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const check = validatePubKey(body?.pubKey);
    if (!check.ok) throw badRequest(check.message, check.code);
    const profile = await ensureProfile(caller);
    if (!profile) throw forbidden('API keys cannot bind publisher keys; sign in with your account.', 'profile_required');
    const existing = await store.getPublisherKey(check.pubKey);
    if (existing && existing.uid !== caller.uid && !existing.unboundAt) {
      throw conflict('That publisher key is bound to another account.', 'key_bound_elsewhere');
    }
    const challengeId = randomBytes(16).toString('hex');
    const nonce = randomBytes(32).toString('hex');
    const createdAt = now();
    await store.createPublisherChallenge({
      challengeId,
      uid: caller.uid,
      pubKey: check.pubKey,
      nonce,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + CHALLENGE_TTL_MS).toISOString(),
      usedAt: null,
    });
    return { ok: true, challengeId, nonce, expiresAt: new Date(createdAt + CHALLENGE_TTL_MS).toISOString() };
  });

  router.post('/v1/me/publisher-key', async ({ req, identity }) => {
    const caller = requireIdentity(identity);
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const keyCheck = validatePubKey(body?.pubKey);
    if (!keyCheck.ok) throw badRequest(keyCheck.message, keyCheck.code);
    const challengeId = typeof body?.challengeId === 'string' ? body.challengeId : '';
    const signature = typeof body?.signature === 'string' ? body.signature : '';
    if (!/^[a-f0-9]{128}$/.test(signature)) {
      throw badRequest('Signature must be 128 lowercase hex characters (Ed25519).', 'signature_invalid');
    }
    // Single-use burn BEFORE verification: a failed attempt still consumes the
    // challenge, so nonces cannot be replayed or brute-forced.
    const challenge = await store.consumePublisherChallenge(challengeId, { nowMs: now() });
    if (!challenge || challenge.uid !== caller.uid || challenge.pubKey !== keyCheck.pubKey) {
      throw badRequest('Challenge is missing, expired, already used, or for a different key.', 'challenge_invalid');
    }
    let verified = false;
    try {
      // Same SPKI reconstruction as the desktop signer (publisher.js): the raw
      // hex64 key is wrapped in the fixed Ed25519 SPKI prefix.
      const publicKey = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(keyCheck.pubKey, 'hex')]),
        format: 'der',
        type: 'spki',
      });
      verified = cryptoVerify(null, Buffer.from(challenge.nonce, 'utf8'), publicKey, Buffer.from(signature, 'hex'));
    } catch {
      verified = false;
    }
    if (!verified) throw badRequest('Signature does not verify against that publisher key.', 'signature_invalid');
    const result = await store.setPublisherKey(keyCheck.pubKey, caller.uid, { nowMs: now(), challengeId });
    if (!result.ok) {
      if (result.code === 'key_bound_elsewhere') throw conflict('That publisher key is bound to another account.', 'key_bound_elsewhere');
      throw notFound('No profile for this account yet.');
    }
    await store.appendAudit({ action: 'user.publisher.bind', uid: caller.uid, pubKey: keyCheck.pubKey, actor: caller.authType });
    return { ok: true, pubKey: keyCheck.pubKey, boundAt: result.binding.boundAt };
  });

  router.delete('/v1/me/publisher-key/:pubKey', async ({ params, identity }) => {
    const caller = requireIdentity(identity);
    const check = validatePubKey(params.pubKey);
    if (!check.ok) throw badRequest(check.message, check.code);
    const result = await store.deletePublisherKey(check.pubKey, caller.uid, { nowMs: now() });
    if (!result.ok) throw forbidden('That publisher key is not bound to your account.', 'not_owner');
    await store.appendAudit({ action: 'user.publisher.unbind', uid: caller.uid, pubKey: check.pubKey, actor: caller.authType });
    return { ok: true, unbound: true };
  });

  // ---- Public creator projection (ADR 003): pubkey-canonical ----------------

  async function creatorProjection(pubKey) {
    const binding = await store.getPublisherKey(pubKey);
    const user = binding ? await store.getUser(binding.uid) : null;
    // P3: real public counts. Recipes = live heads in the shared scan window
    // (moderation-blocked-but-not-withdrawn heads still count — documented
    // divergence from visible search results); followers = follow-graph size.
    const [followers, recipes] = binding
      ? await Promise.all([store.countFollowers(pubKey), store.countRecipesByPublisher(pubKey)])
      : [0, 0];
    return { projection: publicCreatorProjection({ pubKey, user, binding, stats: { followers, recipes } }), user };
  }

  router.get('/v1/creators/:pubKey', async ({ params }) => {
    const check = validatePubKey(params.pubKey);
    if (!check.ok) throw badRequest(check.message, check.code);
    const { projection, user } = await creatorProjection(check.pubKey);
    // A binding without a live user (deleted account) must not project a
    // ghost creator — the key alone is not a followable identity (P3 S7).
    // An unbound-but-live creator keeps its alias projection (P1 contract).
    if (!user) throw notFound('No creator for that publisher key.', 'creator_not_found');
    return projection;
  });

  router.get('/v1/creators/by-handle/:handle', async ({ params }) => {
    const check = validateHandle(params.handle);
    if (!check.ok) throw badRequest(check.message, check.code);
    const reservation = await store.getHandle(check.handleLower);
    if (!reservation) {
      const grace = await store.getHandleHistory(check.handleLower);
      if (grace && Date.parse(grace.releasedUntil) > now()) {
        throw notFound(`@${check.handle} was recently released.`, 'handle_grace');
      }
      throw notFound('No creator with that handle.', 'creator_not_found');
    }
    const user = await store.getUser(reservation.uid);
    const keys = await store.listPublisherKeysForUser(reservation.uid);
    const active = keys.find(k => !k.unboundAt);
    if (!active) throw notFound('That creator has no bound publisher key yet.', 'creator_not_found');
    const [followers, recipes] = await Promise.all([
      store.countFollowers(active.pubKey),
      store.countRecipesByPublisher(active.pubKey),
    ]);
    return publicCreatorProjection({ pubKey: active.pubKey, user, binding: active, stats: { followers, recipes } });
  });

  // ---- P3 follow graph: pubkey-keyed, session-only, private ---------------
  // Follows attach to the publisher KEY (ADR 003): when a key rebinds to a
  // new account after release, followers and counts transfer with the key.
  // Documented in docs/hub-api.md §Follows — intended, not a privacy bug.
  // The graph is private: only aggregate counts are ever public.

  async function requireFollowSession(identity) {
    if (!identity?.uid) throw unauthorized('Sign in to follow creators.');
    if (identity.authType !== 'firebase') {
      throw forbidden('API keys cannot manage follows; sign in with your account.', 'profile_required');
    }
    return identity;
  }

  async function resolveFollowTarget(rawKey) {
    const check = validatePubKey(rawKey);
    if (!check.ok) throw badRequest(check.message, check.code);
    const binding = await store.getPublisherKey(check.pubKey);
    if (!binding) throw notFound('No creator with that publisher key.', 'creator_not_found');
    const user = await store.getUser(binding.uid);
    if (!user) throw notFound('No creator with that publisher key.', 'creator_not_found');
    return check.pubKey;
  }

  router.post('/v1/follows/:pubKey', async ({ params, identity }) => {
    const caller = await requireFollowSession(identity);
    await consume({ store, uid: caller.uid, tier: caller.tier, bucket: 'writes', now });
    const pubKey = await resolveFollowTarget(params.pubKey);
    const result = await store.addFollow(caller.uid, pubKey, { nowMs: now() });
    if (!result.ok) {
      if (result.code === 'follow_cap') throw conflict(`You can follow at most ${FOLLOW_CAP} creators.`, 'follow_cap');
      throw conflict('Follow write conflict.', result.code);
    }
    return { ok: true, already: Boolean(result.already), pubkey: pubKey };
  });

  router.delete('/v1/follows/:pubKey', async ({ params, identity }) => {
    const caller = await requireFollowSession(identity);
    await consume({ store, uid: caller.uid, tier: caller.tier, bucket: 'writes', now });
    const check = validatePubKey(params.pubKey);
    if (!check.ok) throw badRequest(check.message, check.code);
    // Idempotent: removing a non-existent follow is success (no target
    // resolution — unfollowing a deleted creator must always work).
    const removed = await store.removeFollow(caller.uid, check.pubKey);
    return { ok: true, removed, pubkey: check.pubKey };
  });

  router.get('/v1/me/follows', async ({ identity }) => {
    const caller = await requireFollowSession(identity);
    await consume({ store, uid: caller.uid, tier: caller.tier, bucket: 'discovery', now });
    const follows = await store.listFollowsForUser(caller.uid);
    return {
      follows: follows.map(follow => ({ pubkey: follow.pubKey, followedAt: follow.followedAt })),
      limit: FOLLOW_CAP,
    };
  });

  router.get('/v1/me/entitlement', async ({ identity }) => {
    const caller = requireIdentity(identity);
    return publicEntitlement(caller.entitlement);
  });

  router.get('/v1/me/usage', async ({ identity }) => {
    const caller = requireIdentity(identity);
    const day = new Date(now()).toISOString().slice(0, 10);
    const usage = (await store.getUsage(caller.uid, day)) || {};
    const capabilities = capabilitiesFor(caller.tier);
    return {
      day,
      tier: caller.tier,
      discovery: Number(usage.discovery) || 0,
      writes: Number(usage.writes) || 0,
      maxResultsPerPage: capabilities.maxResultsPerPage,
    };
  });

  router.get('/v1/api-keys', async ({ identity }) => {
    const caller = requireIdentity(identity);
    const keys = await store.listApiKeysForUser(caller.uid);
    return {
      limit: capabilitiesFor(caller.tier).apiKeys,
      keys: keys.map((key) => ({
        prefix: key.prefix,
        label: key.label || '',
        createdAt: key.createdAt || null,
        lastUsedAt: key.lastUsedAt || null,
        revokedAt: key.revokedAt || null,
        expiresAt: key.expiresAt || null,
      })),
    };
  });

  router.post('/v1/api-keys', async ({ req, identity }) => {
    const caller = requireIdentity(identity);
    await consume({ store, uid: caller.uid, tier: caller.tier, bucket: 'writes', now });

    const limit = capabilitiesFor(caller.tier).apiKeys;
    if (limit === 0) throw forbidden('API keys require a Plus or Pro plan.');

    const existing = await store.countApiKeysForUser(caller.uid);
    if (existing >= limit) throw conflict(`Your plan allows ${limit} API keys. Revoke one first.`);

    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const label = typeof body.label === 'string' ? body.label.slice(0, 100) : '';

    const generated = generateApiKey({ now });
    await store.setApiKey(generated.keyHash, {
      uid: caller.uid,
      prefix: generated.prefix,
      label,
      createdAt: generated.createdAt,
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
    });

    await store.appendAudit({ action: 'apiKey.create', uid: caller.uid, prefix: generated.prefix });

    // The plaintext is returned exactly once. It is not recoverable afterwards.
    return { ok: true, key: generated.plaintext, prefix: generated.prefix, label };
  });

  router.delete('/v1/api-keys/:prefix', async ({ params, identity }) => {
    const caller = requireIdentity(identity);
    if (!/^[a-z0-9]{8}$/.test(params.prefix)) throw badRequest('Malformed key prefix.');

    const keys = await store.listApiKeysForUser(caller.uid);
    const match = keys.find((key) => key.prefix === params.prefix);
    if (!match) throw notFound('No such API key.');

    await store.setApiKey(match.keyHash, {
      ...match,
      revokedAt: new Date(now()).toISOString(),
    });
    await store.appendAudit({ action: 'apiKey.revoke', uid: caller.uid, prefix: params.prefix });

    return { ok: true, revoked: params.prefix };
  });

  router.get('/v1/orgs', async ({ identity }) => {
    const caller = requireIdentity(identity);
    const orgs = await store.listOrgsForUser(caller.uid);
    return {
      orgs: orgs.map((org) => ({
        id: org.id,
        name: org.name,
        plan: org.plan || 'free',
        role: (org.roles && org.roles[caller.uid]) || 'member',
        memberCount: Array.isArray(org.memberUids) ? org.memberUids.length : 0,
      })),
    };
  });

  router.post('/v1/orgs', async ({ req, identity }) => {
    const caller = requireIdentity(identity);
    if (!capabilitiesFor(caller.tier).orgs) throw forbidden('Organizations require a Pro plan.');

    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 2 || name.length > 80) throw badRequest('Organization name must be 2–80 characters.');

    const orgId = `org_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const org = await store.setOrg(orgId, {
      name,
      plan: caller.tier,
      ownerUid: caller.uid,
      memberUids: [caller.uid],
      roles: { [caller.uid]: 'owner' },
      createdAt: new Date(now()).toISOString(),
    });

    await store.appendAudit({ action: 'org.create', uid: caller.uid, orgId });

    return { ok: true, org: { id: org.id, name: org.name, plan: org.plan } };
  });

  // ---- User dashboard: hardware profiles & saved models --------------------

  const ACCELERATOR_TYPES = ['apple-unified', 'nvidia-vram', 'amd-vram', 'cpu-ram'];

  function requireFirebaseSession(caller) {
    if (caller.authType !== 'firebase') {
      throw forbidden('This action requires an interactive sign-in.', 'interactive_session_required');
    }
  }

  router.get('/v1/me/hardware-profiles', async ({ identity }) => {
    const caller = requireIdentity(identity);
    return { items: await store.listHardwareProfiles(caller.uid) };
  });

  router.post('/v1/me/hardware-profiles', async ({ req, identity }) => {
    const caller = requireIdentity(identity);
    requireFirebaseSession(caller);
    await consume({ store, uid: caller.uid, tier: caller.tier, bucket: 'writes', now });

    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (label.length < 1 || label.length > 80) throw badRequest('label must be 1–80 characters.');
    if (!ACCELERATOR_TYPES.includes(body.acceleratorType)) {
      throw badRequest(`acceleratorType must be one of: ${ACCELERATOR_TYPES.join(', ')}.`);
    }
    const memoryGiB = Number(body.memoryGiB);
    if (!Number.isFinite(memoryGiB) || memoryGiB < 1 || memoryGiB > 2048) {
      throw badRequest('memoryGiB must be a number between 1 and 2048.');
    }
    let bandwidthGBs = null;
    if (body.bandwidthGBs !== null && body.bandwidthGBs !== undefined && body.bandwidthGBs !== '') {
      bandwidthGBs = Number(body.bandwidthGBs);
      if (!Number.isFinite(bandwidthGBs) || bandwidthGBs < 1 || bandwidthGBs > 100000) {
        throw badRequest('bandwidthGBs must be a number between 1 and 100000, or null.');
      }
    }

    const existing = await store.listHardwareProfiles(caller.uid);
    const id = typeof body.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.id)
      ? body.id
      : `hw_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    if (!existing.some((profile) => profile.id === id) && existing.length >= 20) {
      throw conflict('Hardware profile limit reached (20).', 'hardware_profile_limit_reached');
    }

    const profile = await store.upsertHardwareProfile(caller.uid, {
      id,
      label,
      acceleratorType: body.acceleratorType,
      memoryGiB,
      bandwidthGBs,
      isDefault: body.isDefault === true,
    });
    return { ok: true, profile };
  });

  router.delete('/v1/me/hardware-profiles/:id', async ({ params, identity }) => {
    const caller = requireIdentity(identity);
    requireFirebaseSession(caller);
    const removed = await store.deleteHardwareProfile(caller.uid, params.id);
    if (!removed) throw notFound('No such hardware profile.');
    return { ok: true };
  });

  router.get('/v1/me/saved-models', async ({ identity }) => {
    const caller = requireIdentity(identity);
    return { items: await store.listSavedModels(caller.uid) };
  });

  router.post('/v1/me/saved-models', async ({ req, identity }) => {
    const caller = requireIdentity(identity);
    requireFirebaseSession(caller);
    await consume({ store, uid: caller.uid, tier: caller.tier, bucket: 'writes', now });

    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!PROVIDERS.includes(body.provider)) throw badRequest(`provider must be one of: ${PROVIDERS.join(', ')}.`);
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    if (providerId.length < 1 || providerId.length > 200) throw badRequest('providerId must be 1–200 characters.');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 200) throw badRequest('name must be 1–200 characters.');
    const quant = typeof body.quant === 'string' ? body.quant.trim().slice(0, 40) : '';
    let sizeBytes = null;
    if (body.sizeBytes !== null && body.sizeBytes !== undefined && body.sizeBytes !== '') {
      sizeBytes = Number(body.sizeBytes);
      if (!Number.isFinite(sizeBytes) || sizeBytes < 0) throw badRequest('sizeBytes must be a non-negative number or null.');
    }
    const parameterLabel = typeof body.parameterLabel === 'string' ? body.parameterLabel.trim().slice(0, 40) : '';

    // Deterministic key: re-saving the same model+quant is idempotent.
    const modelKey = sha256Hex(`${body.provider}:${providerId}:${quant}`).slice(0, 32);
    const existing = await store.listSavedModels(caller.uid);
    if (!existing.some((item) => item.modelKey === modelKey) && existing.length >= 200) {
      throw conflict('Saved model limit reached (200).', 'saved_model_limit_reached');
    }

    const item = await store.upsertSavedModel(caller.uid, {
      modelKey,
      provider: body.provider,
      providerId,
      name,
      quant,
      sizeBytes,
      parameterLabel,
    });
    return { ok: true, item };
  });

  router.delete('/v1/me/saved-models/:modelKey', async ({ params, identity }) => {
    const caller = requireIdentity(identity);
    requireFirebaseSession(caller);
    if (!/^[a-f0-9]{32}$/.test(params.modelKey)) throw badRequest('Malformed model key.');
    const removed = await store.deleteSavedModel(caller.uid, params.modelKey);
    if (!removed) throw notFound('No such saved model.');
    return { ok: true };
  });

  /**
   * Stripe webhook.
   *
   * Inert until `STRIPE_HUB_WEBHOOK_SECRET` is configured: without it every
   * request is rejected 503 rather than accepted unsigned. The signature check
   * itself lives in billing.js and is exercised by the test suite.
   */
  router.post('/v1/billing/webhook', async ({ req }) => {
    const { handleStripeWebhook } = await import('./billing.js');
    return handleStripeWebhook({ req, store, now });
  });

  /**
   * Start a subscription checkout.
   *
   * Takes a plan name, not a price ID — the price is resolved server-side so a
   * client cannot pick its own amount.
   */
  router.post('/v1/billing/checkout', async ({ req, identity }) => {
    const caller = requireIdentity(identity);
    const body = await readJsonBody(req, 8 * 1024);
    const { createCheckoutSession } = await import('./billing-checkout.js');
    return createCheckoutSession({
      store,
      identity: caller,
      plan: String(body?.plan || ''),
      interval: String(body?.interval || 'monthly'),
      fetcher,
      now,
    });
  });

  /** Open the Stripe billing portal for self-serve plan management. */
  router.post('/v1/billing/portal', async ({ identity }) => {
    const caller = requireIdentity(identity);
    const { createPortalSession } = await import('./billing-checkout.js');
    return createPortalSession({ store, identity: caller, fetcher, now });
  });

  return async function handler(req, res) {
    try {
      // CORS runs before routing so every response — including 404s and errors
      // — carries the headers a browser needs to read it. A preflight is
      // answered here and never reaches a route: OPTIONS carries no body and
      // no credentials, and routing it would require every route to declare it.
      const cors = applyCors(req, res, corsAllowlist);
      if (cors.preflight) {
        sendPreflight(res);
        return;
      }

      const url = new URL(req.url || '/', 'https://hub.invalid');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      const matched = router.match(req.method || 'GET', pathname);

      if (!matched) throw notFound(`No route for ${req.method} ${pathname}.`);
      if (matched.allow) {
        res.setHeader('Allow', matched.allow.join(', '));
        throw new HubError(405, 'method_not_allowed', `Use ${matched.allow.join(' or ')}.`);
      }

      // Resolve identity once per request. `null` is a valid anonymous state;
      // routes that need a caller call requireIdentity themselves.
      //
      // Only credential *verification* failures become 401 (auth.js raises
      // HubError for those). A store outage during resolution must surface as a
      // 500 — reporting "you are logged out" during a Firestore incident would
      // send every client into a re-auth loop.
      const identity = await resolveIdentity({ req, store, verifyIdToken, tenantId, now });

      const result = await matched.handler({ req, res, params: matched.params, identity, url });
      if (res.writableEnded) return;
      sendJson(res, 200, result);
    } catch (error) {
      if (res.writableEnded) return;
      if (!(error instanceof HubError)) {
        // Log server-side with a correlation id; never return internals.
        const correlationId = globalThis.crypto.randomUUID();
        console.error(JSON.stringify({
          severity: 'ERROR',
          message: 'unhandled_hub_error',
          correlationId,
          name: error?.name,
          detail: error?.message,
          stack: error?.stack?.split('\n').slice(0, 6).join('\n'),
        }));
        res.setHeader('X-Correlation-Id', correlationId);
      }
      sendError(res, error);
    }
  };
}

export { API_KEY_PATTERN, isPaidTier, resolveEntitlement, HUB_VERSION };