/**
 * Recipe share plane routes (P2) — the deployed authority for publish,
 * search, withdraw, tombstones, the change log, and the operator update feed.
 *
 * Security order is BINDING (p2-review-decisions.md §3):
 *   terms → validate → explicit createdAt → digest recompute → signature
 *   verify → live-binding check (uid match AND not unbound) → store
 *   (tombstone 409 → cross-uid collision 409 → same-digest idempotency →
 *   new-revision write, all inside one transaction / synchronous block).
 *
 * Ownership is pinned at publish (`ownerUid` on the head). Withdraw NEVER
 * consults the live key binding — keys are re-bindable across accounts after
 * a soft unbind, so a live-binding check would hand withdraw power to whoever
 * holds the key next. The only bypass is the audited operator takedown route.
 *
 * Tombstone semantics are a NEW contract (the hub fixture has none):
 *   - GET id-addressed head of a withdrawn recipe → 410 `withdrawn`, and it
 *     must never 304 against the old published ETag.
 *   - GET digest-addressed manifests stay immutable 200 so importers can
 *     verify content they already downloaded.
 *   - Search excludes tombstones; the change log carries `recipe.withdrawn`.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

import { requireIdentity } from './auth.js';
import { requireAdmin, requireAuditReason } from './admin-auth.js';
import { isPaidTier } from './entitlements.js';
import { consume } from './rate-limit.js';
import { COLLECTIONS, decodeRecipeCursor, feedCreatorProjection, FOLLOW_CAP, PINNED_ANNOUNCEMENT_CAP } from './store/contract.js';
import {
  HubError, badRequest, unauthorized, forbidden, notFound, conflict, unavailable,
  readJsonBody, sendJson,
} from './http.js';
import {
  validateRecipe, canonicalDigest, canonicalJson, verifyRecipeSignature, RECIPE_ID_RE,
} from './recipe-manifest.js';

// Terms anchor. The desktop signs against FROSTNET_TERMS from
// src/shared/release-manifest.js; the deployed bundle cannot import it, so the
// value is duplicated here and pinned by the root drift-guard test
// (tests/recipe-plane-vendoring.test.js). Rotating terms = rotate BOTH.
export const FROSTNET_TERMS = '2026-10-10-v1';

// Signed manifests legitimately reach ~750k canonical chars; the global 64 KiB
// body cap would 413 them. Publish gets the documented 1 MiB manifest cap.
export const MAX_RECIPE_BODY_BYTES = 1024 * 1024;
// The validator bounds canonical JSON by CHARACTERS; Firestore documents and
// the desktop's 2 MiB response cap bound BYTES. Enforce both.
export const MAX_RECIPE_CANONICAL_BYTES = 1024 * 1024;

const SPKI_ED25519_PREFIX = '302a300506032b6570032100';
const SHA256_RE = /^[a-f0-9]{64}$/;
const BUNDLE_DOMAIN = 'frostbyte-bundle/1';
const FEED_SEVERITIES = new Set(['info', 'recommended', 'security']);

const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

// ETag wire format — must stay byte-identical to etagForDigest in
// src/shared/hub-protocol.js (pinned by the root drift-guard test).
export const etagForDigest = (digest) => `"sha256:${digest}"`;

function etagMatches(header, etag) {
  if (typeof header !== 'string' || !header) return false;
  return header.split(',').some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === '*' || trimmed === etag || trimmed === `W/${etag}`;
  });
}

// Same rightmost-XFF-hop logic as desktop-auth.js clientIpKey: a spoofed
// leading X-Forwarded-For entry must not evade the per-IP anonymous ceiling.
function anonIpKey(req) {
  const appEngineIp = typeof req?.headers?.['x-appengine-user-ip'] === 'string'
    ? req.headers['x-appengine-user-ip'].trim()
    : '';
  const xffParts = typeof req?.headers?.['x-forwarded-for'] === 'string'
    ? req.headers['x-forwarded-for'].split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const rawIp = appEngineIp || xffParts[xffParts.length - 1] || req?.socket?.remoteAddress || 'unknown';
  return `ip:${sha256Hex(rawIp).slice(0, 24)}`;
}

function clampInt(value, fallback, min, max) {
  // A missing param (null from searchParams.get) must use the fallback —
  // Number(null) is 0, which would silently clamp every default to `min`.
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), min), max);
}

function boundedText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * Operator moderation for the recipe plane. Reuses the existing
 * frostnetModeration rules: `repo` targets match the manifest's
 * modelRef.repoId (and org/* prefixes match the repo owner); `infohash`
 * targets match the manifest's torrent.infohash_v1. Recipe-id and publisher
 * takedowns go through the audited admin withdraw route instead.
 */
