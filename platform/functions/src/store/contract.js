/**
 * Store contract.
 *
 * The API never talks to Firestore directly; it talks to this interface. That
 * keeps the tests network-free and hermetic, and it keeps the Firestore-specific
 * decisions (transactional increments, document shape, timestamp types) in one
 * file.
 *
 * Every method is async and every method may throw. Implementations must never
 * silently swallow a write failure.
 */

/**
 * @typedef {object} UserRecord
 * @property {string} uid
 * @property {string} email
 * @property {string} displayName
 * @property {string} tier                 Resolved tier, denormalized for reads.
 * @property {object|null} subscription    Billing-owned fields.
 * @property {string} createdAt            ISO timestamp.
 * @property {string} updatedAt            ISO timestamp.
 */

export const COLLECTIONS = Object.freeze({
  users: 'users',
  subscriptions: 'subscriptions',
  entitlements: 'entitlements',
  orgs: 'orgs',
  apiKeys: 'apiKeys',
  usage: 'usage',
  discoveryCache: 'discoveryCache',
  auditLog: 'auditLog',
  hardwareProfiles: 'hardwareProfiles',
  savedModels: 'savedModels',
  admins: 'admins',
  entitlementOverrides: 'entitlementOverrides',
  frostnetModeration: 'frostnetModeration',
  frostnetFeatured: 'frostnetFeatured',
  systemConfig: 'systemConfig',
  stripeEvents: 'stripeEvents',
  quarantinePreTenant: 'quarantinePreTenant',
  desktopAuthCodes: 'desktopAuthCodes',
  desktopSessions: 'desktopSessions',
  // Identity plane (ADR 003): reserved handle aliases, uid↔pubkey bindings,
  // single-use key-binding challenges, released-handle grace records.
  handles: 'handles',
  publisherKeys: 'publisherKeys',
  publisherChallenges: 'publisherChallenges',
  handleHistory: 'handleHistory',
  // Recipe share plane (P2): id-keyed heads, digest-addressed manifests,
  // append-only publish/withdraw change log, operator-signed update feed.
  recipes: 'recipes',
  recipeManifests: 'recipeManifests',
  recipeChanges: 'recipeChanges',
  updateFeed: 'updateFeed',
  // Community home plane (P3): operator announcements + release notes,
  // per-user pubkey-keyed follow graph (private writes, public counts).
  announcements: 'announcements',
  releaseNotes: 'releaseNotes',
  follows: 'follows',
});

/**
 * Documented v1 scan ceiling shared by BOTH stores: recipe search/feed only
 * ever see the RECIPE_SCAN_WINDOW newest heads (publishedAt DESC). The plane
 * is small at launch; this bounds Firestore reads without a composite index.
 * The memory store mirrors the window so tests cannot pass on rows that
 * production would never scan (docs/hub-api.md §Search/§Feed).
 */
export const RECIPE_SCAN_WINDOW = 500;

/** Server-enforced follow-graph cap per user (mirrors the desktop local cap). */
export const FOLLOW_CAP = 256;

/** Server-enforced pinned-announcement cap (feed shows pinned first). */
export const PINNED_ANNOUNCEMENT_CAP = 3;

/**
 * Public feed creator join — a STRICT SUBSET of publicCreatorProjection.
 * Only these fields may ever be attached to a recipe head on public surfaces;
 * never uid, email, tier, tenant, or billing. A missing user (deleted account)
 * projects as an unverified key-only creator: recipes outlive accounts and
 * provenance stays immutable.
 */
export function feedCreatorProjection({ pubKey, user, binding }) {
  return {
    pubkey: pubKey,
    handle: user?.handle || '',
    displayName: user?.displayName || '',
    photoUrl: user?.photoUrl || '',
    verified: Boolean(user && binding && !binding.unboundAt),
  };
}

/**
 * Opaque search cursor for the recipe plane: last seen (publishedAt, id).
 * ISO timestamps sort lexicographically, so the pair is a stable total order
 * under `publishedAt DESC, id ASC`. Shared by both stores so the wire format
 * can never drift between backends.
 */
export function encodeRecipeCursor(head) {
  return Buffer.from(JSON.stringify({ p: head.publishedAt, i: head.id }), 'utf8').toString('base64url');
}

export function decodeRecipeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof parsed?.p !== 'string' || typeof parsed?.i !== 'string') return null;
    return { publishedAt: parsed.p, id: parsed.i };
  } catch {
    return null;
  }
}

/**
 * Recipe search token semantics — shared by BOTH stores so the wire behavior
 * can never drift between backends (docs/hub-api.md §Search):
 *
 *  - `q`: case-insensitive substring over title + description + modelRef.repoId
 *    + file paths. Tokens are preserved verbatim in storage; only the match
 *    lowercases.
 *  - `quant`: VERBATIM case-sensitive token match (`Q4_K_M` never matches
 *    `q4_k_m`) against the CANONICAL quant tokens: title + modelRef.variant.
 *    Recipe v2 has no quant field; the publisher's title/variant is the
 *    authoritative token source. File paths deliberately do NOT contribute
 *    verbatim tokens — filenames conventionally lowercase the quant
 *    (`model-q4_k_m.gguf`), which would defeat case-sensitive matching.
 *  - `format`: verbatim match against file extensions (gguf, safetensors, …).
 *  - `task`: verbatim token match against title + repoId + variant tokens
 *    (e.g. `text-generation`). Freeform description is deliberately EXCLUDED
 *    from verbatim token sources — it may mention a quant in the wrong case.
 *  - File paths DO feed the case-insensitive `q` haystack, so searching for a
 *    filename still works.
 */