export function recipeIsBlocked(head, manifest, rules) {
  const repoId = String(manifest?.modelRef?.repoId || '').toLowerCase();
  const infohash = String(manifest?.torrent?.infohash_v1 || '').toLowerCase();
  for (const rule of Array.isArray(rules) ? rules : []) {
    const value = typeof rule?.targetValue === 'string' ? rule.targetValue.toLowerCase() : '';
    if (!value) continue;
    if (rule.targetType === 'infohash') {
      if (infohash && infohash === value) return true;
    } else if (rule.targetType === 'repo') {
      if (!repoId) continue;
      if (value.endsWith('/*')) {
        if (repoId.startsWith(value.slice(0, -1)) || repoId.split('/')[0] === value.slice(0, -2)) return true;
      } else if (repoId === value) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Verify a signed update-feed envelope with REAL Ed25519 crypto. Mirrors
 * src/main/hub-crypto.js verifyUpdateFeed byte-for-byte: signature over
 * `frostbyte-bundle/1\n` + canonicalJson(envelope minus {signature,feedPubKey}),
 * flat base64 64-byte signature, raw hex64 key wrapped in the fixed SPKI prefix.
 */
export function verifyFeedEnvelope(envelope) {
  try {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
    const { signature, feedPubKey, ...body } = envelope;
    if (typeof signature !== 'string' || typeof feedPubKey !== 'string') return false;
    if (!SHA256_RE.test(feedPubKey)) return false;
    const sig = Buffer.from(signature, 'base64');
    if (sig.length !== 64) return false;
    const publicKey = createPublicKey({
      key: Buffer.from(SPKI_ED25519_PREFIX + feedPubKey, 'hex'),
      format: 'der',
      type: 'spki',
    });
    const message = Buffer.from(`${BUNDLE_DOMAIN}\n${canonicalJson(body)}`, 'utf8');
    return cryptoVerify(null, message, publicKey, sig);
  } catch {
    return false;
  }
}

/** Structural validation of the feed body the desktop normalizer accepts. */
function validateFeedBody(envelope) {
  const arrays = ['engines', 'recipes', 'configs', 'containers'];
  let any = false;
  for (const key of arrays) {
    if (envelope[key] === undefined) continue;
    if (!Array.isArray(envelope[key])) return `Feed "${key}" must be an array.`;
    any = true;
    for (const entry of envelope[key]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `Feed "${key}" entries must be objects.`;
      if (entry.severity !== undefined && !FEED_SEVERITIES.has(entry.severity)) {
        return 'Feed severity must be info, recommended, or security.';
      }
    }
  }
  if (!any) return 'Feed needs at least one of engines, recipes, configs, containers.';
  if (!Number.isSafeInteger(envelope.version) || envelope.version < 1) return 'Feed version must be a positive integer.';
  return null;
}

function verifyRecipeEd25519(bytes, sigBuf, pubKeyHex) {
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from(SPKI_ED25519_PREFIX, 'hex'), Buffer.from(pubKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(null, bytes, publicKey, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Register the recipe share plane on the shared router.
 * `ensureProfile` is injected from app.js so API-key callers are refused with
 * the same `profile_required` gate as the P1 identity routes.
 */
export function registerRecipeRoutes(router, { store, now = () => Date.now(), ensureProfile } = {}) {
  if (!store) throw new Error('registerRecipeRoutes requires a store.');

  // Anonymous reads get a strict per-IP minute ceiling (docs: anon 60/min).
  // Authenticated reads use the caller's discovery bucket (tier-scaled).
  async function readBudget(req, identity) {
    if (identity?.uid) {
      await consume({ store, uid: identity.uid, tier: identity.tier, bucket: 'discovery', now });
    } else {
      await consume({ store, uid: anonIpKey(req), tier: 'free', bucket: 'anonReads', now });
    }
  }

  async function sessionCaller(identity) {
    const caller = requireIdentity(identity);
    // API keys are refused outright — even when a profile exists for the uid.
    // Publish/withdraw are interactive-session operations (same posture as
    // the P1 key-bind route); a leaked API key must not move recipes.
    if (caller.authType !== 'firebase') {
      throw forbidden('API keys cannot publish or withdraw recipes; sign in with your account.', 'profile_required');
    }
    const profile = await ensureProfile(caller);
    if (!profile) throw forbidden('API keys cannot publish or withdraw recipes; sign in with your account.', 'profile_required');
    return caller;
  }

  async function moderationRules() {
    return store.listModerationRules();
  }

  /**
   * Operator-takedown check for digest-addressed reads. A takedown
   * (force-withdraw) must hide the content everywhere, or it is decorative:
   * if ANY head pointing at this digest was force-withdrawn, the digest is
   * blocked. Owner self-withdraws keep the digest immutable-200 so importers
   * can verify already-downloaded content (decision 6). Bounded scan — the
   * plane is small at v1 (same ceiling as search).
   */
  async function digestIsTakenDown(digest) {
    const heads = await store.listRecipeHeadsByDigest(digest);
    return heads.some((head) => head.withdrawnAt && head.takedown === true);
  }

  // ---- POST /v1/recipes — publish (session + bound key + real signature) ----

  router.post('/v1/recipes', async ({ req, identity }) => {
    const caller = await sessionCaller(identity);
    const body = await readJsonBody(req, MAX_RECIPE_BODY_BYTES);

    // 1. Terms — the exact anchor the desktop signs against.
    if (body?.terms !== FROSTNET_TERMS) {
      throw badRequest(`Publishing requires accepting FrostNet terms ${FROSTNET_TERMS}.`, 'terms_required');
    }

    // 2. Validate + normalize. The client must transmit the SAME normalized
    //    manifest it signed (hubManifestDigest normalizes before hashing).
    let manifest;
    try {
      manifest = validateRecipe(body?.manifest);
    } catch (error) {
      throw badRequest(error.message, 'manifest_invalid');
    }

    // 3. Explicit createdAt. The validator silently defaults it to the server
    //    clock — a digest the client never signed. Refuse instead.
    const rawCreatedAt = body?.manifest?.createdAt;
    if (typeof rawCreatedAt !== 'string' || !rawCreatedAt.trim() || !Number.isFinite(Date.parse(rawCreatedAt))) {
      throw badRequest('manifest.createdAt is required and must be a parseable timestamp.', 'created_at_required');
    }
    if (manifest.createdAt !== rawCreatedAt) {
      throw badRequest('manifest.createdAt must be transmitted exactly as signed.', 'created_at_mismatch');
    }

    // 4. Recompute the digest server-side; a provided digest must match.
    const digest = canonicalDigest(manifest);
    if (body?.digest !== undefined && body.digest !== digest) {
      throw badRequest('Provided digest does not match the manifest.', 'digest_mismatch');
    }
    // Character cap is the validator's; the BYTE cap is ours (Firestore doc
    // limit + desktop 2 MiB response cap).
    if (Buffer.byteLength(canonicalJson(manifest), 'utf8') > MAX_RECIPE_CANONICAL_BYTES) {
      throw badRequest('Recipe metadata exceeds the 1 MiB byte limit.', 'manifest_too_large');
    }

    // 5. Real Ed25519 verification over the signing domain — flat base64.
    const signature = typeof body?.signature === 'string' ? body.signature : '';
    if (!signature) throw badRequest('A base64 Ed25519 signature is required.', 'signature_required');
    let signatureOk = false;
    try {
      signatureOk = verifyRecipeSignature({
        digest,
        pubkey: manifest.publisher,
        timestamp: manifest.createdAt,
        signature,
        verify: verifyRecipeEd25519,
      });
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) throw badRequest('Signature does not verify against the manifest publisher key.', 'signature_invalid');

    // 6. Live binding: the key must be bound to THIS account and not unbound.
    //    (Ownership of the record is then pinned to caller.uid at write time.)
    const binding = await store.getPublisherKey(manifest.publisher);
    if (!binding || binding.uid !== caller.uid || binding.unboundAt) {
      throw forbidden('That publisher key is not bound to your account.', 'publisher_unbound');
    }

    // 7. Write budget (free tier = 10/min, matching the documented publish cap).
    await consume({ store, uid: caller.uid, tier: caller.tier, bucket: 'writes', now });

    // 8. Store: tombstone → collision → idempotency → revision, atomically.
    const result = await store.publishRecipe({
      manifest, digest, signature, ownerUid: caller.uid, terms: FROSTNET_TERMS, nowMs: now(),
    });
    if (!result.ok) {
      if (result.code === 'withdrawn') throw conflict('This recipe was withdrawn and cannot be republished.', 'withdrawn');
      if (result.code === 'not_owner') throw conflict('That recipe id belongs to another account.', 'not_owner');
      throw conflict('Publish conflict.', result.code);
    }
    if (!result.idempotent) {
      await store.appendAudit({
        action: 'recipe.publish', uid: caller.uid, recipeId: manifest.id, digest, actor: caller.authType,
      });
    }
    return { ok: true, digest, status: 'published', id: manifest.id, currentVersion: result.head.currentVersion };
  });

  // ---- GET /v1/search — anonymous metadata search over live heads ----------

  router.get('/v1/search', async ({ req, identity, url }) => {
    await readBudget(req, identity);
    const params = url.searchParams;
    const q = boundedText(params.get('q') || params.get('query') || '', 200);
    const kind = boundedText(params.get('kind') || '', 64);
    const task = boundedText(params.get('task') || '', 64);
    const format = boundedText(params.get('format') || '', 64);
    const quant = boundedText(params.get('quant') || '', 64);
    const publisher = boundedText(params.get('publisher') || '', 128);
    if (publisher && !SHA256_RE.test(publisher)) throw badRequest('publisher must be a hex64 pubkey.', 'publisher_invalid');
    const limit = clampInt(params.get('limit'), 25, 1, 100);
    const cursor = params.get('cursor') || '';
    if (cursor && (cursor.length > 4096 || !decodeRecipeCursor(cursor))) {
      throw badRequest('Invalid search cursor.', 'bad_cursor');
    }

    const page = await store.listRecipes({ q, kind, task, format, quant, publisher, limit, cursor: cursor || null });
    const rules = await moderationRules();
    const items = [];
    for (const head of page.items) {
      const record = await store.getRecipeManifest(head.digest);
      if (recipeIsBlocked(head, record?.manifest, rules)) continue;
      items.push(head);
    }
    return { items, nextCursor: page.nextCursor };
  });

  // ---- GET /v1/recipes/:id/manifest — MUST register before bare :id --------

  router.get('/v1/recipes/:id/manifest', async ({ req, res, params, identity }) => {
    await readBudget(req, identity);
    if (!RECIPE_ID_RE.test(params.id || '')) throw badRequest('Invalid recipe id.', 'recipe_id_invalid');
    const head = await store.getRecipeHead(params.id);
    if (!head) throw notFound('No recipe with that id.', 'recipe_not_found');
    if (head.withdrawnAt) throw new HubError(410, 'withdrawn', 'This recipe was withdrawn by its publisher.');
    const record = await store.getRecipeManifest(head.digest);
    if (!record) throw notFound('Manifest missing for that recipe.', 'recipe_not_found');
    const rules = await moderationRules();
    if (recipeIsBlocked(head, record.manifest, rules)) throw notFound('No recipe with that id.', 'recipe_not_found');
    const etag = etagForDigest(head.digest);
    if (etagMatches(req.headers?.['if-none-match'], etag)) {
      res.statusCode = 304;
      res.setHeader('ETag', etag);
      res.end();
      return undefined;
    }
    sendJson(res, 200, { digest: head.digest, manifest: record.manifest, signature: record.signature }, { ETag: etag });
    return undefined;
  });

  // ---- GET /v1/recipes/:id — head + manifest + provenance ------------------
  router.get('/v1/recipes/:id', async ({ req, res, params, identity }) => {
    await readBudget(req, identity);
    if (!RECIPE_ID_RE.test(params.id || '')) throw badRequest('Invalid recipe id.', 'recipe_id_invalid');
    const head = await store.getRecipeHead(params.id);
    if (!head) throw notFound('No recipe with that id.', 'recipe_not_found');
    if (head.withdrawnAt) {
      // NEW contract (decision 6): 410 + tombstone metadata. Never 304 against
      // the old published ETag — a cached client must learn about the withdraw.
      const error = new HubError(410, 'withdrawn', 'This recipe was withdrawn by its publisher.');
      error.headers = { 'X-Recipe-Status': 'withdrawn', 'X-Recipe-Withdrawn-At': head.withdrawnAt };
      throw error;
    }
    const record = await store.getRecipeManifest(head.digest);
    if (!record) throw notFound('Manifest missing for that recipe.', 'recipe_not_found');
    const rules = await moderationRules();
    if (recipeIsBlocked(head, record.manifest, rules)) throw notFound('No recipe with that id.', 'recipe_not_found');
    const etag = etagForDigest(head.digest);
    if (etagMatches(req.headers?.['if-none-match'], etag)) {
      res.statusCode = 304;
      res.setHeader('ETag', etag);
      res.end();
      return undefined;
    }
    const owner = await store.getUser(head.ownerUid);
    sendJson(res, 200, {
      head: { id: head.id, currentVersion: head.currentVersion },
      digest: head.digest,
      manifest: record.manifest,
      signature: head.signature,
      status: 'published',
      provenance: {
        publisher: head.publisher,
        ownerUid: head.ownerUid,
        handle: owner?.handle || null,
        terms: head.terms,
        publishedAt: head.publishedAt,
        createdAt: head.createdAt,
      },
    }, { ETag: etag });
    return undefined;
  });

  // ---- GET /v1/manifests/:digest — immutable, stays 200 after withdraw -----

  router.get('/v1/manifests/:digest', async ({ req, res, params, identity }) => {
    await readBudget(req, identity);
    if (!SHA256_RE.test(params.digest || '')) throw badRequest('Invalid manifest digest.', 'digest_invalid');
    const record = await store.getRecipeManifest(params.digest);
    if (!record) throw notFound('No manifest with that digest.', 'manifest_not_found');
    // Owner self-withdraw keeps this 200 (verify downloaded content), but an
    // operator takedown hides the digest everywhere — otherwise the takedown
    // is decorative.
    if (await digestIsTakenDown(params.digest)) throw notFound('No manifest with that digest.', 'manifest_not_found');
    const rules = await moderationRules();
    const headForDigest = (await store.listRecipeHeadsByDigest(params.digest))[0] || null;
    if (recipeIsBlocked(headForDigest, record.manifest, rules)) throw notFound('No manifest with that digest.', 'manifest_not_found');
    const etag = etagForDigest(params.digest);
    if (etagMatches(req.headers?.['if-none-match'], etag)) {
      res.statusCode = 304;
      res.setHeader('ETag', etag);
      res.end();
      return undefined;
    }
    sendJson(res, 200, { digest: record.digest, manifest: record.manifest, signature: record.signature }, { ETag: etag });
    return undefined;
  });

  // ---- DELETE /v1/recipes/:id — owner-only withdraw (publish-time pin) -----

  router.delete('/v1/recipes/:id', async ({ params, identity }) => {
    const caller = await sessionCaller(identity);
    if (!RECIPE_ID_RE.test(params.id || '')) throw badRequest('Invalid recipe id.', 'recipe_id_invalid');
    await consume({ store, uid: caller.uid, tier: caller.tier, bucket: 'writes', now });
    const result = await store.withdrawRecipe(params.id, caller.uid, { nowMs: now() });
    if (!result.ok) {
      if (result.code === 'not_found') throw notFound('No recipe with that id.', 'recipe_not_found');
      if (result.code === 'not_owner') throw forbidden('That recipe belongs to another account.', 'not_owner');
      throw conflict('Withdraw conflict.', result.code);
    }
    if (!result.already) {
      await store.appendAudit({ action: 'recipe.withdraw', uid: caller.uid, recipeId: params.id, digest: result.head.digest, actor: caller.authType });
    }
    return { ok: true, id: params.id, status: 'withdrawn', already: result.already === true };
  });

  // ---- GET /v1/changes — append-only sync log, numeric-string seq cursor ---

  router.get('/v1/changes', async ({ req, identity, url }) => {
    await readBudget(req, identity);
    const params = url.searchParams;
    const limit = clampInt(params.get('limit'), 50, 1, 100);
    const cursor = params.get('cursor') || '';
    if (cursor && !/^\d{1,15}$/.test(cursor)) throw badRequest('Invalid changes cursor.', 'bad_cursor');
    const page = await store.listRecipeChanges({ limit, cursor: cursor || null });
    return { changes: page.items, nextCursor: page.nextCursor };
  });

  // ---- Community home plane (P3): announcements, release notes, feed ------
  // Operator-published content only — no user free-text in v1. Bodies are
  // plain text (clients render as text, never HTML). Firestore index-entry
  // limits are handled by fieldOverrides on announcements.body /
  // releaseNotes.body (platform/firestore.indexes.json) — the emulator does
  // NOT enforce the 1500-byte limit, so only a deployed probe verifies it.

  const ANNOUNCEMENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const RELEASE_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;
  const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
  // 64 KiB fits title 140 + body 4000 (≤16KB UTF-8) + tag/reason overhead.
  const CONTENT_BODY_BYTES = 64 * 1024;

  function validateContentFields(body, { requireId = null } = {}) {
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 140) throw badRequest('title is required (1–140 characters).', 'title_invalid');
    const text = typeof body?.body === 'string' ? body.body : '';
    if (!text.trim() || text.length > 4000) throw badRequest('body is required (1–4000 characters, plain text).', 'body_invalid');
    const tag = typeof body?.tag === 'string' ? body.tag.trim() : '';
    if (tag && !TAG_RE.test(tag)) throw badRequest('tag must be lowercase letters, digits, hyphens (≤32).', 'tag_invalid');
    const out = { title, body: text, tag };
    if (requireId === 'announcement') {
      const id = typeof body?.id === 'string' ? body.id : '';
      if (!ANNOUNCEMENT_ID_RE.test(id)) throw badRequest('id must be lowercase letters, digits, hyphens (1–64).', 'id_invalid');
      out.id = id;
      out.pinned = body?.pinned === true;
    }
    if (requireId === 'release') {
      const version = typeof body?.version === 'string' ? body.version : '';
      if (!RELEASE_VERSION_RE.test(version)) throw badRequest('version must be semver, e.g. 2.0.0.', 'version_invalid');
      const released = typeof body?.released === 'string' ? body.released : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(released) || !Number.isFinite(Date.parse(released))) {
        throw badRequest('released must be an ISO date (YYYY-MM-DD).', 'released_invalid');
      }
      out.version = version;
      out.released = released;
      out.current = body?.current === true;
    }
    return out;
  }

  // Public projection: authorUid NEVER leaves the operator plane.
  const publicAnnouncement = ({ id, title, body, tag, pinned, publishedAt, updatedAt }) =>
    ({ id, title, body, tag, pinned, publishedAt, updatedAt });
  const publicReleaseNote = ({ version, released, title, body, current, updatedAt }) =>
    ({ version, released, title, body, current, updatedAt });

  router.get('/v1/announcements', async ({ req, identity, url }) => {
    await readBudget(req, identity);
    const limit = clampInt(url.searchParams.get('limit'), 20, 1, 50);
    const rows = await store.listAnnouncements({ limit });
    // Bounded read, no cursor in v1 (documented): the operator archive is
    // capped at the 100 newest; pinned-first ordering is store-enforced.
    return { items: rows.map(publicAnnouncement) };
  });

  router.get('/v1/feed', async ({ req, identity, url }) => {
    await readBudget(req, identity);
    const params = url.searchParams;
    const limit = clampInt(params.get('limit'), 25, 1, 50);
    const cursor = params.get('cursor') || '';
    if (cursor && (cursor.length > 4096 || !decodeRecipeCursor(cursor))) {
      throw badRequest('Invalid feed cursor.', 'bad_cursor');
    }
    const followingRequested = params.get('following') === '1';
    let publishers = null;
    if (followingRequested) {
      // Session-only: a leaked API key must not read a user's private graph.
      if (!identity?.uid) throw unauthorized('Sign in to see recipes from creators you follow.');
      if (identity.authType !== 'firebase') {
        throw forbidden('API keys cannot read the following feed; sign in with your account.', 'profile_required');
      }
      const follows = await store.listFollowsForUser(identity.uid);
      publishers = follows.map(follow => follow.pubKey);
    }

    // ONE store scan (following filter inside listRecipes — never a
    // per-follow fan-out). nextCursor is the RAW store page cursor, taken
    // BEFORE moderation filtering, so a fully-blocked page still paginates.
    const page = await store.listRecipes({ publishers, limit, cursor: cursor || null });
    const rules = await moderationRules();
    const manifests = new Map();
    const creators = new Map();
    const items = [];
    for (const head of page.items) {
      if (!manifests.has(head.digest)) {
        const record = await store.getRecipeManifest(head.digest);
        manifests.set(head.digest, record?.manifest || null);
      }
      const manifest = manifests.get(head.digest);
      if (recipeIsBlocked(head, manifest, rules)) continue;
      if (!creators.has(head.publisher)) {
        const binding = await store.getPublisherKey(head.publisher);
        const user = binding ? await store.getUser(binding.uid) : null;
        creators.set(head.publisher, feedCreatorProjection({ pubKey: head.publisher, user, binding }));
      }
      // totalBytes is DERIVED from the pinned manifest file sizes (never a
      // publisher claim on the head) so the home page can render memory-fit
      // badges without a per-recipe detail fetch. 0 = manifest unavailable.
      const totalBytes = (manifest?.files || []).reduce((sum, f) => sum + (Number(f.size) || 0), 0);
      items.push({ ...head, totalBytes, creator: creators.get(head.publisher) });
    }

    const announcementRows = await store.listAnnouncements({ limit: 13 });
    const pinned = announcementRows.filter(row => row.pinned).slice(0, PINNED_ANNOUNCEMENT_CAP).map(publicAnnouncement);
    const pinnedIds = new Set(pinned.map(row => row.id));
    const announcements = announcementRows.filter(row => !pinnedIds.has(row.id)).slice(0, 10).map(publicAnnouncement);
    const releases = (await store.listReleaseNotes({ limit: 5 })).map(publicReleaseNote);

    return {
      generatedAt: new Date(now()).toISOString(),
      pinned,
      announcements,
      releases,
      recipes: items,
      following: followingRequested,
      nextCursor: page.nextCursor,
    };
  });

  // ---- GET /v1/updates — operator-signed envelope, served VERBATIM ---------
  // Plus/Pro only. No ETag/304 here: the desktop client has no etag option on
  // updates() and hub:updates has no 304 branch (decision 8). The envelope is
  // whatever the operator signed — the server adds no fields, ever.

  router.get('/v1/updates', async ({ identity }) => {
    const caller = requireIdentity(identity);
    if (!isPaidTier(caller.tier)) {
      throw forbidden('The update feed is a Plus/Pro feature.', 'upgrade_required');
    }
    await consume({ store, uid: caller.uid, tier: caller.tier, bucket: 'discovery', now });
    const feed = await store.getUpdateFeed();
    if (!feed) throw unavailable('The update feed has not been published yet.', 'feed_unavailable');
    const { id: _docId, ...envelope } = feed;
    return envelope;
  });

  // ---- Admin: operator feed import + recipe takedown + feed inspection -----
  // Same zero-trust gate as every /v1/admin route (requireAdmin + step-up on
  // mutations + audit reason), registered here so the recipe plane owns its
  // own operator surface.

  const adminRoute = (method, path, handler) => {
    router[method](path, async ({ req, res, params, identity }) => {
      const mutating = method !== 'get';
      await requireAdmin(identity, { store, now, requireFreshAuth: mutating });
      await consume({ store, uid: identity.uid, tier: identity.tier, bucket: 'admin', now });
      const result = await handler({ caller: identity, params: params || {}, req });
      if (result && typeof result === 'object' && typeof result.status === 'number' && 'body' in result) {
        sendJson(res, result.status, result.body);
        return undefined;
      }
      return result;
    });
  };

  adminRoute('get', '/v1/admin/recipes/feed', async () => {
    const feed = await store.getUpdateFeed();
    if (!feed) return { status: 200, body: { ok: true, feed: null } };
    const { id: _docId, ...envelope } = feed;
    return { ok: true, feed: envelope, signatureValid: verifyFeedEnvelope(envelope) };
  });

  adminRoute('post', '/v1/admin/recipes/feed', async ({ caller, req }) => {
    const body = await readJsonBody(req, MAX_RECIPE_BODY_BYTES);
    const reason = requireAuditReason(body);
    const envelope = body?.feed;
    const structural = envelope && typeof envelope === 'object' ? validateFeedBody(envelope) : 'Feed envelope is required.';
    if (structural) throw badRequest(structural, 'feed_invalid');
    // Verify BEFORE storing: the server must never persist an envelope it
    // cannot authenticate, and must serve it verbatim afterwards.
    if (!verifyFeedEnvelope(envelope)) throw badRequest('Feed signature does not verify.', 'feed_signature_invalid');
    const before = await store.getUpdateFeed();
    await store.setUpdateFeed(envelope);
    await store.appendAudit({
      actorUid: caller.uid, actorEmail: caller.email || '', action: 'recipe.feed_import',
      targetType: 'updateFeed', targetId: 'current', reason,
      before: before ? { feedPubKey: before.feedPubKey, version: before.version } : null,
      after: { feedPubKey: envelope.feedPubKey, version: envelope.version },
      at: new Date(now()).toISOString(),
    });
    return { status: 201, body: { ok: true, version: envelope.version, feedPubKey: envelope.feedPubKey } };
  });

  adminRoute('post', '/v1/admin/recipes/:id/withdraw', async ({ caller, params, req }) => {
    const body = await readJsonBody(req, 64 * 1024);
    const reason = requireAuditReason(body);
    if (!RECIPE_ID_RE.test(params.id || '')) throw badRequest('Invalid recipe id.', 'recipe_id_invalid');
    const head = await store.getRecipeHead(params.id);
    if (!head) throw notFound('No recipe with that id.', 'recipe_not_found');
    // force=true is the operator takedown bypass — audited, never owner-gated.
    const result = await store.withdrawRecipe(params.id, caller.uid, { nowMs: now(), force: true });
    if (!result.ok) throw conflict('Takedown conflict.', result.code);
    await store.appendAudit({
      actorUid: caller.uid, actorEmail: caller.email || '', action: 'recipe.takedown',
      targetType: 'recipe', targetId: params.id, reason,
      before: { ownerUid: head.ownerUid, digest: head.digest, withdrawnAt: head.withdrawnAt },
      after: { withdrawnAt: result.head.withdrawnAt },
      at: new Date(now()).toISOString(),
    });
    return { ok: true, id: params.id, status: 'withdrawn', already: result.already === true };
  });

  // ---- Legacy FrostNet retirement import (P2.3, operator-vouched) ----------
  // Migrates recipes enumerated from the legacy frostnet-si deployment into
  // the new plane. The ORIGINAL publisher key + signature are preserved —
  // migration never re-signs or re-keys. Every record is re-validated and
  // independently signature-verified server-side; the client's claims are
  // never trusted. ownerUid resolves to the original publisher's bound account
  // when one exists, else the importing operator (who vouches for the record).
  // Idempotent: re-importing the same digest is a no-op. Withdrawn ids stay
  // tombstoned (publishRecipe refuses them). Behind the SAME zero-trust gate
  // as every admin mutation: requireAdmin + fresh step-up + audit reason.
  const IMPORT_MAX_RECORDS = 200;
  // Batch byte cap: tooling chunks larger exports into multiple requests.
  const IMPORT_MAX_BODY_BYTES = 8 * 1024 * 1024;
  adminRoute('post', '/v1/admin/frostnet-import', async ({ req, caller }) => {
    const body = await readJsonBody(req, IMPORT_MAX_BODY_BYTES);
    const reason = requireAuditReason(body);
    const records = Array.isArray(body?.records) ? body.records : [];
    if (!records.length) throw badRequest('Provide a non-empty records array.', 'records_required');
    if (records.length > IMPORT_MAX_RECORDS) throw badRequest(`At most ${IMPORT_MAX_RECORDS} records per import batch.`, 'batch_too_large');
    const source = String(body?.source || 'frostnet-si').slice(0, 64);
    const importedAt = new Date(now()).toISOString();
    const results = [];
    for (const record of records) {
      const id = String(record?.id || '');
      try {
        // Re-validate + recompute the digest server-side. Never trust the
        // client's digest claim. Same checks as the live publish route.
        let manifest;
        try { manifest = validateRecipe(record?.manifest); }
        catch (error) { throw badRequest(error.message, 'manifest_invalid'); }
        const rawCreatedAt = record?.manifest?.createdAt;
        if (typeof rawCreatedAt !== 'string' || !rawCreatedAt.trim() || !Number.isFinite(Date.parse(rawCreatedAt))) {
          throw badRequest('manifest.createdAt is required and must be a parseable timestamp.', 'created_at_required');
        }
        if (manifest.createdAt !== rawCreatedAt) {
          throw badRequest('manifest.createdAt must be transmitted exactly as signed.', 'created_at_mismatch');
        }
        const digest = canonicalDigest(manifest);
        if (record?.digest !== undefined && record.digest !== digest) {
          throw badRequest('digest does not match the canonical manifest', 'digest_mismatch');
        }
        if (Buffer.byteLength(canonicalJson(manifest), 'utf8') > MAX_RECIPE_CANONICAL_BYTES) {
          throw badRequest('Recipe metadata exceeds the 1 MiB byte limit.', 'manifest_too_large');
        }
        // Independent Ed25519 verification over the recipe signing domain —
        // the exact wrapper the publish route uses.
        const signature = typeof record?.signature === 'string' ? record.signature : '';
        if (!signature) throw badRequest('A base64 Ed25519 signature is required.', 'signature_required');
        let signatureOk = false;
        try {
          signatureOk = verifyRecipeSignature({
            digest,
            pubkey: manifest.publisher,
            timestamp: manifest.createdAt,
            signature,
            verify: verifyRecipeEd25519,
          });
        } catch {
          signatureOk = false;
        }
        if (!signatureOk) throw badRequest('Signature does not verify against the manifest publisher key.', 'signature_invalid');
        // Resolve the owner: the original publisher's bound account if present,
        // else the importing operator who vouches for this legacy record.
        const binding = await store.getPublisherKey(manifest.publisher);
        const ownerUid = binding && !binding.unboundAt ? binding.uid : caller.uid;
        const result = await store.publishRecipe({
          manifest, digest, signature, ownerUid, terms: FROSTNET_TERMS, nowMs: now(),
        });
        if (!result.ok) {
          // withdrawn → tombstone stays; not_owner → a different account already
          // owns this id (cannot migrate over it). Both are honest refusals.
          results.push({ id, outcome: 'refused', code: result.code });
          continue;
        }
        // Provenance receipt: original publisher preserved, migration tagged.
        await store.appendAudit({
          actorUid: caller.uid, actorEmail: caller.email || '', action: 'recipe.import',
          targetType: 'recipe', targetId: manifest.id, reason,
          before: null,
          after: {
            digest, ownerUid, publisher: manifest.publisher,
            migratedFrom: source, legacySeq: record?.legacySeq ?? null,
            importedAt, idempotent: result.idempotent === true,
          },
          at: importedAt,
        });
        results.push({ id: manifest.id, outcome: result.idempotent ? 'idempotent' : 'imported', digest, ownerUid });
      } catch (error) {
        results.push({ id, outcome: 'refused', code: error.code || 'invalid', message: error.message });
      }
    }
    const imported = results.filter((r) => r.outcome === 'imported').length;
    const idempotent = results.filter((r) => r.outcome === 'idempotent').length;
    const refused = results.filter((r) => r.outcome === 'refused').length;
    return { ok: true, source, importedAt, total: records.length, imported, idempotent, refused, results };
  });

  // ---- Admin: announcements + release notes (P3 content plane) -------------
  // Same zero-trust adminRoute gate: requireAdmin + fresh step-up on
  // mutations + audit reason. authorUid is visible ONLY on these admin
  // lists; public projections drop it.

  adminRoute('get', '/v1/admin/announcements', async () => {
    const items = await store.listAnnouncements({ limit: 50 });
    return { ok: true, items, pinnedCap: PINNED_ANNOUNCEMENT_CAP };
  });

  adminRoute('post', '/v1/admin/announcements', async ({ caller, req }) => {
    const body = await readJsonBody(req, CONTENT_BODY_BYTES);
    const reason = requireAuditReason(body);
    const fields = validateContentFields(body, { requireId: 'announcement' });
    const result = await store.putAnnouncement({ ...fields, authorUid: caller.uid }, { nowMs: now() });
    if (!result.ok) {
      if (result.code === 'pinned_cap') throw conflict(`At most ${PINNED_ANNOUNCEMENT_CAP} announcements may be pinned. Unpin one first.`, 'pinned_cap');
      throw conflict('Announcement write conflict.', result.code);
    }
    await store.appendAudit({
      actorUid: caller.uid, actorEmail: caller.email || '', action: 'announcement.publish',
      targetType: 'announcement', targetId: fields.id, reason,
      before: null,
      after: { title: fields.title, pinned: fields.pinned },
      at: new Date(now()).toISOString(),
    });
    return { status: 201, body: { ok: true, announcement: result.announcement } };
  });

  adminRoute('patch', '/v1/admin/announcements/:id', async ({ caller, params, req }) => {
    const body = await readJsonBody(req, CONTENT_BODY_BYTES);
    const reason = requireAuditReason(body);
    if (!ANNOUNCEMENT_ID_RE.test(params.id || '')) throw badRequest('Invalid announcement id.', 'id_invalid');
    const before = await store.getAnnouncement(params.id);
    if (!before) throw notFound('No announcement with that id.', 'announcement_not_found');
    const fields = validateContentFields({ ...before, ...body, id: params.id }, { requireId: 'announcement' });
    const result = await store.putAnnouncement({ ...fields, authorUid: before.authorUid }, { nowMs: now() });
    if (!result.ok) {
      if (result.code === 'pinned_cap') throw conflict(`At most ${PINNED_ANNOUNCEMENT_CAP} announcements may be pinned. Unpin one first.`, 'pinned_cap');
      throw conflict('Announcement write conflict.', result.code);
    }
    await store.appendAudit({
      actorUid: caller.uid, actorEmail: caller.email || '', action: 'announcement.update',
      targetType: 'announcement', targetId: params.id, reason,
      before: { title: before.title, pinned: before.pinned },
      after: { title: fields.title, pinned: fields.pinned },
      at: new Date(now()).toISOString(),
    });
    return { ok: true, announcement: result.announcement };
  });

  adminRoute('delete', '/v1/admin/announcements/:id', async ({ caller, params, req }) => {
    const body = await readJsonBody(req, CONTENT_BODY_BYTES);
    const reason = requireAuditReason(body);
    if (!ANNOUNCEMENT_ID_RE.test(params.id || '')) throw badRequest('Invalid announcement id.', 'id_invalid');
    const before = await store.getAnnouncement(params.id);
    if (!before) throw notFound('No announcement with that id.', 'announcement_not_found');
    await store.deleteAnnouncement(params.id);
    await store.appendAudit({
      actorUid: caller.uid, actorEmail: caller.email || '', action: 'announcement.delete',
      targetType: 'announcement', targetId: params.id, reason,
      before: { title: before.title, pinned: before.pinned }, after: null,
      at: new Date(now()).toISOString(),
    });
    return { ok: true, id: params.id, deleted: true };
  });

  adminRoute('get', '/v1/admin/release-notes', async () => {
    const items = await store.listReleaseNotes({ limit: 50 });
    return { ok: true, items };
  });

  adminRoute('post', '/v1/admin/release-notes', async ({ caller, req }) => {
    const body = await readJsonBody(req, CONTENT_BODY_BYTES);
    const reason = requireAuditReason(body);
    const fields = validateContentFields(body, { requireId: 'release' });
    const existing = await store.getReleaseNote(fields.version);
    if (existing) throw conflict('Release notes for that version already exist; use PATCH.', 'release_note_exists');
    const result = await store.putReleaseNote({ ...fields, authorUid: caller.uid }, { nowMs: now() });
    await store.appendAudit({
      actorUid: caller.uid, actorEmail: caller.email || '', action: 'release_note.publish',
      targetType: 'releaseNote', targetId: fields.version, reason,
      before: null, after: { title: fields.title, released: fields.released, current: fields.current },
      at: new Date(now()).toISOString(),
    });
    return { status: 201, body: { ok: true, releaseNote: result.releaseNote } };
  });

  adminRoute('patch', '/v1/admin/release-notes/:version', async ({ caller, params, req }) => {
    const body = await readJsonBody(req, CONTENT_BODY_BYTES);
    const reason = requireAuditReason(body);
    if (!RELEASE_VERSION_RE.test(params.version || '')) throw badRequest('Invalid version.', 'version_invalid');
    const before = await store.getReleaseNote(params.version);
    if (!before) throw notFound('No release notes for that version.', 'release_note_not_found');
    const fields = validateContentFields({ ...before, ...body, version: params.version }, { requireId: 'release' });
    const result = await store.putReleaseNote({ ...fields, authorUid: before.authorUid }, { nowMs: now() });
    await store.appendAudit({
      actorUid: caller.uid, actorEmail: caller.email || '', action: 'release_note.update',
      targetType: 'releaseNote', targetId: params.version, reason,
      before: { title: before.title, current: before.current },
      after: { title: fields.title, current: fields.current },
      at: new Date(now()).toISOString(),
    });
    return { ok: true, releaseNote: result.releaseNote };
  });

  adminRoute('delete', '/v1/admin/release-notes/:version', async ({ caller, params, req }) => {
    const body = await readJsonBody(req, CONTENT_BODY_BYTES);
    const reason = requireAuditReason(body);
    if (!RELEASE_VERSION_RE.test(params.version || '')) throw badRequest('Invalid version.', 'version_invalid');
    const before = await store.getReleaseNote(params.version);
    if (!before) throw notFound('No release notes for that version.', 'release_note_not_found');
    await store.deleteReleaseNote(params.version);
    await store.appendAudit({
      actorUid: caller.uid, actorEmail: caller.email || '', action: 'release_note.delete',
      targetType: 'releaseNote', targetId: params.version, reason,
      before: { title: before.title }, after: null,
      at: new Date(now()).toISOString(),
    });
    return { ok: true, version: params.version, deleted: true };
  });
}