export function recipeSearchHaystack(head, manifest) {
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const paths = files.map(file => String(file?.path || ''));
  const extensions = new Set();
  const tokens = new Set();
  const addTokens = (value) => {
    // Split on whitespace and path separators only — hyphens stay INSIDE
    // tokens so verbatim values like `text-generation` and `apache-2.0`
    // match exactly as published.
    for (const token of String(value || '').split(/[\s/\\]+/)) {
      if (token) tokens.add(token);
    }
  };
  for (const path of paths) {
    const dot = path.lastIndexOf('.');
    if (dot > 0 && dot < path.length - 1) extensions.add(path.slice(dot + 1));
  }
  const title = String(head?.title || manifest?.title || '');
  const description = String(head?.description || manifest?.description || '');
  const repoId = String(manifest?.modelRef?.repoId || '');
  const variant = String(manifest?.modelRef?.variant || '');
  addTokens(title);
  addTokens(repoId);
  addTokens(variant);
  return {
    q: [title, description, repoId, ...paths].join(' ').toLowerCase(),
    tokens,
    extensions,
  };
}

export function recipeMatchesTokens(haystack, { q = '', task = '', format = '', quant = '' } = {}) {
  if (q && !haystack.q.includes(String(q).toLowerCase())) return false;
  if (quant && !haystack.tokens.has(String(quant))) return false;
  if (format && !haystack.extensions.has(String(format))) return false;
  if (task && !haystack.tokens.has(String(task))) return false;
  return true;
}

/**
 * Fields that only the server may write. A client PATCH containing any of these
 * is rejected outright rather than silently ignored, so a buggy client fails
 * loudly in development instead of quietly in production.
 */
export const SERVER_OWNED_USER_FIELDS = Object.freeze([
  'tier',
  'subscription',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'entitlementVersion',
  'createdAt',
  'updatedAt',
  'lastSeenAt',
  'disabled',
  'roles',
  // ADR 003: server-managed identity bindings — never client-writable.
  'handle',
  'handleLower',
  'publisherKeys',
]);

/** Fields a client may set on its own profile. */
export const CLIENT_WRITABLE_USER_FIELDS = Object.freeze([
  'displayName',
  'photoUrl',
  'locale',
  'timezone',
  'preferences',
  'bio',
]);

// `handle` is intentionally NOT in CLIENT_WRITABLE_USER_FIELDS: it is a unique
// reserved alias (ADR 003) and must go through the transactional reservation
// path (store.setHandle), never the generic profile PATCH.

/**
 * The full method surface every store implementation must expose. Asserted in
 * unit tests against both createMemoryStore() and createFirestoreStore() so the
 * two backends can never drift apart silently.
 */
export const REQUIRED_STORE_METHODS = Object.freeze([
  // Users / profiles
  'getUser',
  'setUser',
  'createUserIfAbsent',
  'updateUser',
  'deleteUser',
  'listUsers',
  'countUsers',
  // Identity plane (ADR 003)
  'getHandle',
  'setHandle',
  'getHandleHistory',
  'getPublisherKey',
  'setPublisherKey',
  'deletePublisherKey',
  'listPublisherKeysForUser',
  'createPublisherChallenge',
  'getPublisherChallenge',
  'consumePublisherChallenge',
  // Recipe share plane (P2)
  'publishRecipe',
  'getRecipeHead',
  'getRecipeManifest',
  'listRecipeHeadsByDigest',
  'withdrawRecipe',
  'listRecipes',
  'listRecipeChanges',
  'getUpdateFeed',
  'setUpdateFeed',
  // Community home plane (P3)
  'listAnnouncements',
  'getAnnouncement',
  'putAnnouncement',
  'deleteAnnouncement',
  'listReleaseNotes',
  'getReleaseNote',
  'putReleaseNote',
  'deleteReleaseNote',
  'addFollow',
  'removeFollow',
  'listFollowsForUser',
  'countFollowers',
  'countRecipesByPublisher',
  'deleteFollowsForUser',
  // Billing
  'getSubscription',
  'setSubscription',
  'getEntitlement',
  'setEntitlement',
  'countActiveSubscriptions',
  'recordStripeEvent',
  'listStripeEvents',
  // Orgs
  'getOrg',
  'setOrg',
  'listOrgsForUser',
  // API keys
  'getApiKey',
  'setApiKey',
  'deleteApiKey',
  'listApiKeysForUser',
  'countApiKeysForUser',
  'countActiveApiKeys',
  'revokeAllApiKeysForUser',
  // Usage / cache
  'getUsage',
  'incrementUsage',
  'getCache',
  'setCache',
  'clearDiscoveryCache',
  // Audit
  'appendAudit',
  'listAudit',
  'listAuditLog',
  // User dashboard
  'listHardwareProfiles',
  'upsertHardwareProfile',
  'deleteHardwareProfile',
  'listSavedModels',
  'upsertSavedModel',
  'deleteSavedModel',
  // Admin console
  'getAdmin',
  'setAdmin',
  'listAdmins',
  'getEntitlementOverride',
  'setEntitlementOverride',
  'clearEntitlementOverride',
  'countActiveOverrides',
  'listModerationRules',
  'upsertModerationRule',
  'deleteModerationRule',
  'listFeaturedModels',
  'upsertFeaturedModel',
  'deleteFeaturedModel',
  'getFrostNetConfig',
  'setFrostNetConfig',
  // Desktop browser handoff (PKCE one-time codes + revocable per-device sessions)
  'createDesktopAuthCode',
  'consumeDesktopAuthCode',
  'createDesktopSession',
  'getDesktopSession',
  'revokeDesktopSession',
  'revokeAllDesktopSessionsForUser',
]);