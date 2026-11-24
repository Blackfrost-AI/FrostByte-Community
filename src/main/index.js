/**
 * Frost/Byte — Electron main process.
 *
 * Owns the window, the torrent engine, the catalog, and the runtime
 * managers (rates/scheduler, queue, seed goals, UPnP, move-on-complete).
 * The renderer gets a narrow, explicit API through preload; it never
 * touches Node or the network directly.
 */
import { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, safeStorage, clipboard, protocol, net, powerMonitor } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrivacyService } from './privacy.js';
import { UpdateChecker, downloadUrlForChannel } from './updates.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import NatAPI from '@silentbot1/nat-api';
import { TorrentEngine, extractInfoHash, isMagnet, parseTrackerList, normalizeTorrentSelection } from './torrent.js';
import { Catalog, normalizeCatalogEntry } from './catalog.js';
import { fetchCatalogJson, persistCatalogImport, validateCatalogUrl } from './catalog-import.js';
import { Store } from './store.js';
import { ConfirmationService } from './confirmations.js';
import { IpfsTransfers } from './ipfs.js';
import { registerIpfsHandlers } from './ipfs-handlers.js';
import { aeonDeviceUrl } from './aeon-device.js';
import { PublisherManager } from './publisher-manager.js';
import { settleTorrentRemoval } from './transfer-removal.js';
import { applyDurableTransferIntent, commitTransferIntent, TransferMutationCoordinator } from './transfer-intent.js';
import { armShutdownFailsafe, ShutdownCleanup } from './shutdown.js';
import { RateManager, QueueManager, SeedGoalManager, UpnpManager, moveCompleted, prepareCompletionMove, tick,
  completionPathIdentity, sameCompletionIdentity, completionRecoveryDisposition,
  removeOwnedCompletionPathSync, sameLocalPath } from './managers.js';
import { fetchCardImage } from './card-images.js';
import { hfBrowse, hfFacets, hfRefs, hfModelInfo, hfReadme, hfWhoami, hfDownloadFile, hfStatFile, hfDestination, hfDestinationPathKeys, hfTransferId, normalizeHfTransferRecord, validateHfDownloadSelection, validateHfRepoId, HfAuthError, sha256File } from './hf.js';
import { normalizePirateFaceQuery, pirateFaceRepoTorrents, pirateFaceSearch, pirateFaceTorrentsEndpoint } from './pirateface.js';
import { createHfDownloadAuthorization, describeHfToken, describeSavedHfCredential, hfAuthenticatedEndpoint, hfCredentialStateSnapshot, hfTransferAuthorization, HF_WHOAMI_ENDPOINT, normalizeHfRevision, verifyHfTransferAuthorization } from './hf-authorizations.js';
import { hfResumeRecordSnapshot, prepareHfResume, validateHfResumeIds } from './hf-resume.js';
import { getHybridIdentity, downloadHybrid, identityKey } from './hf-hybrid.js';
import { normalizeSource, inspectTorrent, readTorrent } from './torrent-source.js';
import { sparkRequest, validateSparkHost, validateDirectProfile, keyFingerprint } from './spark.js';
import { SparkSetup } from './spark-setup.js';
import { downloadSourcesFromArguments, LaunchSourceQueue } from './source-arguments.js';
import { DownloadInventory } from './inventory.js';
import { OriginRegistry, collectionFiles } from './aeon-origin-check.js';
import { originBlocksSharing, ORIGIN_SHARE_BLOCKED } from '../shared/aeon-origin-status.js';
import { IntegrityRegistry, integrityBlocksSharing, INTEGRITY_SHARE_BLOCKED, listFolderFiles } from './integrity-service.js';
import { EntryLifecycle } from './entry-lifecycle.js';
import { registerLibraryBatch } from './library-batch.js';
import { torrentDescriptorBudgetSnapshot } from './torrent-descriptor-budget.js';
import { planHfPartials, deleteHfPartials } from './hf-partials.js';
import { entryPath } from '../shared/entry-identity.js';
import { ShareLinks } from './share-links.js';
import { registerShareExport } from './share-export.js';
import { PublishingService } from './publishing-service.js';
import { inventoryProofText } from '../shared/inventory-proof.js';
import { ModelLibrary, modelLocation, localModelDirectory } from './model-library.js';
import { createHubClient } from './hub-client.js';
import { FROSTNET_TERMS as HUB_PUBLISH_TERMS } from '../shared/release-manifest.js';
import { RECIPE_MAX_FILES } from '../shared/recipe-manifest.js';
import { createFirebaseAuth, isDeadSessionError } from './firebase-auth.js';
import { createEntitlementCache } from './hub-entitlements.js';
import { checkUpdates as checkHubUpdates } from './hub-updates.js';
import { normalizeUpdateFeed, compareAgainstFeed } from './hub-update-feed.js';
import { verifyUpdateFeed } from './hub-crypto.js';
import {
  EMPTY_HUB_ACCOUNT,
  getHubEntitlement as getHubEntitlementStore, applyHubEntitlement,
  getHubConfig as getHubConfigStore, applyHubConfig,
  getHubAccount as getHubAccountStore, applyHubAccount, clearHubAccount,
  shouldEvictStaleTenantSession,
} from './hub-store.js';
import {
  HUB_API_BASE, validateHubBaseUrl, describeHubToken, hubTokenGeneration, rendererEntitlementRequest,
  hubRequestReview, hubTokenSaveReview, bearerAllowed, firebaseTokenTenant, HUB_REVIEW_ACTIONS,
} from './hub-security.js';
import { FOLLOW_CAP } from '../shared/hub-protocol.js';
import {
  createDesktopAuthRequest, desktopAuthBrowserReview, desktopAuthExchangeReview,
  isDesktopAuthCandidate, parseDesktopAuthUrl, validateDesktopSignInUrl, DESKTOP_AUTH_DEEP_LINK_HOST,
} from './desktop-auth.js';
import { FIREBASE_CONFIG } from '../shared/firebase-config.js';
import { DeviceRegistry } from './devices.js';
import { SparkDeviceManager } from './spark-device-manager.js';
import { NetworkDevices, registerNetworkDevices } from './network-devices.js';
import { getDeviceInfo } from './device-info.js';
import { localTelemetry } from './local-telemetry.js';
import { validContentKind } from '../shared/content-kind.js';
import {
  CLIENT_WRITABLE_USER_FIELDS, validateHandle, validateBio, validateDisplayName, validatePhotoUrl, validatePubKey,
} from '../shared/identity-rules.js';
import { COMMUNITY_LINKS } from '../shared/community.js';
import { EDITION_INFO } from '../shared/edition.js';
import { PathCapabilities } from './path-capabilities.js';
import { TorrentDiscoveryAuthorizations } from './torrent-authorizations.js';
import { classifyExternalUrl } from './external-links.js';
import { allowDebugHfProbe, isAuthorizedAppIpc, lockDownAppWebContents, resolveAppAsset } from './app-protocol.js';
import { approvedRevealPath } from './reveal-path.js';
import { authenticatedHfRequestReview, catalogImportReview, clipboardWriteReview, deviceAccessRemovalReview, exactReviewText, externalUrlReview, hfCredentialChangeReview, hfDownloadReview, hfTokenValidationReview, localTorrentFileReview, pairedPeerEndpointsReview, pirateFaceBrowseReview, pirateFaceTermsReview, privacyAcceptanceReview, remoteHfDownloadReview, reviewLabel, sensitiveSettingsReview, torrentDiscoveryReview } from './native-review.js';
import { setOpenAtLogin } from './linux-autostart.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../..');
const isDev = !app.isPackaged && process.argv.includes('--dev');
// Playwright's Electron loader deliberately selects Chromium's plaintext
// password store. Linux CI opts back into the real Secret Service backend so
// the pairing workflow exercises OS-backed encryption. Packaged apps cannot
// honor this test-only environment control.
if (!app.isPackaged && process.platform === 'linux'
  && process.env.FROSTBYTE_TEST_LINUX_PASSWORD_STORE === 'gnome-libsecret') {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}
const allowTestPeerAddresses = isDev && process.env.FROSTBYTE_TEST_DIRECT_PEERS === '1';
const TICK_MS = 5000;
const credentialRecovery = process.platform === 'darwin' ? 'Allow Keychain access'
  : process.platform === 'win32' ? 'Sign in to the Windows account that saved it'
    : 'Unlock your operating system credential store';

app.setName(EDITION_INFO.appSetName);
const loginItemOptions = {
  app,
  desktopId: EDITION_INFO.desktopId,
  name: EDITION_INFO.appSetName,
};
protocol.registerSchemesAsPrivileged([{
  scheme: 'frostbyte',
  privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true, stream: true, codeCache: true },
}]);
if (process.env.FROSTBYTE_HOME) app.setPath('userData', path.join(process.env.FROSTBYTE_HOME, 'electron'));
else if (process.platform === 'darwin') app.setPath('userData', path.join(app.getPath('appData'), 'Frost', 'Byte'));
else if (process.platform === 'linux') app.setPath('userData', path.join(app.getPath('appData'), EDITION_INFO.profile, 'electron'));
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  // Stop module evaluation as well. app.exit() terminates Electron, while the
  // unresolved await prevents a losing instance from constructing app state
  // or registering runtime work during that final tick.
  await new Promise(() => {});
}
const rendererUrl = 'frostbyte://app/renderer/index.html';
const pathCapabilities = new PathCapabilities();
const pendingSources = new LaunchSourceQueue({
  grantTorrent: source => pathCapabilities.grant(source, 'torrent'),
  releaseTorrent: source => {
    if (source && typeof source === 'object' && source.purpose === 'torrent') {
      pathCapabilities.revoke(source.capability);
    }
  },
});
let sourceListenerReady = false;
const pendingNotices = [];
const pendingAuthUrls = [];
let startupReady = false;
let win = null;
function focusWindow() {
  // Launch Services and a second process can arrive after Electron itself is
  // ready but while top-level hardware discovery is still pending. Keep their
  // requests queued until protocol, IPC, and runtime initialization finish.
  if (!startupReady || !app.isReady()) return;
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function receiveSource(value) {
  const source = pendingSources.capture(value);
  if (!source) return;
  if (!pendingSources.enqueue(source)) return;
  const contents = win && !win.isDestroyed() ? win.webContents : null;
  if (startupReady && sourceListenerReady && contents && !contents.isDestroyed()) {
    // This is only a wake-up signal. The renderer explicitly requests one
    // source when no other review dialog is active, which provides delivery
    // backpressure and mints at most one path capability at a time.
    try { contents.send('app:source'); } catch { /* the raw request remains queued */ }
  }
  focusWindow();
}
function receiveDesktopAuthUrl(value) {
  if (!isDesktopAuthCandidate(value)) return;
  if (sourceListenerReady) {
    focusWindow();
    completeDesktopAuthUrl(value).catch((err) => push('hub:auth-status', { status: 'error', message: err.message }));
  } else if (pendingAuthUrls.length < 8) {
    pendingAuthUrls.push(value);
  }
}
// macOS launch services and a second process can deliver these while hardware
// discovery is still running. Queue them before any blocking startup probe.
app.on('open-file', (event, file) => { event.preventDefault(); receiveSource(file); });
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (isDesktopAuthCandidate(url)) { receiveDesktopAuthUrl(url); return; }
  receiveSource(url);
});
app.on('second-instance', (_event, argv, workingDirectory) => {
  for (const arg of argv || []) {
    if (isDesktopAuthCandidate(arg)) receiveDesktopAuthUrl(arg);
  }
  for (const source of downloadSourcesFromArguments(argv, { isPackaged: app.isPackaged, cwd: workingDirectory })) receiveSource(source);
  focusWindow();
});
const store = new Store();
const confirmations = new ConfirmationService({
  directory: store.appDir,
  showMessageBox: (window, options) => dialog.showMessageBox(window, options),
  onChange: value => push('confirmations:changed', value),
});
const showReview = options => confirmations.show(win, options);
const networkDevices = new NetworkDevices({ directory: store.appDir,
  confirm: async ({ message, detail, action, remember }) => (await showReview({ type: 'question', buttons: ['Cancel', action], defaultId: 0, cancelId: 0, message, detail, remember })).response === 1,
  onChange: value => push('network-devices:changed', value),
});

const publisher = new PublisherManager({ store, protection: safeStorage,
  confirm: async kind => {
    const exporting = kind === 'export';
    const approval = await showReview({
      type: 'warning', buttons: ['Cancel', exporting ? 'Show recovery phrase' : 'Remove publisher'],
      defaultId: 0, cancelId: 0,
      title: exporting ? 'Recovery phrase' : 'Remove publisher identity',
      message: exporting ? 'Show your publisher recovery phrase?' : 'Remove this publisher identity from FrostByte?',
      detail: exporting
        ? 'Anyone with this phrase can publish as you. Keep an offline backup. The phrase will hide after one minute or when you leave this view.'
        : 'Keep your recovery phrase to restore the same identity later. Removing it here does not remove any public listings.',
    });
    return approval.response === 1;
  },
});
function publisherPublicState() { return publisher.status(); }

const torrentDiscoveryAuthorizations = new TorrentDiscoveryAuthorizations();
const updates = new UpdateChecker({ version: app.getVersion(), channel: EDITION_INFO.channel, saved: store.state.updateCheck,
  save: value => store.setUpdateCheck(value) });
const updateDownloadUrl = downloadUrlForChannel(EDITION_INFO.channel);
updates.on('change', state => push('updates:status', state));
let updateTimer;
const privacy = new PrivacyService({ directory: store.appDir, version: app.getVersion() });
const legalDocuments = JSON.parse(fs.readFileSync(path.join(here, '../shared/legal.json'), 'utf8'));
const inventory = new DownloadInventory(store);
const origins = new OriginRegistry({ store, inventory });
const entryLifecycle = new EntryLifecycle(store);
try { entryLifecycle.recover(inventory); } catch (error) { console.error('Entry reconciliation needs retry:', error.message); }
const ipfs = new IpfsTransfers({ isolated: allowTestPeerAddresses, directory: path.join(store.appDir, 'ipfs'), binaryDirectory: app.isPackaged ? path.join(process.resourcesPath, 'ipfs-runtime') : path.join(appRoot, 'build/ipfs-runtime', `${process.platform}-${process.arch}`) });
// File-integrity scans run beside the AEON origin statement: risky formats are
// never seeded onward, and HF copies can be anchored to upstream hashes. The
// resolver maps inventory, discovered-model, IPFS, and plain shared-folder ids
// to local files; unresolvable ids (remote devices, vanished rows) scan to null.
// One canonical folder-integrity key for every gate: shareLocalFolder, the
// completion gate and scan revocation must agree on the id for the same
// directory even when path spellings differ (relative vs absolute, trailing
// slash, win32 case). Normalization mirrors sameLocalPath.
const folderIntegrityId = folder => {
  const resolved = path.resolve(folder);
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return 'folder:' + createHash('sha256').update(normalized).digest('hex');
};
const resolveIntegrityItem = async id => {
  if (id.startsWith('ipfs:')) {
    let job; try { job = ipfs.record(id); } catch { return null; }
    if (job.status !== 'done' || !job.destination || !job.folder) return null;
    return { path: path.join(job.destination, job.folder), files: job.files.map(file => ({ path: file.path, size: file.size })) };
  }
  if (id.startsWith('scan:')) {
    let entry; try { entry = modelLibrary.entry(id); } catch { return null; }
    if (entry.device !== 'local' || !entry.available || !entry.root) return null;
    return { path: entry.root, files: entry.files.map(file => ({ path: file.relative, size: file.size })) };
  }
  if (id.startsWith('shared:')) {
    const shared = store.getLibrary().find(item => 'shared:' + item.infohash === id);
    if (!shared?.path) return null;
    return { path: shared.path, files: await listFolderFiles(shared.path) };
  }
  const row = inventory.rows.find(item => item.id === id);
  if (!row) return null;
  const entry = inventory.list({ refresh: true }).find(item => item.id === id);
  if (!entry?.available) return null;
  return { path: row.destination, files: row.files.map(file => ({ path: file.relative, size: file.size })) };
};
const integrity = new IntegrityRegistry(store, { resolveItem: resolveIntegrityItem });
ipfs.integrity = integrity;
const hubEntitlements = createEntitlementCache();
/** Hub token lives encrypted with the OS keychain, bound to the exact origin it was saved for. */
function hubToken(expectedOrigin) {
  const enc = store.state.hubTokenEnc;
  if (!enc || !expectedOrigin) return { token: '', generation: '' };
  try {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') return { token: '', generation: '' };
    const origin = typeof store.state.hubTokenOrigin === 'string' ? store.state.hubTokenOrigin : '';
    const fingerprint = typeof store.state.hubTokenFingerprint === 'string' ? store.state.hubTokenFingerprint : '';
    if (!origin || !fingerprint || origin !== expectedOrigin) return { token: '', generation: '' };
    const token = safeStorage.decryptString(Buffer.from(enc, 'base64'));
    return { token, generation: hubTokenGeneration(origin, fingerprint) };
  } catch { return { token: '', generation: '' }; }
}

// Best-effort read of the Identity Platform tenant claim from a Firebase ID
// token, for labeling only — the Hub verifies the token cryptographically and
// is the sole tenant authority. Returns '' when absent (root pool) or when the
// payload cannot be read; callers must never substitute the configured tenant
// for an unreadable one (review F1: that would launder stale root-pool
// sessions into tenant-matching ones during rollout skew).
// --- Firebase session (browser handoff → ID token + refresh token) ------------
// The ID token is the Hub Bearer credential (stored as hubTokenEnc, bound to the
// pinned Hub API base). The Firebase refresh token is stored separately
// (hubRefreshEnc) so a session can be renewed across restarts without another
// browser handoff. Both are safeStorage ciphertext; plaintext never touches
// disk. Passwords are never accepted, persisted or logged by the desktop app.
const firebaseAuth = createFirebaseAuth({ apiKey: FIREBASE_CONFIG.apiKey, tenantId: FIREBASE_CONFIG.tenantId });
const pendingDesktopAuth = new Map();

/**
 * Evict a cached pre-tenant Hub session at startup / status checks (spec §2.4).
 * Once a FrostByte Identity Platform tenant is stamped, any cached credential
 * from the shared root pool is stale and would loop 401s against the tenant-
 * gated Hub. Manual bfk_ token sessions (signedIn false + no stored refresh
 * credential) are left untouched. Loopback Hubs are not supported.
 */
function evictStaleTenantHubSession() {
  try {
    const rawCfgUrl = typeof store.state.hubConfig?.hubUrl === 'string' ? store.state.hubConfig.hubUrl : '';
    if (rawCfgUrl && rawCfgUrl !== HUB_API_BASE) {
      applyHubConfig(store, { hubUrl: HUB_API_BASE });
      store.setHubRefreshCredential({ hubRefreshEnc: '', hubRefreshOrigin: '' });
      return true;
    }
    if (!FIREBASE_CONFIG.tenantId) return false;
    const origin = HUB_API_BASE;
    const account = getHubAccountStore(store);
    const { present } = store.getHubRefreshCredential();
    if (!shouldEvictStaleTenantSession({
      tenantId: FIREBASE_CONFIG.tenantId,
      origin,
      isLoopback: false,
      account,
      hasRefreshToken: present,
    })) return false;
    clearHubAccount(store);
    store.setHubRefreshCredential({ hubRefreshEnc: '', hubRefreshOrigin: '' });
    return true;
  } catch { return false; }
}

function hubRefreshToken(expectedOrigin) {
  try {
    const { present, enc, origin } = store.getHubRefreshCredential();
    if (!present || origin !== expectedOrigin) return '';
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') return '';
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch { return ''; }
}

/**
 * Encrypt and persist a Firebase session (ID token + refresh token) bound to the
 * exact Hub origin. Refuses a plaintext-fallback keychain backend. Returns the
 * described ID-token fingerprint so the caller can build a credential generation.
 */
function persistFirebaseSession({ token, refreshToken, expiresAt }, origin) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('System keychain encryption is unavailable; FrostByte will not save this session as plaintext.');
  if (safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('This system provides only plaintext credential storage; FrostByte refuses to save the session there.');
  const described = describeHubToken(token);
  const enc = safeStorage.encryptString(token).toString('base64');
  store.setHubCredential({ hubTokenEnc: enc, hubTokenOrigin: origin, hubTokenFingerprint: described.fingerprint });
  // The local development Hub issues no refresh token (short-lived HS256 JWT);
  // store no refresh credential in that case so a stale one cannot be resurrected.
  if (refreshToken) {
    store.setHubRefreshCredential({
      hubRefreshEnc: safeStorage.encryptString(refreshToken).toString('base64'),
      hubRefreshOrigin: origin,
    });
  } else {
    store.setHubRefreshCredential({ hubRefreshEnc: '', hubRefreshOrigin: '' });
  }
  // Bind expiry to this origin only when known. Store rejects an origin-bound
  // expiry of 0; throwing here AFTER the token was written would leave a partial
  // persist (hasToken true, signedIn false). Clear the origin when unknown so an
  // unparseable expiry degrades gracefully instead of aborting the sign-in.
  const safeExpiry = Number.isSafeInteger(expiresAt) && expiresAt > 0 ? expiresAt : 0;
  store.setHubTokenExpiry({ hubTokenExpiresAt: safeExpiry, hubTokenExpiryOrigin: safeExpiry ? origin : '' });
  return described;
}

/**
 * Return a usable Firebase ID token for the configured Hub, refreshing it via
 * the stored refresh token when it has expired (or is within the module's skew
 * window). Throws a HubRefusal when no session exists or renewal fails, so the
 * caller can surface a re-sign-in prompt. Never returns a plaintext password.
 *
 * Single-flight: concurrent callers (startup restore + a user action) share one
 * in-flight refresh per origin, so a rotated refresh token is never presented
 * twice. A refresh failure only clears the session when the credential is
 * definitively dead AND the stored refresh token is still the one that failed.
 */
const hubRefreshInFlight = new Map();
async function ensureHubIdToken() {
  const cfg = getHubConfigStore(store);
  const origin = cfg.hubUrl;
  if (origin !== HUB_API_BASE) throw refuse('FrostByte Hub is not configured correctly.', 'not_configured');
  const current = hubToken(origin);
  const expiry = store.getHubTokenExpiry();
  // Only trust an expiry record bound to this exact origin.
  const expiresAt = expiry.origin === origin ? expiry.expiresAt : 0;
  const nowMs = Date.now();
  // Still valid (with a 60s safety margin matching the auth module) → reuse.
  if (current.token && (!expiresAt || expiresAt - 60_000 > nowMs)) {
    // Label with the token's REAL tenant claim, never the configured tenant as
    // a fallback (review F1). bfk_ API keys carry no tenant claim.
    return {
      token: current.token,
      generation: current.generation,
      origin,
      tenantId: current.token.startsWith('bfk_') ? '' : firebaseTokenTenant(current.token),
    };
  }
  const refreshToken = hubRefreshToken(origin);
  if (!refreshToken) {
    // A known-expired token with no way to renew is dead — refuse rather than
    // send a credential we know the Hub will reject. (Manual opaque tokens have
    // no expiry record and are passed through for the Hub to judge.)
    if (current.token && !expiresAt) {
      return {
        token: current.token,
        generation: current.generation,
        origin,
        tenantId: current.token.startsWith('bfk_') ? '' : firebaseTokenTenant(current.token),
      };
    }
    throw refuse('Your Hub session expired. Sign in again.', 'unauthorized');
  }
  const pending = hubRefreshInFlight.get(origin);
  if (pending) return pending;
  const work = (async () => {
    let session;
    try { session = await firebaseAuth.refresh(refreshToken); }
    catch (error) {
      // Only a definitively dead credential ends the session — and only if the
      // stored refresh token is still the one that failed (a concurrent renewal
      // may have already replaced it). Transient network/timeout errors keep the
      // session intact so the next attempt can succeed.
      if (isDeadSessionError(error) && hubRefreshToken(origin) === refreshToken) {
        clearHubAccount(store);
      }
      throw refuse(error instanceof Error ? error.message : 'Your Hub session expired. Sign in again.', 'unauthorized');
    }
    // Tenant guard (review F1): a stamped build must never adopt a session
    // whose refresh returned a different tenant (e.g. a cached root-pool
    // credential during rollout skew). Evict instead of relabeling — a
    // relabeled dead credential would survive shouldEvictStaleTenantSession
    // and produce the exact 401 loop eviction exists to prevent.
    if (FIREBASE_CONFIG.tenantId && (session.tenantId || '') !== FIREBASE_CONFIG.tenantId) {
      // Only evict if the stored refresh credential is still the one that
      // failed (review R1): a concurrent fresh sign-in may have already
      // replaced it, and that new session must survive this stale refusal.
      if (hubRefreshToken(origin) === refreshToken) {
        clearHubAccount(store);
        store.setHubRefreshCredential({ hubRefreshEnc: '', hubRefreshOrigin: '' });
        note('Stored session belongs to a different sign-in tenant — cleared; sign in again.', 'warn');
      }
      throw refuse('Your saved session belongs to a different FrostByte sign-in. Sign in again.', 'hub_unauthorized');
    }
    const described = persistFirebaseSession(session, origin);
    return { token: session.token, generation: hubTokenGeneration(origin, described.fingerprint), origin, tenantId: session.tenantId || '' };
  })();
  hubRefreshInFlight.set(origin, work);
  try { return await work; }
  finally { hubRefreshInFlight.delete(origin); }
}

/**
 * Silently restore a previously approved Hub session at startup: renew the
 * Firebase ID token from the stored refresh token (if it has lapsed) and
 * re-verify the account/entitlement against the Hub. No new native review — the
 * session was already approved at sign-in and the credential stays bound to the
 * same origin. Best-effort: an unreachable Hub keeps the persisted session, and
 * a dead refresh token clears it so the UI prompts a fresh sign-in. Never blocks
 * or throws into app startup.
 */
async function restoreHubSession() {
  try {
    if (!privacy.accepted) return;
    if (evictStaleTenantHubSession()) {
      push('hub:changes', { hasToken: false, account: getHubAccountStore(store), entitlement: getHubEntitlementStore(store) });
      return;
    }
    const cfg = getHubConfigStore(store);
    if (cfg.hubUrl !== HUB_API_BASE || !cfg.hasToken) return;
    const account = getHubAccountStore(store);
    if (!account.signedIn) return;
    // Renew the ID token if needed; throws (and clears) only on a dead refresh.
    const session = await ensureHubIdToken();
    const client = createHubClient({ hubUrl: session.origin, token: session.token });
    let res;
    try {
      res = await client.me();
    } catch (err) {
      if (err?.status === 401) {
        const { account: cleared, entitlement: clearedEnt } = clearHubAccount(store);
        store.setHubRefreshCredential({ hubRefreshEnc: '', hubRefreshOrigin: '' });
        push('hub:changes', { hasToken: false, account: cleared, entitlement: clearedEnt });
        push('hub:updates', { tier: clearedEnt.tier });
      }
      return; // Hub unreachable, transient error, or evicted 401.
    }
    if (!res?.data) return; // Hub unreachable or transient error — keep persisted session.
    const verified = applyHubAccount(store, {
      ...res.data,
      // Label with the token's REAL tenant, never the configured one as a
      // fallback (review F1): fallback-labeling would launder a root-pool
      // session into a tenant-matching one during rollout skew.
      tenantId: session.tenantId || '',
      desktopSessionId: account.desktopSessionId || '',
      isAdmin: Boolean(res.data.isAdmin),
      verifiedAt: Date.now(),
    }, session.origin);
    const entitlement = syncVerifiedHubEntitlement(res.data.entitlement);
    const nextCfg = getHubConfigStore(store);
    push('hub:changes', { hasToken: nextCfg.hasToken, account: verified, entitlement });
    push('hub:updates', { tier: entitlement.tier });
  } catch {
    // A dead refresh token already cleared the session inside ensureHubIdToken.
    // Surface the signed-out state so the renderer stops showing a stale account.
    try {
      const cfg = getHubConfigStore(store);
      push('hub:changes', { hasToken: cfg.hasToken, account: getHubAccountStore(store), entitlement: getHubEntitlementStore(store) });
    } catch { /* startup must never throw */ }
  }
}

/** A client for the configured Hub, or null when none is configured. Public routes omit credentials.
 *  Authenticated routes refresh the Firebase ID token when it has lapsed. */
async function hubClient({ authenticated = false } = {}) {
  const cfg = getHubConfigStore(store);
  if (cfg.hubUrl !== HUB_API_BASE) return null;
  let token = '';
  let generation = '';
  if (authenticated) {
    const session = await ensureHubIdToken();
    token = session.token;
    generation = session.generation;
  }
  const client = createHubClient({ hubUrl: cfg.hubUrl, token });
  client.generation = generation;
  return client;
}
/** Native review gate before any request leaves for a Hub origin. */
async function reviewHub(client, action, { authenticated = false } = {}) {
  if (!client) return false;
  // Fail closed at boot, not at first click: every action routed here must
  // have a native-review label. An unlisted action would otherwise throw
  // inside hubRequestReview AFTER the feature shipped (P3 T6 found the P2/P3
  // handlers had no labels — tests stubbed the review, production would not).
  if (!HUB_REVIEW_ACTIONS.includes(action)) {
    throw new Error(`Hub review action "${action}" has no ACTION_LABELS entry — add one in hub-security.js.`);
  }
  const approved = await showReview(hubRequestReview({
    origin: client.origin, action,
    authenticated: authenticated && Boolean(client.getToken()),
    tokenGeneration: authenticated ? client.generation : '',
  }));
  return approved.response === 1;
}
const HUB_NOT_CONFIGURED_MESSAGE = 'FrostByte Hub is not configured correctly.';
await ipfs.load().catch(error => console.error('IPFS recovery:', error.message));
ipfs.on('change', value => push('ipfs:progress', value));
ipfs.on('failure', error => note(error.message, 'error'));
const ipfsTimer = setInterval(() => { void ipfs.sampleStats(); void ipfs.sampleInventory(); }, 2000);
const localDevice = await getDeviceInfo();
const devices = new DeviceRegistry({ store, request: sparkRequest, onChange: value => {
  push('devices:changed', value);
},
  unlock: profile => {
    if (profile.mode === 'ssh') return profile;
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('unavailable');
      return { ...profile, privateKey: safeStorage.decryptString(Buffer.from(profile.privateKeyEnc, 'base64')) };
    } catch { throw new Error(`Could not unlock this device connection. ${credentialRecovery} or pair it again. Your saved key was kept.`); }
  },
});
const sparkDevices = new SparkDeviceManager({ devices });

function localModelLocations() {
  const settings = store.getSettings();
  const discoveredRoots = (store.state?.modelLibrary?.rows || []).filter(item => item?.device === 'local').map(item => item.root);
  const roots = [settings.downloadDir, settings.completedDir, ...inventory.rows.map(item => item.destination), ...discoveredRoots];
  const locations = new Map();
  for (const root of roots.filter(Boolean)) {
    try {
      const source = modelLocation({ root, name: localDevice.name || 'This computer' });
      locations.set(process.platform === 'win32' ? source.root.toLowerCase() : source.root, source);
    } catch { /* Invalid saved locations never grant filesystem access. */ }
  }
  return [...locations.values()];
}
function currentModelLocation(source) {
  if (source.device === 'local') return localModelLocations().some(location => sameLocalPath(location.root, source.root));
  try {
    const record = devices.record(source.deviceId);
    return devices.isApprovalCurrent({ id: source.deviceId, digest: source.binding })
      && (record.snapshot?.storageRoots?.length ? record.snapshot.storageRoots : [record.snapshot?.downloadDir]).includes(source.root);
  } catch { return false; }
}
const modelLibrary = new ModelLibrary({ store, isCurrent: currentModelLocation,
  sources: async ({ signal }) => {
    const local = localModelLocations();
    await devices.refreshAll({ force: true });
    signal.throwIfAborted();
    const remote = [];
    for (const device of devices.list()) {
      const binding = devices.approvalSnapshot(device.id).digest;
      const common = { device: 'spark', deviceId: device.id, name: device.name, binding };
      const roots = device.status?.storageRoots?.length ? device.status.storageRoots : [device.status?.downloadDir].filter(Boolean);
      if (!roots.length) remote.push({ ...common, root: '', error: device.error || 'The device has not reported any saved directories. Connect to it and scan again.' });
      for (const root of roots) {
        try {
          const source = modelLocation({ ...common, root });
          const storage = device.status?.storage?.find(item => item.path === root);
          remote.push({ ...source, ...(!device.connected ? { error: device.error || 'Device is offline. Cached models were kept.' }
            : storage?.available === false ? { error: 'Storage is unavailable. Reconnect or mount this drive on the device.' } : {}) });
        } catch (error) { remote.push({ ...common, root, error: error.message }); }
      }
    }
    return [...local, ...remote];
  },
  readDirectory: async (source, relative, options) => {
    if (source.device !== 'local' && !currentModelLocation(source)) throw new Error('The saved model location changed. Scan again.');
    if (source.device === 'local') return localModelDirectory(source.root, relative, options);
    const result = await sparkRequest(sparkProfile(source.deviceId), { action: 'files', root: source.root, relative }, options);
    if (!currentModelLocation(source)) throw new Error('The device changed while scanning. Scan again.');
    return result;
  },
  onChange: value => push('library:scan-progress', value),
});

function sparkProfile(deviceId) { return devices.profile(deviceId); }
function saveSparkConnection(profile, host) { return devices.replace(profile, host); }
const sparkSetup = new SparkSetup({
  bundleDir: app.isPackaged ? path.join(process.resourcesPath, 'spark-companion') : path.resolve(here, '../../build/spark-companion'),
  expectedVersion: app.getVersion(),
  // The installed Spark companion legitimately lags the app on the public beta
  // channel, so any protocol-compatible companion is accepted rather than
  // requiring an exact version match.
  requireCurrent: false,
  encryptKey: privateKey => {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error(`Secure key storage is unavailable. ${credentialRecovery} or use an existing SSH connection.`);
    return safeStorage.encryptString(privateKey).toString('base64');
  },
  saveConnection: saveSparkConnection,
  onProgress: event => push('spark:setup-progress', event),
});
const sparkTargetApprovals = new Map();
async function approveSparkTarget(input) {
  let key, label;
  if (input?.mode === 'ssh') {
    label = validateSparkHost(input.host);
    key = `ssh\0${label}`;
  } else if (input?.mode === 'password') {
    const address = validateDirectProfile(input);
    label = `${address.username}@${address.host}:${address.port}`;
    key = `direct\0${label}`;
  } else throw new Error('Choose a device connection method.');
  const now = Date.now();
  for (const [target, expires] of sparkTargetApprovals) if (expires <= now) sparkTargetApprovals.delete(target);
  if ((sparkTargetApprovals.get(key) ?? 0) > now) return true;
  const result = await showReview({
    type: 'question', buttons: ['Cancel', 'Check this device'], defaultId: 0, cancelId: 0,
    message: `Connect to ${dialogText(label)} over SSH?`,
    summary: `${reviewLabel(label, 220)}\n\nCheck this device for the FrostByte companion.`,
    detail: `${exactReviewDetails({ endpoint: label })}\n\nFrostByte will contact this exact address on your local network to check or install its restricted companion.`,
  });
  if (result.response !== 1) return false;
  if (sparkTargetApprovals.size >= 32) sparkTargetApprovals.delete(sparkTargetApprovals.keys().next().value);
  sparkTargetApprovals.set(key, now + 10 * 60 * 1000);
  return true;
}
function resolveSparkSetupProbe(request) {
  if (request?.deviceId === undefined) return { input: request, binding: undefined };
  const purpose = ['add-storage', 'update-device'].includes(request?.purpose) ? request.purpose : '';
  if (!purpose) throw new Error('Choose a supported device authorization action.');
  const deviceId = request.deviceId, record = devices.record(deviceId), saved = record.profile;
  if (!['password', 'key'].includes(saved?.mode) || typeof saved.privateKeyEnc !== 'string' || !saved.privateKeyEnc) {
    throw new Error('This device does not use a FrostByte-managed connection.');
  }
  let fingerprint;
  try {
    const hostKey = Buffer.from(saved.hostKey, 'base64');
    if (!hostKey.length) throw new Error('empty');
    fingerprint = keyFingerprint(hostKey);
  } catch { throw new Error('The saved device identity is invalid. Pair this device again.'); }
  return {
    input: { mode: 'password', host: saved.host, username: saved.username, port: saved.port,
      password: request?.password, trustFingerprint: fingerprint },
    binding: { purpose, deviceId },
  };
}
async function confirmCompanionChange(sessionId, action, location) {
  const session = sparkSetup.getSession(sessionId);
  const target = session.info?.device?.hostname || session.profile?.host;
  const snapshot = JSON.stringify({ id: session.id, stage: session.stage, allowed: session.allowed,
    purpose: session.purpose, deviceId: session.deviceId, mode: session.profile?.mode,
    host: session.profile?.host, username: session.profile?.username, port: session.profile?.port,
    hostKey: session.profile?.hostKey, location: location || '' });
  const result = await showReview({
    type: 'warning', buttons: ['Cancel', action === 'install' ? 'Install companion' : 'Authorize connection'], defaultId: 0, cancelId: 0,
    message: action === 'install' ? `Install or update FrostByte on ${dialogText(target)}?` : `Authorize FrostByte on ${dialogText(target)}?`,
    summary: action === 'install'
      ? `Install the companion on ${reviewLabel(target, 100)}.\nDownload folder: ${reviewLabel(location, 200)}`
      : `Add a restricted FrostByte SSH key on ${reviewLabel(target, 100)} for future connections.`,
    detail: action === 'install'
      ? `${exactReviewDetails({ device: target, endpoint: session.profile?.host, downloadFolder: location })}\n\nFrostByte will install its restricted companion at this exact destination.`
      : `${exactReviewDetails({ device: target, endpoint: session.profile?.host })}\n\nFrostByte will add a dedicated restricted SSH key for future connections. It cannot open an unrestricted remote shell.`,
  });
  if (result.response !== 1) return false;
  const current = sparkSetup.getSession(sessionId);
  const currentSnapshot = JSON.stringify({ id: current.id, stage: current.stage, allowed: current.allowed,
    purpose: current.purpose, deviceId: current.deviceId, mode: current.profile?.mode,
    host: current.profile?.host, username: current.profile?.username, port: current.profile?.port,
    hostKey: current.profile?.hostKey, location: location || '' });
  if (current !== session || currentSnapshot !== snapshot) throw new Error('The device setup session changed during review. Review this action again.');
  return true;
}
async function sparkStatusWithInventory({ force = false, deviceId = devices.selectedId } = {}) {
  const result = await devices.refresh(deviceId, { force });
  if (!result.connected) throw new Error(result.error);
  return result.status;
}
function dialogText(value, fallback = 'this item') {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240) : fallback;
}
function exactReviewDetails(fields) {
  const reviewed = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, exactReviewText(value, '(none)')]));
  const digest = createHash('sha256').update(JSON.stringify(reviewed)).digest('hex');
  return `${Object.entries(reviewed).map(([key, value]) => `${key}: ${value}`).join('\n')}\nSHA-256 approval binding: ${digest}`;
}
async function confirmShare({ name, location, device = 'this computer' }) {
  const exact = {
    name: exactReviewText(name, 'Selected files', 1000),
    location: exactReviewText(location, 'Selected files'),
    device: exactReviewText(device, 'this computer', 1000),
  };
  const binding = createHash('sha256').update(JSON.stringify(exact)).digest('hex');
  const result = await showReview({
    type: 'warning',
    buttons: ['Cancel', 'Share with peers'],
    defaultId: 0,
    cancelId: 0,
    message: `Share ${dialogText(name)} with other peers?`,
    summary: `${reviewLabel(device, 100)}\n${reviewLabel(location, 200)}\n\nOffer these files to public torrent peers until you turn sharing off. Only share files you’re allowed to redistribute.`,
    detail: `Name: ${exact.name}\nLocation: ${exact.location}\nDevice: ${exact.device}\nSHA-256 approval binding: ${binding}\n\nThese exact files will be offered to the public torrent swarm. Confirm that you are allowed to redistribute them.`,
  });
  return result.response === 1;
}
async function rememberSparkSetup(result) {
  result.deviceId ||= devices.selectedId;
  result.status = await devices.remember(result.deviceId, result.status);
  return result;
}
const catalog = new Catalog(store);

/* ------------------------------ HuggingFace ----------------------------- */
// HTTP pulls straight from HF, gated repos included. Bounded at 2 at a time
// so a repo with 8 quants doesn't saturate the line on its own.
const hfDownloads = new Map(); // id -> record
const hfQueue = [];
const HF_MAX_CONCURRENT = 2;
let hfActive = 0;
function hfMaxConcurrent() {
  const configured = Number(store?.getSettings?.()?.maxActiveDownloads);
  return Number.isFinite(configured) && configured >= 1 ? Math.min(8, Math.floor(configured)) : HF_MAX_CONCURRENT;
}
let shuttingDown = false;
let hfUnlockNoticeShown = false;
const hfJobs = new Set();
const completionJobs = new Set();
const pendingCompletionRecords = new Map();
function normalizeCompletionIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['file', 'directory'].includes(value.type)
    || typeof value.dev !== 'string' || !/^\d{1,32}$/.test(value.dev)
    || typeof value.ino !== 'string' || !/^\d{1,32}$/.test(value.ino)) return null;
  return { type: value.type, dev: value.dev, ino: value.ino };
}
function normalizeCompletionMove(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !/^[a-f0-9]{40}$/i.test(value.infohash || '')) return null;
  const localPath = candidate => {
    if (typeof candidate !== 'string' || !candidate || candidate.length > 4096 || candidate.includes('\0') || !path.isAbsolute(candidate)) return null;
    if (process.platform === 'win32' && /^(?:\\\\|\/\/|\\[?.]\\)/.test(candidate)) return null;
    return path.resolve(candidate);
  };
  const source = localPath(value.source), destination = localPath(value.destination);
  const sameBasename = process.platform === 'win32'
    ? path.basename(source || '').toLowerCase() === path.basename(destination || '').toLowerCase()
    : path.basename(source || '') === path.basename(destination || '');
  if (!source || !destination || !sameBasename || sameLocalPath(source, destination)) return null;
  const staging = value.staging === undefined ? null : localPath(value.staging);
  if (value.staging !== undefined && (!staging || !sameLocalPath(path.dirname(staging), path.dirname(destination))
    || !/^\.frostbyte-moving-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(path.basename(staging)))) return null;
  const phase = ['prepared', 'publishing', 'published'].includes(value.phase) ? value.phase : 'prepared';
  const manualResolution = value.manualResolution === true;
  const sourceIdentity = normalizeCompletionIdentity(value.sourceIdentity);
  const stagingIdentity = normalizeCompletionIdentity(value.stagingIdentity);
  const destinationIdentity = normalizeCompletionIdentity(value.destinationIdentity);
  if (value.sourceIdentity !== undefined && !sourceIdentity
    || value.stagingIdentity !== undefined && (!staging || !stagingIdentity)
    || value.destinationIdentity !== undefined && !destinationIdentity) return null;
  return { infohash: value.infohash.toLowerCase(), source, destination, ...(staging ? { staging } : {}), phase,
    ...(manualResolution ? { manualResolution: true } : {}),
    ...(sourceIdentity ? { sourceIdentity } : {}), ...(stagingIdentity ? { stagingIdentity } : {}),
    ...(destinationIdentity ? { destinationIdentity } : {}) };
}
const completionMoves = new Map();
for (const value of Array.isArray(store.state.completionMoves) ? store.state.completionMoves.slice(-2000) : []) {
  const move = normalizeCompletionMove(value);
  if (move) completionMoves.set(move.infohash, move);
}
function completionMoveRecords() {
  return [...completionMoves.values()].map(value => ({ ...value,
    ...(value.sourceIdentity ? { sourceIdentity: { ...value.sourceIdentity } } : {}),
    ...(value.stagingIdentity ? { stagingIdentity: { ...value.stagingIdentity } } : {}),
    ...(value.destinationIdentity ? { destinationIdentity: { ...value.destinationIdentity } } : {}),
  }));
}
function canonicalMissingCompletionPath(value) {
  const logical = path.resolve(value);
  let existing = logical;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return logical;
    existing = parent;
  }
  const first = fs.lstatSync(existing);
  const resolvedAncestor = path.resolve(fs.realpathSync(existing));
  const target = fs.lstatSync(resolvedAncestor);
  const rebound = fs.lstatSync(existing);
  const stableAlias = String(first.dev) === String(rebound.dev) && String(first.ino) === String(rebound.ino)
    && first.isSymbolicLink() === rebound.isSymbolicLink()
    && sameLocalPath(fs.realpathSync(existing), resolvedAncestor);
  if ((!first.isDirectory() && !first.isSymbolicLink()) || !target.isDirectory() || target.isSymbolicLink()
    || !stableAlias || !sameLocalPath(fs.realpathSync(resolvedAncestor), resolvedAncestor)) return logical;
  const suffix = path.relative(existing, logical);
  const resolved = path.resolve(resolvedAncestor, suffix);
  const relative = path.relative(resolvedAncestor, resolved);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    ? resolved : logical;
}
function safeCompletionPathState(value) {
  try {
    const logical = path.resolve(value);
    const first = fs.lstatSync(logical);
    if (first.isSymbolicLink()) return { state: 'unsafe', identity: completionPathIdentity(logical), type: '', nlink: first.nlink, resolved: logical };
    const resolved = path.resolve(fs.realpathSync(logical));
    const stat = fs.lstatSync(resolved);
    const identity = completionPathIdentity(resolved);
    const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : '';
    const stable = !stat.isSymbolicLink() && !!type
      && sameCompletionIdentity(completionPathIdentity(logical), identity)
      && sameLocalPath(fs.realpathSync(logical), resolved)
      && sameLocalPath(fs.realpathSync(resolved), resolved);
    const safe = stable && !(stat.isFile() && stat.nlink > 1);
    return { state: safe ? 'present' : 'unsafe', identity, type, nlink: stat.nlink, resolved: stable ? resolved : logical };
  } catch (error) {
    const missing = error.code === 'ENOENT';
    let resolved = path.resolve(value);
    if (missing) {
      try { resolved = canonicalMissingCompletionPath(value); } catch { /* retain the validated lexical path */ }
    }
    return { state: missing ? 'missing' : 'unsafe', identity: null, type: '', nlink: 0, resolved };
  }
}
function transferSessionRecords() {
  const records = new Map((engine?.sessions() ?? []).map(record => [record.infohash, record]));
  for (const [infoHash, record] of pendingCompletionRecords) if (!records.has(infoHash)) records.set(infoHash, record);
  return [...records.values()];
}

let transferPersistenceSuppressed = 0;
let transferPersistRetryTimer = null;
let transferPersistRetryDelay = 1000;
let transferPersistenceDirty = false;
let transferPersistFailureNoted = false;
let persistTransfers = () => { transferPersistenceDirty = true; };
const transferMutations = new TransferMutationCoordinator();
// Settings can wait on OS and router operations. Serialize the whole
// commit/apply/rollback sequence so a failed older request cannot restore a
// snapshot over a newer successful request.
const settingsMutations = new TransferMutationCoordinator();
async function withTransferPersistenceSuppressed(operation) {
  transferPersistenceSuppressed++;
  try { return await operation(); }
  finally {
    transferPersistenceSuppressed--;
    if (!transferPersistenceSuppressed && transferPersistenceDirty) persistTransfers();
  }
}
function withTransferMutation(operation) {
  return transferMutations.run(() => withTransferPersistenceSuppressed(operation));
}
function changedTransferRecords(changes) {
  const byHash = new Map(changes.map(change => [change.infoHash, change]));
  const found = new Set();
  const records = transferSessionRecords().map(record => {
    const change = byHash.get(record.infohash);
    if (!change) return record;
    found.add(record.infohash);
    return { ...record, paused: change.paused,
      ...(typeof change.explicitShare === 'boolean' ? { explicitShare: change.explicitShare } : {}) };
  });
  for (const infoHash of byHash.keys()) if (!found.has(infoHash)) throw new Error('This transfer is no longer available. Refresh and try again.');
  return records;
}
async function applyTransferChanges(changes, operation, rollbackLive, validate) {
  return withTransferMutation(async () => {
    if (validate) await validate();
    const affected = new Set(changes.map(change => change.infoHash));
    const before = new Map(engine.sessions().filter(record => affected.has(record.infohash))
      .map(record => [record.infohash, structuredClone(record)]));
    return applyDurableTransferIntent({
      store,
      transfers: changedTransferRecords(changes),
      completionMoves: completionMoveRecords(),
      run: operation,
      rollbackLive: rollbackLive ? () => rollbackLive(before) : undefined,
    });
  });
}
function recordInventory(register, name) {
  try { register(); return true; }
  catch (error) { note(`Downloaded ${name}, but could not update inventory: ${error.message}`, 'warn'); return false; }
}

function hfTokenGet() {
  const st = store.state;
  if (st.hfTokenEnc && (typeof st.hfTokenEnc !== 'string' || st.hfTokenEnc.length > 65_536
    || st.hfTokenEnc.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(st.hfTokenEnc))) {
    store.setHfCredentialState({ hfTokenEnc: '', hfTokenPlain: undefined, hfTokenMigrationRequired: true, hfUser: '', hfRole: '' });
    return null;
  }
  if (st.hfTokenEnc && safeStorage?.isEncryptionAvailable?.()) {
    try {
      const token = safeStorage.decryptString(Buffer.from(st.hfTokenEnc, 'base64'));
      hfUnlockNoticeShown = false;
      return token;
    } catch {
      // An installation/signature change or denied Keychain prompt can block
      // access temporarily. Preserve the saved ciphertext so a retry can work.
      if (!hfUnlockNoticeShown) {
        hfUnlockNoticeShown = true;
        note(`Could not unlock your HuggingFace token. The saved token was kept. ${credentialRecovery} or reconnect in Settings → HuggingFace.`, 'warn');
      }
      return null;
    }
  }
  return null;
}

function currentHfCredentialContext() {
  const token = hfTokenGet();
  return { token, ...describeSavedHfCredential(store.state, token) };
}

function requireUnchangedHfCredential(expected, message) {
  const current = currentHfCredentialContext();
  if (current.snapshot !== expected.snapshot || current.generation !== expected.generation) throw new Error(message);
  return current;
}

function publicHfTransfer(record) {
  const { controller, authorization, ...value } = record;
  return value;
}

function sameHfQueueSnapshot(snapshot) {
  return snapshot.size === hfDownloads.size
    && [...snapshot].every(([id, record]) => hfDownloads.get(id) === record);
}

function savedHfIdentity() {
  const user = typeof store.state.hfUser === 'string' && store.state.hfUser.length <= 200
    && !/[\x00-\x1f\x7f]/.test(store.state.hfUser) ? store.state.hfUser : '';
  const role = typeof store.state.hfRole === 'string' && store.state.hfRole.length <= 100
    && !/[\x00-\x1f\x7f]/.test(store.state.hfRole) ? store.state.hfRole : '';
  return { hfUser: user, hfRole: role };
}

function migrateLegacyHfToken() {
  if (!Object.hasOwn(store.state, 'hfTokenPlain')) return;
  const raw = store.state.hfTokenPlain;
  const token = typeof raw === 'string' ? raw.trim() : '';
  const encrypted = typeof store.state.hfTokenEnc === 'string' && store.state.hfTokenEnc.length <= 65_536
    && store.state.hfTokenEnc.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(store.state.hfTokenEnc);
  if (encrypted) {
    store.setHfCredentialState({ hfTokenEnc: store.state.hfTokenEnc, hfTokenPlain: undefined,
      hfTokenMigrationRequired: false, ...savedHfIdentity() });
    return;
  }
  if (!token || token.length > 4096 || /[\r\n\0]/.test(token)) {
    store.setHfCredentialState({ hfTokenEnc: '', hfTokenPlain: undefined,
      hfTokenMigrationRequired: !!token, hfUser: '', hfRole: '' });
    return;
  }
  try {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('secure storage unavailable');
    store.setHfCredentialState({ hfTokenEnc: safeStorage.encryptString(token).toString('base64'), hfTokenPlain: undefined,
      hfTokenMigrationRequired: false, ...savedHfIdentity() });
  } catch {
    store.setHfCredentialState({ hfTokenEnc: '', hfTokenPlain: undefined,
      hfTokenMigrationRequired: true, hfUser: '', hfRole: '' });
  }
}

function hfTokenClear() {
  store.setHfCredentialState({ hfTokenEnc: '', hfTokenPlain: undefined,
    hfTokenMigrationRequired: false, hfUser: '', hfRole: '' });
}

let hfPersistRetryTimer = null;
function clearHfPersistRetry() {
  if (hfPersistRetryTimer) clearTimeout(hfPersistRetryTimer);
  hfPersistRetryTimer = null;
}
function persistHf(records = hfDownloads) {
  const previous = store.state.hfDownloads;
  store.state.hfDownloads = [...records.values()].slice(-10_000).map(({ controller, ...record }) => normalizeHfTransferRecord(record));
  try { store._flush(); clearHfPersistRetry(); }
  catch (error) { store.state.hfDownloads = previous; throw error; }
}
function retryHfPersistence() {
  if (hfPersistRetryTimer || shuttingDown) return;
  hfPersistRetryTimer = setTimeout(() => {
    hfPersistRetryTimer = null;
    try { persistHf(); }
    catch { retryHfPersistence(); }
  }, 1000);
  hfPersistRetryTimer.unref?.();
}

function pushHfState() {
  const downloads = [...hfDownloads.values()].map(publicHfTransfer);
  push('hf:progress', { downloads, inventory: inventory.list() });
}

function hfPump() {
  while (!shuttingDown && hfActive < hfMaxConcurrent() && hfQueue.length) {
    const rec = hfQueue.shift();
    if (hfDownloads.get(rec.id) !== rec || rec.status !== 'queued') continue;
    hfActive++;
    const job = hfRun(rec).finally(() => { hfJobs.delete(job); hfActive--; hfPump(); });
    hfJobs.add(job);
    job.catch(err => note(`Could not save download state: ${err.message}`, 'error'));
  }
}

async function hfRun(rec) {
  if (rec.cancelled || rec.status !== 'queued') return; // cancelled while parked
  const previousStartedAt = rec.startedAt;
  rec.controller = new AbortController();
  rec.status = 'active';
  rec.startedAt = Date.now();
  try { persistHf(); }
  catch (error) {
    rec.status = 'error'; rec.startedAt = previousStartedAt; rec.speedBps = 0; rec.etaMs = 0;
    rec.error = `Could not save download state: ${String(error?.message ?? error).slice(0, 3900)}`;
    delete rec.controller;
    try { persistHf(); } catch { retryHfPersistence(); }
    pushHfState();
    return;
  }
  pushHfState();
  try {
    const credential = currentHfCredentialContext();
    verifyHfTransferAuthorization(rec, rec.authorization, credential.generation);
    const approvedToken = credential.token ?? undefined;
    const onProgress = p => {
      Object.assign(rec, p); rec.phase = p.phase || 'downloading';
      pushHfState();
    };
    const approvedRoot = rec.baseDir || path.dirname(path.dirname(rec.dest));
    const dest = hfDestination(approvedRoot, rec.repoId, rec.filePath);
    const hasHybridPartial = fs.existsSync(path.join(dest + '.frosthybrid', 'manifest.json'));
    let identity, plan, peerDeviceContext;
    if (rec.source === 'hybrid' || hasHybridPartial) {
      onProgress({ phase: 'checking-peer', sourceMode: 'hf', sourceNote: 'Checking the selected device for shared files…' });
      try {
        identity = await getHybridIdentity({ ...rec, token: approvedToken, signal: rec.controller.signal });
        if (rec.source === 'hybrid' && identity && store.getSettings().sparkHost) {
          const record = devices.record(rec.peerDeviceId), deviceApproval = devices.approvalSnapshot(rec.peerDeviceId);
          plan = await sparkRequest(sparkProfile(rec.peerDeviceId), { action: 'hf:peer', identity }, { signal: rec.controller.signal });
          if (!devices.isApprovalCurrent(deviceApproval)) {
            throw new Error('The paired device changed while its peer plan was requested.');
          }
          if (plan && identityKey(plan.identity) !== identityKey(identity)) throw new Error('The device returned a different file.');
          peerDeviceContext = { id: rec.peerDeviceId, approval: deviceApproval,
            name: record.name || record.snapshot?.hardware?.name || record.snapshot?.hostname || record.host };
        }
      } catch (error) {
        rec.controller.signal.throwIfAborted();
        rec.sourceNote = 'Device unavailable or companion needs updating; using HuggingFace.';
      }
    }
    const useHybrid = identity && (plan || fs.existsSync(path.join(dest + '.frosthybrid', 'manifest.json')));
    if (hasHybridPartial && !identity) throw new Error('Could not verify the saved partial download against HuggingFace. Check your connection and resume.');
    rec.sourceMode = useHybrid ? 'hybrid' : 'hf';
    if (!useHybrid && !rec.sourceNote?.startsWith('Device unavailable')) rec.sourceNote = rec.source === 'hybrid' ? 'No eligible shared copy on the selected device; using HuggingFace.' : '';
    if (useHybrid) rec.sourceNote = rec.source === 'hybrid' ? 'HF + selected device · receiving only' : 'HuggingFace only · resuming verified pieces';
    const approvePeers = !peerDeviceContext ? undefined : async request => {
      const expected = JSON.stringify(request);
      if (!devices.isApprovalCurrent(peerDeviceContext.approval)) {
        throw new Error('The paired device changed before peer approval.');
      }
      const approval = await showReview(pairedPeerEndpointsReview({
        device: peerDeviceContext.name, ...request,
      }));
      if (approval.response !== 1) return false;
      if (JSON.stringify(request) !== expected
        || !devices.isApprovalCurrent(peerDeviceContext.approval)) {
        throw new Error('The paired device or peer plan changed during review. Review the addresses again.');
      }
      return true;
    };
    const r = useHybrid ? await downloadHybrid({ identity, plan, dest, approvedRoot, client: engine.client,
      token: approvedToken, signal: rec.controller.signal, onProgress, approvePeers }) : await hfDownloadFile({
      repoId: rec.repoId,
      revision: rec.revision,
      filePath: rec.filePath,
      dest,
      approvedRoot,
      expectedSize: rec.total > 0 ? rec.total : undefined,
      expectedSha256: rec.sha256 || undefined,
      token: approvedToken,
      acquireBytes: (bytes, signal) => engine.acquireDownloadBytes(bytes, signal),
      signal: rec.controller.signal,
      onProgress,
    });
    privacy.record('hf_download_done');
    rec.status = 'done';
    rec.downloaded = r.bytes;
    for (const key of ['hfBytes', 'peerBytes', 'resumedBytes']) if (r[key] !== undefined) rec[key] = r[key];
    rec.speedBps = 0;
    const recorded = recordInventory(() => inventory.registerHf(rec), `${rec.repoId}/${rec.filePath}`);
    note(`Finished ${rec.repoId}/${rec.filePath}${recorded ? ' — saved in My Models' : ''}.`);
  } catch (err) {
    // Undici and stream.pipeline can wrap a caller abort in a transport error.
    // The persisted controller intent is authoritative for this worker.
    if (rec.controller?.signal.aborted || err?.name === 'AbortError' || rec.cancelled) {
      rec.status = shuttingDown ? 'queued' : 'paused';
      rec.cancelled = false;
    } else if (err instanceof HfAuthError) {
      rec.status = 'error';
      rec.error = err.status === 401
        ? 'Gated model — add a HuggingFace token in Settings → HuggingFace.'
        : `Access not granted — request it at https://huggingface.co/${rec.repoId}`;
    } else {
      rec.status = 'error';
      rec.error = String(err?.message ?? err).slice(0, 4000);
    }
  }
  if (rec.status === 'error') privacy.record('hf_download_error');
  rec.speedBps = 0;
  rec.etaMs = 0;
  delete rec.controller;
  try { persistHf(); }
  catch (error) {
    retryHfPersistence();
    note(`Could not save final download state: ${String(error?.message ?? error).slice(0, 1000)} Retrying.`, 'error');
  }
  pushHfState();
}
let engine;
let rates;
let queue;
let goals;
let upnp;
let tickTimer = null;
let forceQuit = false;

/* ------------------------------------------------------------------ window */

function createWindow() {
  sourceListenerReady = false;
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    backgroundColor: '#0A0C0B',
    title: EDITION_INFO.displayName,
    icon: path.join(here, '../../assets/brand/app-icon.png'),
    // The classic LimeWire look leaned on its chrome; on macOS we inset the
    // traffic lights and draw our own title bar around them.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });

  win.loadURL(rendererUrl);

  // External links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    Promise.resolve().then(() => openExternal(url)).catch(err => note(err.message, 'warn'));
    return { action: 'deny' };
  });

  win.webContents.on('unresponsive', () => privacy.record('renderer_unresponsive'));
  win.webContents.on('render-process-gone', (_event, details) => { if (!['clean-exit', 'killed'].includes(details.reason)) privacy.record('renderer_exit'); });
  lockDownAppWebContents(win.webContents);

  // Debug/automation: FROSTBYTE_HF_PROBE=<repo> verifies the gated path with
  // the stored token from INSIDE the app (macOS Keychain ACLs block external
  // processes from reading the key), logging statuses only.
  const probeRepo = process.env.FROSTBYTE_HF_PROBE;
  if (allowDebugHfProbe(probeRepo, app.isPackaged)) {
    win.webContents.once('did-finish-load', async () => {
      const tok = hfTokenGet() ?? undefined;
      const who = await hfWhoami(tok ?? '');
      console.log(`[hf-probe] whoami=${who.valid ? who.user : 'invalid'}`);
      for (const repo of probeRepo.split(',')) {
        try {
          const st = await hfStatFile({ repoId: repo.trim(), filePath: 'config.json', token: tok });
          console.log(`[hf-probe] ${repo.trim()} -> OK etag=${st.etag.slice(0, 10)} size=${st.size}`);
        } catch (err) {
          console.log(`[hf-probe] ${repo.trim()} -> ${err.status ?? 'ERR'} ${err.message}`);
        }
      }
    });
  }

  // Debug/automation affordance: FROSTBYTE_TAB=settings opens there at boot (dev/unpackaged only).
  const wantTab = !app.isPackaged ? process.env.FROSTBYTE_TAB : '';
  if (wantTab) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.executeJavaScript(`window.__fbGoTab?.(${JSON.stringify(wantTab)})`).catch(() => {});
    });
  }

  win.on('closed', () => { win = null; sourceListenerReady = false; });
}

function push(channel, payload) {
  try {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  } catch { /* notifications are best-effort while a window is closing */ }
}

function note(message, level = 'ok') {
  console.log(`[notice:${level}] ${message}`);
  const payload = { level, message };
  // Runtime recovery starts before the window. Hold those notices until the
  // renderer has installed its listener and requests launch sources; otherwise
  // a manual-recovery instruction is printed only to the terminal.
  if (!sourceListenerReady) {
    pendingNotices.push(payload);
    if (pendingNotices.length > 100) pendingNotices.shift();
    return;
  }
  push('engine:notice', payload);
}

/* ------------------------------------------------------------------ engine */

function startRuntime() {
  if (engine || !privacy.accepted) return;
  startEngine();
  // Renew a previously approved Hub session in the background so entitlements
  // are fresh on launch. Never blocks startup; failures are handled inside.
  restoreHubSession().catch(() => {});
  const checkUpdates = () => { if (store.getSettings().autoCheckUpdates) updates.check({ automatic: true }).catch(() => {}); };
  checkUpdates();
  updateTimer = setInterval(checkUpdates, 60 * 60 * 1000); updateTimer.unref();
}

function startEngine() {
  const s = store.getSettings();
  engine = new TorrentEngine({ dht: s.dhtEnabled, maxConns: s.maxConns,
    allowPeerAddresses: allowTestPeerAddresses });
  engine.setDownloadPath(s.downloadDir);

  const forward = ['progress', 'done', 'ready', 'peer', 'updated', 'removed', 'seeding'];
  for (const evt of forward) {
    engine.on(evt, (payload) => push('engine:torrent', { event: evt, torrent: payload }));
  }
  // Empty announces are normal for quiet swarms. Show a passive transfer status.
  engine.on('no-peers', () => privacy.record('torrent_no_peers'));
  for (const [event, counter] of [['ready', 'torrent_ready'], ['done', 'torrent_done'], ['torrent-error', 'torrent_error']]) engine.on(event, () => privacy.record(counter));
  engine.on('torrent-error', (p) => note(`Torrent error: ${p.message}`, 'error'));
  engine.on('engine-error', (p) => note(`Engine error: ${p.message}`, 'error'));
  engine.on('engine-warning', (p) => note(p.message, 'warn'));

  const libHashes = () => new Set(store.getLibrary().map((l) => l.infohash));

  rates = new RateManager(engine, () => store.getSettings());
  queue = new QueueManager(engine, () => store.getSettings());
  goals = new SeedGoalManager(engine, () => store.getSettings(), {
    isLibraryHash: (h) => libHashes().has(h),
    onStop: (t, why) => note(
      `${t.name} stopped sharing — hit the ${why === 'ratio' ? 'ratio' : 'seeding-time'} goal you set. Files kept.`,
    ),
  });
  upnp = new UpnpManager({ NatAPI, log: note });

  const completing = new Set();
  // A failed move is restored with completionHandled=false for crash/restart
  // recovery. Block only that restored in-memory session from immediately
  // re-entering the same failure loop; a fresh add gets a new generation.
  const failedCompletionSessions = new Set();
  const completionSessionKey = (infoHash, generation = engine.completionGeneration(infoHash)) => `${infoHash}:${generation}`;
  const blockCurrentCompletionSession = infoHash => {
    const generation = engine.completionGeneration(infoHash);
    if (!generation) return;
    for (const key of failedCompletionSessions) if (key.startsWith(`${infoHash}:`) && key !== completionSessionKey(infoHash, generation)) failedCompletionSessions.delete(key);
    failedCompletionSessions.add(completionSessionKey(infoHash, generation));
    while (failedCompletionSessions.size > 2000) failedCompletionSessions.delete(failedCompletionSessions.values().next().value);
  };
  persistTransfers = () => {
    transferPersistenceDirty = true;
    if (shuttingDown || completing.size || transferPersistenceSuppressed) return;
    try {
      commitTransferIntent(store, transferSessionRecords(), completionMoveRecords());
      transferPersistenceDirty = false;
      if (transferPersistRetryTimer) clearTimeout(transferPersistRetryTimer);
      transferPersistRetryTimer = null;
      transferPersistRetryDelay = 1000;
      transferPersistFailureNoted = false;
    } catch (error) {
      if (!transferPersistRetryTimer) {
        if (!transferPersistFailureNoted) {
          transferPersistFailureNoted = true;
          note(`Could not save transfer state; FrostByte will retry: ${error.message}`, 'error');
        }
        const delay = transferPersistRetryDelay;
        transferPersistRetryDelay = Math.min(60_000, delay * 2);
        transferPersistRetryTimer = setTimeout(() => {
          transferPersistRetryTimer = null;
          persistTransfers();
        }, delay);
        transferPersistRetryTimer.unref?.();
      }
    }
  };
  const persistCompletionRecovery = () => {
    commitTransferIntent(store, transferSessionRecords(), completionMoveRecords());
  };
  for (const event of ['ready', 'updated', 'seeding', 'removed']) engine.on(event, persistTransfers);
  for (const event of ['ready', 'seeding']) engine.on(event, torrent => {
    if (!torrent?.magnetURI || !torrent.dataPath) return;
    try { shareLinks.remember({ id: torrent.inventoryId || 'torrent:' + torrent.infoHash, path: torrent.dataPath, device: 'local' }, torrent); }
    catch (error) { note(`Could not retain the share link: ${error.message}`, 'warn'); }
  });
  engine.on('done', t => {
    if (shuttingDown) return; // the persisted completed session will finish on the next start
    const generation = t.completionGeneration;
    if (!Number.isSafeInteger(generation) || generation <= 0 || engine.completionGeneration(t.infoHash) !== generation) return;
    const completionIdentity = engine.transferIdentity(t.infoHash);
    if (!completionIdentity || completionIdentity.sessionGeneration !== generation) return;
    const sessionKey = completionSessionKey(t.infoHash, generation);
    if (t.explicitShare && !t.inventoryId) recordInventory(() => inventory.registerTorrent(t), t.name);
    if (t.explicitShare || t.completionHandled || completing.has(sessionKey)
      || deferredCompletionRestores.has(t.infoHash)
      || failedCompletionSessions.has(sessionKey)) return;
    // Assumption (documented, round-2 N10): explicitShare sessions skip the
    // completion gate because they were already gated at the enable transition
    // (shareLocalFolder pre-scan / setItemSharing enable path). The gate below
    // covers downloads that complete into a share without that earlier check.
    completing.add(sessionKey);
    const job = withTransferMutation(async () => {
      if (!engine.isCurrentIdentity(completionIdentity)
        || deferredCompletionRestores.has(t.infoHash)
        || failedCompletionSessions.has(sessionKey)) return;
      await finishTorrent(t);
      // The in-memory `completing` guard suppresses a restored torrent's done
      // event during a move. Mark only after success so errors recover on restart.
      engine.markCompletionHandled(t.infoHash);
      pendingCompletionRecords.delete(t.infoHash);
      completionMoves.delete(t.infoHash);
      return true;
    }).then(finished => {
      if (!finished) return;
      // Fresh completions only: the done handler already skips restored
      // (completionHandled) sessions, so this gate never re-runs against a
      // torrent that merely resumed seeding. A stopped share is not restarted.
      void checkCompletedOrigin(t);
    }).catch(err => {
      blockCurrentCompletionSession(t.infoHash);
      note(`Could not finish ${t.name}: ${err.message}`, 'error');
    }).finally(() => {
      completionJobs.delete(job);
      completing.delete(sessionKey);
      persistTransfers();
      try { pushHfState(); } catch { /* renderer may be closing */ }
      enforceQueue().catch(() => {});
    });
    completionJobs.add(job);
  });

  // A finished torrent that carries an AEON model card is held to the origin
  // statement in it. This runs after the completion move, outside the transfer
  // mutation, and only reads files. A copy that fails is not seeded onward.
  async function checkCompletedOrigin(t) {
    const id = 'torrent:' + t.infoHash;
    let originFailed = false;
    try {
      if (originBlocksSharing(await origins.ensure(id))) {
        originFailed = true;
        await setItemSharing({ device: 'local', id, enabled: false });
        note(`${t.name} failed its AEON origin check. Sharing was stopped and the files were kept.`, 'warn');
      }
    } catch (error) { note(`Could not check the AEON origin of ${t.name}: ${error.message}`, 'warn'); }
    // File-integrity: a finished copy that holds a code-executing format is
    // never seeded onward either. Runs for every completion — an origin-clean
    // download must still be scanned before it keeps seeding.
    try {
      if (originFailed) return;
      // Always re-validate through ensure(): it re-checks the folder
      // fingerprint, so a verdict cached at share time cannot bless bytes
      // that changed since (the cache is returned only when bytes match).
      // The key is normalized so it matches shareLocalFolder's pre-scan id.
      const folderId = t.dataPath ? folderIntegrityId(t.dataPath) : null;
      let verdict = null, verdictId = id;
      if (folderId) {
        let files = null;
        try { files = await listFolderFiles(t.dataPath); } catch { /* fall back to the recorded manifest */ }
        if (files) {
          verdict = await integrity.ensure(folderId, { item: { path: t.dataPath, files }, upstream: true });
          if (verdict) verdictId = folderId;
        }
      }
      if (!verdict) verdict = await integrity.ensure(id, { upstream: true });
      if (!integrityBlocksSharing(verdict)) return;
      await setItemSharing({ device: 'local', id, enabled: false });
      // Mirror the confirmed verdict to sibling ids so the cache-only restart
      // re-seed gate (shared: key) blocks this folder on the next launch too.
      const siblings = new Set([id, ...(folderId ? [folderId] : [])]);
      for (const item of store.getLibrary()) {
        if (item.path && t.dataPath && sameLocalPath(item.path, t.dataPath)) siblings.add('shared:' + item.infohash);
      }
      integrity.mirror(verdictId, [...siblings]);
      note(`${t.name} contains a risky file format. Sharing was stopped and the files were kept.`, 'warn');
    } catch (error) { note(`Could not check the integrity of ${t.name}: ${error.message}`, 'warn'); }
  }

  async function finishTorrent(t) {
    const cur = store.getSettings();
    recordInventory(() => inventory.registerTorrent(t), t.name);
    if (cur.moveCompleted && cur.completedDir && t.dataPath && !sameLocalPath(t.path, cur.completedDir)) {
      const record = engine.sessions().find(r => r.infohash === t.infoHash);
      if (!record) throw new Error('Could not preserve the completed transfer for recovery.');
      // Canonicalize and bind both roots while the protected torrent store is
      // still open. The completion journal never depends on a mutable alias.
      const prepared = prepareCompletionMove(t.dataPath, cur.completedDir);
      if (sameLocalPath(path.dirname(prepared.source), prepared.destinationRoot)) {
        if (!cur.seedOnComplete) {
          await engine.remove(t.infoHash, false);
          note(`${t.name} finished — sharing stopped. Files kept.`);
        }
        return;
      }
      record.path = path.dirname(prepared.source);
      const move = normalizeCompletionMove({ infohash: t.infoHash, source: prepared.source,
        destination: path.join(prepared.destinationRoot, path.basename(prepared.source)),
        staging: path.join(prepared.destinationRoot, `.frostbyte-moving-${randomUUID()}`),
        sourceIdentity: prepared.sourceIdentity, phase: 'prepared' });
      if (!move) throw new Error('Could not record a safe completed-file move.');
      completionMoves.set(t.infoHash, move);
      pendingCompletionRecords.set(t.infoHash, structuredClone(record));
      persistCompletionRecovery();
      // Close the chunk store before touching files, then reopen identical metadata.
      await engine.remove(t.infoHash, false);
      let moveError = null;
      try {
        const res = await moveCompleted(move.source, prepared.destinationRoot, { stagingPath: move.staging,
          expectedSourceIdentity: prepared.sourceIdentity,
          expectedDestinationIdentity: prepared.destinationIdentity,
          afterStage: ({ staging, stagingIdentity, destination, sourceIdentity }) => {
            if (staging !== move.staging || destination !== move.destination || !sameCompletionIdentity(sourceIdentity, move.sourceIdentity)) {
              throw new Error('The completed-file staging path changed unexpectedly.');
            }
            move.stagingIdentity = stagingIdentity; move.phase = 'prepared';
            persistCompletionRecovery();
          },
          beforePublish: ({ staging, stagingIdentity, destination }) => {
          if (staging !== move.staging || destination !== move.destination) throw new Error('The completed-file publication path changed unexpectedly.');
          if (stagingIdentity && !sameCompletionIdentity(stagingIdentity, move.stagingIdentity)) throw new Error('The completed-file staging identity changed unexpectedly.');
          move.phase = 'publishing';
          persistCompletionRecovery();
          },
          onDestinationCreated: ({ destination, destinationIdentity }) => {
            if (destination !== move.destination) throw new Error('The completed destination changed unexpectedly.');
            move.destinationIdentity = destinationIdentity; move.phase = 'publishing';
            persistCompletionRecovery();
          },
          afterPublish: ({ destination, destinationIdentity }) => {
            if (destination !== move.destination || !sameCompletionIdentity(destinationIdentity, move.destinationIdentity)) {
              throw new Error('The completed destination identity changed unexpectedly.');
            }
            record.path = path.dirname(destination); move.phase = 'published';
            pendingCompletionRecords.set(t.infoHash, structuredClone(record));
            persistCompletionRecovery();
          },
          onDestinationRemoved: ({ destination, destinationIdentity }) => {
            if (destination !== move.destination || !sameCompletionIdentity(destinationIdentity, move.destinationIdentity)) {
              throw new Error('The interrupted completed destination changed unexpectedly.');
            }
            delete move.destinationIdentity; move.phase = 'prepared'; record.path = path.dirname(move.source);
            pendingCompletionRecords.set(t.infoHash, structuredClone(record));
            persistCompletionRecovery();
          },
        });
        if (res.moved) {
          record.path = path.dirname(res.dest);
          move.destination = res.dest; move.phase = 'published'; delete move.staging; delete move.stagingIdentity;
          pendingCompletionRecords.set(t.infoHash, structuredClone(record));
          persistCompletionRecovery();
          recordInventory(() => inventory.registerTorrent({ ...t, path: record.path, dataPath: res.dest }), t.name);
          note(res.cleanupWarning
            ? `${t.name} moved to ${cur.completedDir}, but the original could not be cleaned up: ${res.cleanupWarning}`
            : `${t.name} moved to ${cur.completedDir}.`, res.cleanupWarning ? 'warn' : undefined);
        } else throw new Error(`Did not move ${t.name}: ${res.reason}.`);
      } catch (error) {
        moveError = error;
      }
      let canRestore = true;
      if (moveError?.completionRecoveryRequired) {
        const recoverableSource = safeCompletionPathState(move.source);
        canRestore = recoverableSource.state === 'present'
          && sameCompletionIdentity(recoverableSource.identity, move.sourceIdentity);
        if (canRestore) {
          record.path = path.dirname(recoverableSource.resolved);
          pendingCompletionRecords.set(t.infoHash, structuredClone(record));
          persistCompletionRecovery();
        }
      }
      if ((cur.seedOnComplete || moveError) && canRestore) {
        try {
          // Suppress the restored torrent's immediate done event only when the
          // move itself succeeded. Failed moves remain retryable after restart.
          await engine.restore({ ...record, completionHandled: !moveError });
          pendingCompletionRecords.delete(t.infoHash);
          if (moveError && !moveError.completionRecoveryRequired) completionMoves.delete(t.infoHash);
        } catch (restoreError) {
          persistCompletionRecovery();
          if (moveError) throw new AggregateError([moveError, restoreError], 'The completed files could not be moved and the transfer could not be restored. It will be recovered after restart.');
          throw restoreError;
        }
      } else if (moveError && !canRestore) {
        // The durable journal is the only safe authority left. Do not reopen
        // WebTorrent against a destination that may have been replaced.
        persistCompletionRecovery();
      } else if (!moveError) {
        pendingCompletionRecords.delete(t.infoHash);
      }
      if (moveError) throw moveError;
    } else if (!cur.seedOnComplete) {
      await engine.remove(t.infoHash, false);
      note(`${t.name} finished — sharing stopped. Files kept.`);
    }
  }

  const saved = [...(store.state.transfers ?? [])];
  const savedByHash = new Map(saved.filter(item => item && typeof item === 'object').map(item => [item.infohash, item]));
  const blockedCompletionRestores = new Set();
  const deferredCompletionRestores = new Set();
  for (const [infoHash, move] of completionMoves) {
    const item = savedByHash.get(infoHash);
    if (!item || typeof item.path !== 'string') { completionMoves.delete(infoHash); continue; }
    const currentState = safeCompletionPathState(item.path);
    const current = currentState.resolved;
    let sourceState = safeCompletionPathState(move.source);
    let destinationState = safeCompletionPathState(move.destination);
    let stagingState = move.staging ? safeCompletionPathState(move.staging)
      : { state: 'missing', identity: null, type: '', nlink: 0 };
    const candidateMove = { ...move,
      ...(sourceState.resolved ? { source: sourceState.resolved } : {}),
      ...(destinationState.resolved ? { destination: destinationState.resolved } : {}),
      ...(move.staging && stagingState.resolved ? { staging: stagingState.resolved } : {}),
    };
    const canonicalMove = normalizeCompletionMove(candidateMove);
    if (!canonicalMove) {
      item.paused = true;
      blockedCompletionRestores.add(infoHash);
      note(`Could not safely canonicalize the interrupted completed-file move for ${item.name || infoHash}; no files were removed.`, 'error');
      continue;
    }
    Object.assign(move, canonicalMove);
    const sourceRoot = path.dirname(move.source), destinationRoot = path.dirname(move.destination);
    if (!sameLocalPath(current, sourceRoot) && !sameLocalPath(current, destinationRoot)) { completionMoves.delete(infoHash); continue; }

    // A file publish is one exclusive hard-link operation. If the process was
    // killed before its inode could be journaled, matching source/staging and
    // destination identities prove that the destination is already complete.
    const linkedPhase = move.phase === 'publishing' || move.phase === 'published';
    const exactPublishedDestination = move.phase !== 'published'
      || sameCompletionIdentity(destinationState.identity, move.destinationIdentity);
    const directLinkedPublication = linkedPhase && exactPublishedDestination && sourceState.type === 'file'
      && destinationState.type === 'file' && sameCompletionIdentity(sourceState.identity, destinationState.identity)
      && (!move.sourceIdentity || sameCompletionIdentity(sourceState.identity, move.sourceIdentity));
    const stagedLinkedPublication = linkedPhase && exactPublishedDestination && stagingState.type === 'file'
      && destinationState.type === 'file' && sameCompletionIdentity(stagingState.identity, destinationState.identity)
      && sameCompletionIdentity(stagingState.identity, move.stagingIdentity);
    // onDestinationCreated durably records the exact destination inode before
    // either hard-link name can be cleaned up. If a crash leaves only the
    // destination name, its identity still proves that this is the reviewed
    // source/staging inode; deleting it here would delete the last copy.
    const journaledLinkedPublication = linkedPhase && destinationState.type === 'file'
      && sameCompletionIdentity(destinationState.identity, move.destinationIdentity)
      && (sameCompletionIdentity(destinationState.identity, move.sourceIdentity)
        || sameCompletionIdentity(destinationState.identity, move.stagingIdentity));
    const recoveredPublishedFile = directLinkedPublication || stagedLinkedPublication || journaledLinkedPublication;

    // A journaled destination in publishing phase is an owned partial tree.
    // Remove only the exact inode we reserved; an unrelated replacement is
    // never traversed. Complete linked files are promoted instead.
    if (move.phase === 'publishing' && move.destinationIdentity
      && sameCompletionIdentity(destinationState.identity, move.destinationIdentity) && !recoveredPublishedFile) {
      try {
        if (removeOwnedCompletionPathSync(move.destination, move.destinationIdentity)) {
          destinationState = safeCompletionPathState(move.destination);
          delete move.destinationIdentity; move.phase = 'prepared';
        }
      } catch (error) { note(`Could not clean an interrupted completed destination: ${error.message}`, 'warn'); }
    }

    let recovery = completionRecoveryDisposition(move, { sourceState, destinationState, recoveredPublishedFile });
    if (recovery.published) {
      // A live hard-link is sufficient proof even if the crash happened just
      // before onDestinationCreated journaled its inode. Persist that proof
      // and the destination-root session path before removing any other name,
      // so a second crash cannot leave the sole copy unproven.
      if (recoveredPublishedFile) move.destinationIdentity = destinationState.identity;
      delete move.manualResolution;
      move.phase = 'published'; item.path = destinationRoot; item.completionHandled = false;
      commitTransferIntent(store, saved, completionMoveRecords());
      // Only a current hard-link identity proves that removing the other name
      // retains the same file. Independent source/staging trees are preserved
      // across restart because their contents may have changed without their
      // root inode changing.
      if (recoveredPublishedFile) {
        for (const [field, identityField, label] of [
          ['staging', 'stagingIdentity', 'staging copy'], ['source', 'sourceIdentity', 'original completed files'],
        ]) {
          const value = move[field], identity = move[identityField];
          if (!value || !identity) continue;
          const state = safeCompletionPathState(value);
          // A linked staging file proves only that staging can be unlinked;
          // a linked source proves only that source can be unlinked. Never
          // delete an independent path merely because another path proved the
          // destination publication.
          if (!sameCompletionIdentity(state.identity, identity)
            || !sameCompletionIdentity(state.identity, destinationState.identity)) continue;
          try {
            if (removeOwnedCompletionPathSync(value, identity, null, { beforeRemove: () => {
              const liveDestination = safeCompletionPathState(move.destination);
              if (!sameCompletionIdentity(liveDestination.identity, move.destinationIdentity)) {
                throw new Error('The completed destination changed before recovery cleanup.');
              }
            } }) && field === 'staging') {
              delete move.staging; delete move.stagingIdentity;
            }
          } catch (error) { note(`Could not clean the ${label} after publication: ${error.message}`, 'warn'); }
        }
      }
      destinationState = safeCompletionPathState(move.destination);
      if (!sameCompletionIdentity(destinationState.identity, move.destinationIdentity)) {
        // Cleanup is guarded by the destination inode and can deliberately
        // restore a claimed source when that inode disappears. Do not then
        // reopen WebTorrent against the missing or unrelated destination.
        sourceState = safeCompletionPathState(move.source);
        const exactSourceRemains = sourceState.state === 'present'
          && sameCompletionIdentity(sourceState.identity, move.sourceIdentity);
        if (exactSourceRemains) {
          item.path = sourceRoot;
          move.manualResolution = true;
          deferredCompletionRestores.add(infoHash);
          note(`The completed destination for ${item.name || infoHash} changed during recovery. The original files were kept. Remove or rename the destination, then restart FrostByte to retry safely.`, 'warn');
        } else {
          item.paused = true;
          blockedCompletionRestores.add(infoHash);
          note(`The completed destination for ${item.name || infoHash} changed during recovery, and no exact original path remains. No further files were removed.`, 'error');
        }
      }
    } else {
      // Prepared staging belongs to this move only when its recorded inode
      // still matches. A replacement at the same UUID path is left untouched.
      if (move.staging && move.stagingIdentity && sourceState.state === 'present'
        && sameCompletionIdentity(stagingState.identity, move.stagingIdentity)) {
        try {
          if (removeOwnedCompletionPathSync(move.staging, move.stagingIdentity)) {
            delete move.staging; delete move.stagingIdentity; move.phase = 'prepared';
          }
        } catch (error) { note(`Could not clean an interrupted completed-file copy: ${error.message}`, 'warn'); }
      }
      sourceState = safeCompletionPathState(move.source);
      recovery = completionRecoveryDisposition(move, { sourceState, destinationState, recoveredPublishedFile: false });
      if (recovery.recoverSource) {
        item.path = sourceRoot;
        const destinationConflict = destinationState.state !== 'missing';
        if (destinationConflict) {
          // Keep the original phase and inode proof. This is a durable manual
          // resolution state: every restored generation is suppressed while
          // the conflicting destination exists. Removing or renaming that
          // destination lets the next startup retry from the preserved source.
          const newlyBlocked = !move.manualResolution;
          move.manualResolution = true;
          deferredCompletionRestores.add(infoHash);
          if (newlyBlocked) note(`The interrupted completed-file move for ${item.name || infoHash} needs review. Both the original and destination were kept. Remove or rename the destination, then restart FrostByte to retry safely.`, 'warn');
        } else {
          delete move.manualResolution;
          move.phase = 'prepared';
        }
      } else if (recovery.recoveryRequired) {
        item.paused = true;
        blockedCompletionRestores.add(infoHash);
        note(`Could not safely recover the completed files for ${item.name || infoHash}. The recorded paths changed or are missing; no files were removed.`, 'error');
      }
    }
  }
  commitTransferIntent(store, saved, completionMoveRecords());
  for (const item of saved) {
    if (blockedCompletionRestores.has(item.infohash)) continue;
    withTransferMutation(() => engine.restore(item))
      .then(() => {
        if (deferredCompletionRestores.delete(item.infohash)) blockCurrentCompletionSession(item.infohash);
      })
      .catch(err => {
        deferredCompletionRestores.delete(item.infohash);
        note(`Could not restore ${item.name}: ${err.message}`, 'warn');
      });
  }
  for (const item of store.getLibrary()) {
    if (saved.some(t => t.infohash === item.infohash)) continue;
    // Confirmed-risky or origin-blocked shared folders are never re-seeded at
    // launch. Cache-only check: unscanned folders keep their previous behavior
    // (never blocked). Parity with the resume/share gates: BOTH verdicts.
    if (originBlocksSharing(origins.get('shared:' + item.infohash))) {
      note(`${item.name} was not re-shared: its origin check blocked sharing.`, 'warn');
      continue;
    }
    if (integrityBlocksSharing(integrity.get('shared:' + item.infohash))) {
      note(`${item.name} was not re-shared: its integrity scan found a risky file format.`, 'warn');
      continue;
    }
    withTransferMutation(async () => {
      await engine.seed(item.path, { name: item.name, inventoryId: 'shared:' + item.infohash, announce: extraTrackers() });
      commitTransferIntent(store, transferSessionRecords(), completionMoveRecords());
    }).catch(err => note(`Could not resume seeding ${item.name}: ${err.message}`, 'warn'));
  }
  for (const item of store.state.hfDownloads ?? []) {
    try {
      const rec = normalizeHfTransferRecord(item, { forRestore: true, defaultPeerDeviceId: devices.selectedId });
      if (rec.status === 'cancelled') { rec.status = 'paused'; rec.cancelled = false; }
      if (rec.status === 'queued') { rec.cancelled = false; hfQueue.push(rec); }
      hfDownloads.set(rec.id, rec);
    } catch (err) { note(`Could not restore an HTTP transfer: ${err.message}`, 'warn'); }
  }
  persistHf();
  inventory.migrateHf([...hfDownloads.values()]);
  rates.apply();
  hfPump();
  enforceQueue().catch(() => {});
  engine.on('ready', () => enforceQueue().catch(() => {}));
  maybeMapUpnp().catch(() => {});

  tickTimer = setInterval(async () => {
    try {
      await withTransferMutation(async () => {
        await tick({ engine, rates, queue, goals });
        commitTransferIntent(store, transferSessionRecords(), completionMoveRecords());
      });
      // Checkpoint cumulative seed time and upload bytes so an unexpected
      // restart loses at most one background interval of goal accounting.
      persistTransfers();
      await maybeMapUpnp();
      if (goals && engine.list().length) push('engine:torrent', { event: 'tick', torrent: null });
    } catch (err) {
      note(`Background task failed: ${err.message}`, 'error');
    }
  }, TICK_MS);
}

async function enforceQueue() {
  if (!queue || shuttingDown) return { active: 0, paused: 0 };
  return withTransferMutation(async () => {
    const result = await queue.enforce();
    commitTransferIntent(store, transferSessionRecords(), completionMoveRecords());
    return result;
  });
}

function maybeMapUpnp() {
  const s = store.getSettings();
  if (!s.upnpEnabled) return Promise.resolve(false);
  const port = engine?.port;
  if (!port || shuttingDown) return Promise.resolve(false);
  return upnp.enable(port).catch(err => { note(err.message, 'warn'); throw err; });
}

function extraTrackers() {
  return parseTrackerList(store.getSettings().extraTrackers);
}

function currentState() {
  const torrents = engine ? engine.list() : [];
  const annotated = catalog.annotate(catalog.all(), torrents);
  const upnpStatus = upnp?.status?.() ?? { mappedPort: null, cleanupPendingPort: null };
  return {
    torrents,
    catalog: annotated,
    settings: store.getSettings(),
    confirmations: confirmations.snapshot(),
    library: store.getLibrary(),
    inventory: inventory.list(),
    hiddenItems: entryLifecycle.hidden,
    entryOperations: entryLifecycle.operations,
    retainedHf: (store.state.retainedHf || []).map(publicHfTransfer),
    savedShareLinks: store.state.savedShareLinks || [],
    portableLinks: store.state.portableLinks || [],
    linkJobs: shareLinks.snapshot(),
    publishing: publishing.snapshot(),
    modelLibrary: modelLibrary.snapshot(),
    ipfs: ipfs.snapshot(),
    aeonOrigins: origins.snapshot(),
    aeonIntegrity: integrity.snapshot(),
    itemKinds: store.getItemKinds(),
    sparkInventory: devices.list().find(device => device.id === devices.selectedId)?.status,
    devices: devices.list(), selectedDeviceId: devices.selectedId, localDevice,
    appDir: store.appDir,
    platform: process.platform,
    version: app.getVersion(),
    edition: EDITION_INFO,
    updates: updates.snapshot(),
    privacy: privacy.status(),
    // Live network facts for the status bar. All defensive: a dead DHT must
    // read as "0 nodes", not as a crash. (dht.nodes is a KBucket whose
    // `count` is a *method* — calling it matters, or a function ends up in
    // the IPC payload and structured-clone rejects the whole state object.)
    stats: {
      dhtNodes: engine?.dhtNodeCount ?? 0,
      port: engine?.port ?? null,
      upnpMapped: upnpStatus.mappedPort,
      upnpCleanupPending: upnpStatus.cleanupPendingPort,
      uptimeS: Math.floor(process.uptime()),
    },
    rates: rates?.snapshot() || { mode: 'normal', alt: false, down: -1, up: -1 },
    sharingCapacity: torrentDescriptorBudgetSnapshot(),
    publisher: publisherPublicState(),
    hubAccount: getHubAccountStore(store),
    hubEntitlement: getHubEntitlementStore(store),
    hubConfig: getHubConfigStore(store),
    hfToken: (() => {
      const st = store.state;
      const user = typeof st.hfUser === 'string' && st.hfUser.length <= 200 ? st.hfUser : '';
      const role = typeof st.hfRole === 'string' && st.hfRole.length <= 100 ? st.hfRole : '';
      return { present: typeof st.hfTokenEnc === 'string' && st.hfTokenEnc.length > 0 && st.hfTokenEnc.length <= 65_536,
        needsReconnect: st.hfTokenMigrationRequired === true, user, role };
    })(),
    downloads: [...hfDownloads.values()].map(publicHfTransfer),
  };
}

function knownRevealPaths() {
  const settings = store.getSettings();
  return [
    store.appDir, settings.downloadDir, settings.completedDir,
    ...store.getLibrary().map(item => item?.path),
    ...inventory.list().flatMap(item => [item?.path, item?.destination]),
    ...modelLibrary.list().filter(item => item.device === 'local').map(item => item.path),
    ...(engine?.list() ?? []).flatMap(item => [item?.path, item?.dataPath]),
    ...[...hfDownloads.values()].flatMap(item => [item?.dest, item?.baseDir]),
    ...ipfs.snapshot().downloads.map(item => item.dest),
  ].filter(Boolean);
}

function revealKnownPath(target) {
  const local = approvedRevealPath(target, knownRevealPaths());
  shell.showItemInFolder(local);
  return true;
}

/* --------------------------------------------------------------------- IPC */

const handle = (channel, fn, { notifyErrors = true, withEvent = false } = {}) => ipcMain.handle(channel, async (_e, ...args) => {
  try {
    const contents = win && !win.isDestroyed() ? win.webContents : null;
    if (!isAuthorizedAppIpc(_e, contents, rendererUrl)) throw new Error('Only the application window can perform this action.');
    // Background refreshes can arrive while accepted work is draining. Reject
    // them without creating a new error notice during an intentional quit.
    if (shuttingDown) return { ok: false, error: 'FrostByte is shutting down. Try again after restarting.' };
    if (!privacy.accepted && !['app:state', 'privacy:status', 'privacy:documents', 'privacy:accept', 'privacy:quit', 'shell:openExternal', 'hub:logout'].includes(channel)) throw new Error('Accept the FrostByte 1.0 terms and privacy notice before using FrostByte.');
    const run = () => fn(...args, ...(withEvent ? [_e] : []));
    const service = ['hf:search', 'hf:facets', 'hf:model', 'hf:refs', 'hf:readme', 'hf:card-image'].includes(channel) ? 'hf' : ['spark:connect', 'spark:setup-probe', 'spark:setup-connect'].includes(channel) ? 'spark' : null;
    return { ok: true, data: await (service ? privacy.measure(service, run) : run()) };
  } catch (err) {
    if (notifyErrors) note(err?.message ?? String(err), 'error');
    return { ok: false, error: err?.message ?? String(err), ...(typeof err?.code === 'string' && err.code ? { code: err.code } : {}) };
  }
});

registerIpfsHandlers({ handle, local: ipfs, devices, requestRemote: sparkRequest, store, pathCapabilities, currentState, integrity,
  confirm: async (message, detail, action, presentation = {}) => (await showReview({ type: 'question', buttons: ['Cancel', action], defaultId: 0, cancelId: 0, message, detail, ...presentation })).response === 1,
});
registerNetworkDevices({ handle, service: networkDevices });
handle('aeon:integrity-scan', async ({ id, upstream = true } = {}) => {
  if (typeof id !== 'string' || !id) throw new Error('Choose a downloaded model to scan.');
  const result = await integrity.ensure(id, { upstream: upstream !== false, force: true });
  if (!result) throw new Error('That item has no local files to scan.');
  // A user-triggered scan that confirms a risky format revokes the live share,
  // exactly like the completion gate — a confirmed-risky copy must not keep
  // seeding just because it was shared before the scan ran. Revocation is
  // keyed by PATH, not the scanned id: discovered-model (scan:) and IPFS ids
  // cannot be resolved by localItem(), while the live seeding session is an
  // inventory/library row. The verdict is mirrored to sibling ids so the
  // cache-only restart re-seed gate blocks under the key it checks.
  if (integrityBlocksSharing(result)) {
    let revoked = false;
    const siblings = new Set([id]);
    // The model's OWN asset path — not the fingerprint root. Inventory rows
    // fingerprint from row.destination (the downloads dir) and scan: rows from
    // the scan location root; matching shares against those would miss the
    // actual model folder (or over-match every sibling download).
    let root = null;
    try {
      if (id.startsWith('scan:')) root = modelLibrary.entry(id).path;
      else if (id.startsWith('ipfs:')) { const job = ipfs.record(id); if (job.destination && job.folder) root = path.join(job.destination, job.folder); }
      else if (id.startsWith('shared:')) root = store.getLibrary().find(item => 'shared:' + item.infohash === id)?.path || null;
      else root = inventory.list({ refresh: true }).find(item => item.id === id)?.path || null;
    } catch { root = null; }
    // A share is affected when its tree contains the risky model's bytes or
    // sits inside them: a single-file gguf model discovered inside a shared
    // folder must revoke that folder's seed too.
    const normKey = value => { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
    const pathsOverlap = (a, b) => { const x = normKey(a), y = normKey(b); return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep); };
    if (id.startsWith('ipfs:')) {
      try { await ipfs.sharing(id, false); revoked = true; } catch { /* not published */ }
    }
    if (root) {
      siblings.add(folderIntegrityId(root));
      for (const row of inventory.list({ refresh: true })) {
        if (row.path && pathsOverlap(row.path, root)) {
          siblings.add(row.id);
          try { await setItemSharing({ device: 'local', id: row.id, enabled: false }); revoked = true; } catch { /* not shareable */ }
        }
      }
      for (const item of store.getLibrary()) {
        if (item.path && pathsOverlap(item.path, root)) {
          const sharedId = 'shared:' + item.infohash;
          siblings.add(sharedId);
          try { await setItemSharing({ device: 'local', id: sharedId, enabled: false }); revoked = true; } catch { /* not shareable */ }
        }
      }
      for (const t of engine.list()) {
        if (!t.dataPath || !pathsOverlap(t.dataPath, root)) continue;
        siblings.add('torrent:' + t.infoHash);
        if (t.inventoryId) continue; // revoked via its inventory/shared row above
        if (t.seeding || t.explicitShare) {
          // Unregistered explicit share: revoke at the engine level.
          try {
            await withTransferMutation(async () => {
              await engine.setSharing(t.infoHash, false);
              commitTransferIntent(store, transferSessionRecords(), completionMoveRecords());
            });
            revoked = true;
          } catch { /* session gone */ }
        }
      }
    } else {
      try { await setItemSharing({ device: 'local', id, enabled: false }); revoked = true; } catch { /* not shareable */ }
    }
    integrity.mirror(id, [...siblings]);
    if (revoked) note('Sharing was stopped: the integrity scan found a file that can run code when loaded.', 'warn');
    else note('The scan found a file that can run code when loaded, but FrostByte could not resolve its live share to stop it. Check My Models and stop sharing it manually.', 'warn');
  }
  return { integrity: integrity.summary(id), state: currentState() };
});
handle('aeon:open', async ({ deviceId, tool } = {}) => {
  const refreshed = await devices.refresh(deviceId, { force: true });
  if (!refreshed.connected) throw new Error('Reconnect this AEON device first.');
  const record = devices.list().find(device => device.id === deviceId);
  const approved = devices.approvalSnapshot(deviceId);
  const url = aeonDeviceUrl(record, devices.profile(deviceId), tool);
  const result = await showReview({ type: 'question', buttons: ['Cancel', 'Open AEON'], defaultId: 0, cancelId: 0,
    summary: `${reviewLabel(record.name || record.host)}\n${reviewLabel(url, 200)}\n\nOpen this device’s console in your browser.`,
    message: 'Open this device’s AEON console?', detail: exactReviewDetails({ device: record.name || record.host, url }) + '\n\nYour browser will open this device. Sign in to AEON there; FrostByte does not receive its administrator credentials.' });
  if (result.response !== 1) return { cancelled: true };
  if (!devices.isApprovalCurrent(approved)) throw new Error('The device changed during review.');
  await shell.openExternal(url); return true;
});
handle('app:state', () => currentState());
handle('confirmations:reset', () => {
  const result = confirmations.reset();
  torrentDiscoveryAuthorizations.clear();
  return result;
});
handle('updates:check', () => updates.check());
handle('updates:download', () => {
  if (!updateDownloadUrl) throw new Error('Public beta downloads are unavailable right now.');
  return openExternal(updateDownloadUrl);
});
handle('privacy:status', () => privacy.status());
handle('privacy:documents', () => legalDocuments);
handle('privacy:accept', async value => {
  const status = privacy.status();
  privacy.validateAcceptance(value);
  const before = JSON.stringify(privacy.consent);
  const approval = await showReview(privacyAcceptanceReview({
    termsVersion: status.termsVersion, privacyVersion: status.privacyVersion,
  }));
  if (approval.response !== 1) return { ...privacy.status(), cancelled: true };
  if (JSON.stringify(privacy.consent) !== before) throw new Error('Privacy choices changed during review. Review the current notices again.');
  privacy.accept(value);
  startRuntime();
  return { ...privacy.status(), cancelled: false };
});
handle('privacy:quit', () => { app.quit(); return true; });
// Retired reporting channels fail closed for stale renderer code. GitHub
// feedback is an explicit external link, with no prefilled app data.
handle('privacy:diagnostics', value => ({ ...privacy.setEnabled(value), cancelled: false }));
handle('privacy:preview', () => privacy.preview());
handle('feedback:prepare', value => privacy.prepareFeedback(value));
handle('feedback:send', id => privacy.submitFeedback(id));
handle('feedback:discard', () => { privacy.discardFeedback(); return true; });
handle('clipboard:write', async value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || value.includes('\0')) throw new Error('There is no valid text to copy.');
  const approval = await showReview(clipboardWriteReview(value));
  if (approval.response !== 1) return { cancelled: true };
  await clipboard.writeText(value);
  return { cancelled: false };
});
handle('app:sources', () => {
  sourceListenerReady = true;
  for (const authUrl of pendingAuthUrls.splice(0)) {
    completeDesktopAuthUrl(authUrl).catch((err) => push('hub:auth-status', { status: 'error', message: err.message }));
  }
  for (const payload of pendingNotices.splice(0)) push('engine:notice', payload);
  return pendingSources.deliverNext();
});
handle('app:source-ack', id => {
  const result = pendingSources.acknowledge(id);
  if (result.pending && sourceListenerReady) push('app:source');
  return result;
});

handle('devices:status', async force => devices.refreshAll({ force: force === true }));
handle('devices:select', id => { devices.select(id); return currentState(); });
handle('devices:configure', (id, options) => { devices.configure(id, options); return currentState(); });
handle('devices:forget', async id => {
  const record = devices.record(id), deviceApproval = devices.approvalSnapshot(id);
  const approval = await showReview(deviceAccessRemovalReview({
    device: record.name || record.snapshot?.hardware?.name || record.snapshot?.hostname || record.host,
    host: record.host,
  }));
  if (approval.response !== 1) return { cancelled: true, state: currentState() };
  if (!devices.isApprovalCurrent(deviceApproval)) {
    throw new Error('The saved device changed during review. Review the removal again.');
  }
  await devices.revoke(id, deviceApproval);
  devices.forget(id);
  return { cancelled: false, state: currentState() };
});
let assistant;
app.whenReady().then(async () => {
  const { registerAssistant } = await import('./assistant.js');
  assistant = registerAssistant({ handle, devices, modelLibrary });
}).catch(error => console.error('Assistant registration failed:', error?.message || error));

handle('devices:forget-local', async id => {
  const record = devices.record(id), deviceApproval = devices.approvalSnapshot(id);
  const choice = await showReview({
    type: 'warning',
    buttons: ['Keep connection', 'Forget locally'],
    defaultId: 0,
    cancelId: 0,
    message: `Leave ${dialogText(record.name || record.host)} authorized?`,
    summary: `${reviewLabel(record.host)}\n\nForget this connection locally. The device’s key remains authorized until you remove it on the device.`,
    detail: `${exactReviewDetails({ device: record.name || record.host, endpoint: record.host })}\n\nThe device did not confirm removal of FrostByte’s key. Forgetting locally leaves that key authorized. Remove its FrostByte line from ~/.ssh/authorized_keys on the device manually.`,
  });
  if (choice.response !== 1) return { forgotten: false, state: currentState() };
  if (!devices.isApprovalCurrent(deviceApproval)) {
    throw new Error('The saved device changed during review. Review the local removal again.');
  }
  devices.forget(id);
  return { forgotten: true, state: currentState() };
});
handle('devices:update', async id => {
  const record = devices.record(id), deviceApproval = devices.approvalSnapshot(id);
  const status = await sparkStatusWithInventory({ deviceId: id, force: true });
  const approvedDir = status.downloadDir;
  const approval = await showReview({
    type: 'warning', buttons: ['Cancel', 'Update companion'], defaultId: 0, cancelId: 0,
    message: `Update FrostByte on ${dialogText(record.name || record.host)}?`,
    summary: `Replace the companion on ${reviewLabel(record.host)}.\n\nExisting downloads stay on the device.`,
    detail: `${exactReviewDetails({ device: record.name || record.host, endpoint: record.host, downloadFolder: approvedDir })}\n\nThe restricted companion will be replaced in place. Existing downloads stay on the device.`,
  });
  if (approval.response !== 1) return { cancelled: true };
  if (!devices.isApprovalCurrent(deviceApproval)) {
    throw new Error('The saved device changed during review. Review the update again.');
  }
  return rememberSparkSetup({ ...await sparkSetup.addStorage(sparkProfile(id), { downloadDir: approvedDir }, record.host), deviceId: id });
});
handle('spark:connect', async host => {
  const valid = validateSparkHost(host);
  let record = devices.records.find(item => item.host === valid);
  if (!record) {
    if (!await approveSparkTarget({ mode: 'ssh', host: valid })) return { cancelled: true };
    // Probe determines the correct Mac or Docker transport without guessing from the host name.
    const checked = await sparkSetup.probe({ mode: 'ssh', host: valid });
    if (checked.stage !== 'ready') { await sparkSetup.cancel(checked.sessionId); throw new Error(checked.message || 'Open Devices → Add device to install its companion.'); }
    return (await rememberSparkSetup(await sparkSetup.connect({ sessionId: checked.sessionId }))).status;
  }
  devices.select(record.id);
  return sparkStatusWithInventory({ deviceId: record.id, force: true });
});
handle('spark:setup-probe', async request => {
  const { input, binding } = resolveSparkSetupProbe(request);
  if (!await approveSparkTarget(input)) return { cancelled: true };
  const result = await sparkSetup.probe(input, binding);
  if (binding && result.stage === 'trust') throw new Error('The device SSH identity changed. Verify the device and pair it again before changing storage.');
  if (result.stage !== 'trust') return result;
  const trust = await showReview({
    type: 'warning', buttons: ['Cancel', 'Trust this identity'], defaultId: 0, cancelId: 0,
    message: `Trust the SSH identity for ${dialogText(input.host)}?`,
    summary: `${reviewLabel(input.host)}\n${reviewLabel(result.fingerprint)}\n\nVerify this fingerprint on your device before sending its password.`,
    detail: `${exactReviewDetails({ endpoint: input.host, fingerprint: result.fingerprint })}\n\nVerify this exact fingerprint belongs to the device. FrostByte will send the password only after you trust it.`,
  });
  if (trust.response !== 1) return { cancelled: true };
  return sparkSetup.probe({ ...input, trustFingerprint: result.fingerprint });
});
handle('spark:setup-install', async request => {
  if (!await confirmCompanionChange(request?.sessionId, 'install', request?.downloadDir)) return { cancelled: true };
  return rememberSparkSetup(await sparkSetup.install(request));
});
handle('spark:setup-connect', async request => {
  if (!await confirmCompanionChange(request?.sessionId, 'connect')) return { cancelled: true };
  return rememberSparkSetup(await sparkSetup.connect(request));
});
handle('spark:setup-cancel', id => sparkSetup.cancel(id));
handle('spark:folders', request => sparkSetup.folders(request, request?.sessionId ? undefined : sparkProfile(request?.deviceId)));
handle('spark:storage-add', async request => {
  const deviceId = request?.deviceId || devices.selectedId, record = devices.record(deviceId), deviceApproval = devices.approvalSnapshot(deviceId);
  const downloadDir = request?.downloadDir;
  if (typeof downloadDir !== 'string' || !downloadDir.startsWith('/') || downloadDir.length > 4096 || /[\x00-\x1f\x7f]/.test(downloadDir)) {
    throw new Error('Choose an absolute download folder on the device.');
  }
  const reviewedSession = request?.sessionId ? sparkSetup.getSession(request.sessionId) : null;
  const approval = await showReview({
    type: 'warning', buttons: ['Cancel', 'Add storage folder'], defaultId: 0, cancelId: 0,
    message: `Add a download folder on ${dialogText(record.name || record.host)}?`,
    summary: `${reviewLabel(record.host)}\n${reviewLabel(downloadDir, 220)}\n\nAllow FrostByte to download files to this folder.`,
    detail: `${exactReviewDetails({ device: record.name || record.host, endpoint: record.host, downloadFolder: downloadDir,
      setupSession: request?.sessionId || '(saved connection)' })}\n\nThis folder will be added to the companion and may receive future model downloads.`,
  });
  if (approval.response !== 1) return { cancelled: true };
  if (!devices.isApprovalCurrent(deviceApproval)
    || reviewedSession && sparkSetup.getSession(request.sessionId) !== reviewedSession) {
    throw new Error('The device or setup session changed during review. Review the storage change again.');
  }
  const profile = sparkProfile(deviceId);
  const result = request?.sessionId
    ? await sparkSetup.addStorageFromSession(request.sessionId, deviceId, profile, { downloadDir }, record.host)
    : await sparkSetup.addStorage(profile, { downloadDir }, record.host);
  return rememberSparkSetup({ ...result, deviceId });
});
handle('spark:status', (force, deviceId) => devices.refresh(deviceId || devices.selectedId, { force: force === true }));
handle('spark:device-telemetry', (deviceId) => sparkDevices.status(deviceId || devices.selectedId));
handle('devices:local-telemetry', () => localTelemetry(store.getSettings().downloadDir));
handle('spark:device-recipes', (deviceId) => sparkDevices.recipes(deviceId || devices.selectedId));
handle('spark:model-check', (deviceId, recipeId) => sparkDevices.control(deviceId || devices.selectedId, 'check', recipeId));
async function controlSparkModel(deviceId, recipeId, operation) {
  const id = deviceId || devices.selectedId;
  const record = devices.record(id);
  const preflight = await sparkDevices.control(id, 'check', recipeId);
  if (preflight.state !== 'ready') return { cancelled: true, preflight };
  const approval = devices.approvalSnapshot(id);
  const choice = await showReview({ type: 'warning', buttons: ['Cancel', operation === 'start' ? 'Start model' : 'Stop model'], defaultId: 0, cancelId: 0,
    message: `${operation === 'start' ? 'Start' : 'Stop'} model on ${dialogText(record.name || record.host)}?`,
    summary: `Recipe: ${dialogText(recipeId)}\n\n${dialogText(preflight.message || 'The Spark preflight passed.')}\n\nFrostByte will ${operation} only this approved Spark recipe.` });
  if (choice.response !== 1) return { cancelled: true, preflight };
  if (!devices.isApprovalCurrent(approval)) throw new Error('The saved device changed during model control review. Review the operation again.');
  return { cancelled: false, preflight, result: await sparkDevices.control(id, operation, recipeId, preflight.reviewDigest) };
}
handle('spark:model-start', (deviceId, recipeId) => controlSparkModel(deviceId, recipeId, 'start'));
handle('spark:model-stop', (deviceId, recipeId) => controlSparkModel(deviceId, recipeId, 'stop'));
handle('spark:files', (relative, root, deviceId) => sparkRequest(sparkProfile(deviceId), { action: 'files', relative: String(relative || ''), root }));

async function resumeRemoteHf(ids, deviceId = devices.selectedId) {
  ids = validateHfResumeIds(ids);
  if (ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('Choose a valid HuggingFace download to resume.');
  const record = devices.record(deviceId), deviceApproval = devices.approvalSnapshot(deviceId);
  const assertDevice = () => {
    if (shuttingDown) throw new Error('FrostByte is shutting down. Resume after restarting.');
    if (!devices.isApprovalCurrent(deviceApproval)) {
      throw new Error('The saved device changed during review. Review the resume again.');
    }
  };
  const selectedRows = status => ids.map(id => status.downloads?.find(row => row.id === id));
  const status = await sparkStatusWithInventory({ force: true, deviceId });
  assertDevice();
  const credential = currentHfCredentialContext();
  const { authorization, snapshots, downloadedBytes, status: downloadStatus } = prepareHfResume(
    selectedRows(status), credential.generation, { remote: true });
  const choice = await showReview(remoteHfDownloadReview({
    ...authorization, device: record.name || record.host, destination: authorization.root, deviceBinding: deviceApproval.digest,
    savedCredentialPresent: credential.authenticated, usesCredential: credential.authenticated,
    action: 'resume', status: downloadStatus, downloadedBytes,
  }));
  if (choice.response !== 1) return { cancelled: true };
  assertDevice();
  const credentialMessage = 'The saved Hugging Face credential changed during device resume review. Review the request again.';
  requireUnchangedHfCredential(credential, credentialMessage);
  const currentStatus = await sparkStatusWithInventory({ force: true, deviceId });
  assertDevice();
  const currentCredential = requireUnchangedHfCredential(credential, credentialMessage);
  const currentRows = selectedRows(currentStatus);
  const current = prepareHfResume(currentRows, currentCredential.generation, { remote: true });
  if (current.authorization.requestDigest !== authorization.requestDigest
    || current.snapshots.some((snapshot, index) => snapshot !== snapshots[index])) {
    throw new Error('The Hugging Face download changed during review. Review the resume again.');
  }
  const profile = sparkProfile(deviceId), resumed = [];
  // Older companions support individual resume RPCs. One approval covers this
  // exact manifest; stop on failure and report accepted work without retrying it.
  try {
    for (const id of ids) {
      assertDevice();
      requireUnchangedHfCredential(credential, credentialMessage);
      await sparkRequest(profile, { action: 'hf:resume', id, token: currentCredential.token ?? undefined });
      resumed.push(id);
    }
  } catch (error) {
    if (!resumed.length) throw error;
    throw new Error(`Resumed ${resumed.length} of ${ids.length} files. Refresh the device before retrying the remaining files: ${error.message}`);
  }
  return { cancelled: false, resumed };
}

async function controlSpark(action, id, root, deviceId = devices.selectedId, options = undefined) {
  if (!['torrent:pause', 'torrent:resume', 'torrent:remove', 'hf:pause', 'hf:resume', 'hf:clear', 'hf:remove', 'seed'].includes(action)) throw new Error('Unsupported device action.');
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => key !== 'deleteData') || (options.deleteData !== undefined && typeof options.deleteData !== 'boolean'))) {
    throw new Error('Invalid device control options.');
  }
  const deleteData = options?.deleteData === true;
  if (deleteData && action !== 'torrent:remove') throw new Error('File deletion is only available when removing a torrent transfer.');
  let profile;
  if (action === 'seed') {
    const record = devices.record(deviceId), deviceApproval = devices.approvalSnapshot(deviceId);
    const status = await sparkStatusWithInventory({ force: true, deviceId });
    if (typeof root !== 'string' || root.length > 4096 || /[\x00-\x1f\x7f]/.test(root)
      || !status.storage?.some(item => item.available && item.path === root)) throw new Error('Choose an available storage folder on this device.');
    if (typeof id !== 'string' || !id || id.length > 4096 || /[\x00-\x1f\x7f]/.test(id)) throw new Error('Choose a file or folder on this device.');
    const reviewedLocation = `Root ${JSON.stringify(root)}; relative path ${JSON.stringify(id)}`;
    if (!await confirmShare({ name: path.posix.basename(id.replaceAll('\\', '/')), location: reviewedLocation, device: record.name || record.host })) {
      return { cancelled: true };
    }
    if (!devices.isApprovalCurrent(deviceApproval)) {
      throw new Error('The saved device changed during review. Review sharing again.');
    }
    const current = await sparkStatusWithInventory({ force: true, deviceId });
    if (!devices.isApprovalCurrent(deviceApproval)
      || !current.storage?.some(item => item.available && item.path === root)) {
      throw new Error('The device or storage folder changed during review. Review sharing again.');
    }
    profile = sparkProfile(deviceId);
  }
  if (action === 'hf:resume') return resumeRemoteHf([id], deviceId);
  if (action === 'torrent:remove' && deleteData) {
    if (typeof id !== 'string' || !/^[a-f0-9]{40}$/i.test(id)) throw new Error('This transfer has an invalid identity.');
    id = id.toLowerCase();
    const record = devices.record(deviceId), deviceApproval = devices.approvalSnapshot(deviceId);
    const status = await sparkStatusWithInventory({ force: true, deviceId });
    if (status.capabilities?.torrentFileDeletion !== true) throw new Error('Update this device companion before deleting downloaded files.');
    const torrent = status.torrents?.find(item => item.infoHash === id);
    const dataPath = torrent?.dataPath || torrent?.path;
    const sessionGeneration = torrent?.completionGeneration;
    if (!torrent || typeof dataPath !== 'string' || !path.posix.isAbsolute(dataPath)
      || path.posix.normalize(dataPath) !== dataPath || !Number.isSafeInteger(sessionGeneration) || sessionGeneration < 1) {
      throw new Error('This live device transfer cannot be safely deleted. Refresh or update the device and try again.');
    }
    const identity = Object.freeze({ infoHash: id, dataPath, sessionGeneration });
    const choice = await showReview({
      type: 'warning',
      buttons: ['Cancel', 'Delete downloaded files'],
      defaultId: 0,
      cancelId: 0,
      message: `Delete the downloaded files for ${dialogText(torrent.name)} on ${dialogText(record.name || record.host, 'this device')}?`,
      summary: `${reviewLabel(dataPath, 220)}\n\nPermanently delete these downloaded files from the paired device. This cannot be undone.`,
      detail: `${exactReviewDetails({ device: record.name || record.host, name: torrent.name, dataPath,
        infoHash: id, session: sessionGeneration, deviceBinding: deviceApproval.digest })}\n\nThese exact downloaded files will be removed from the paired device. This cannot be undone.`,
    });
    if (choice.response !== 1) return { cancelled: true };
    if (!devices.isApprovalCurrent(deviceApproval)) throw new Error('The saved device changed during review. Review deletion again.');
    const current = await sparkStatusWithInventory({ force: true, deviceId });
    const currentTorrent = current.torrents?.find(item => item.infoHash === id);
    const currentIdentity = currentTorrent && {
      infoHash: currentTorrent.infoHash,
      dataPath: currentTorrent.dataPath || currentTorrent.path,
      sessionGeneration: currentTorrent.completionGeneration,
    };
    if (!devices.isApprovalCurrent(deviceApproval) || current.capabilities?.torrentFileDeletion !== true
      || JSON.stringify(currentIdentity) !== JSON.stringify(identity)) {
      throw new Error('The device, transfer, or downloaded path changed during review. Review deletion again.');
    }
    return sparkRequest(sparkProfile(deviceId), { action, id, deleteData: true, expected: identity });
  }
  if (['torrent:remove', 'hf:clear', 'hf:remove'].includes(action)) await sparkStatusWithInventory({ force: true, deviceId });
  profile ||= sparkProfile(deviceId);
  return sparkRequest(profile, { action, id, root, relative: action === 'seed' ? id : undefined });
}
handle('spark:control', controlSpark);
handle('spark:hf-download', async ({ repoId, revision, files, destination, deviceId, requiresToken = false } = {}) => {
  const repo = validateHfRepoId(repoId);
  if (!/^[a-f0-9]{40}$/i.test(revision || '')) throw new Error('Could not pin a revision for this model.');
  const rev = revision.toLowerCase();
  if (!Array.isArray(files) || !files.length || files.length > 2000) throw new Error('Choose between 1 and 2,000 HuggingFace files.');
  const selected = files.map(file => {
    const size = Number(file?.size);
    if (!file || typeof file !== 'object' || Array.isArray(file) || typeof file.path !== 'string'
      || !Number.isSafeInteger(size) || size < 0) throw new Error('A selected HuggingFace file is invalid.');
    return { path: file.path, size };
  });
  validateHfDownloadSelection(repo, selected.map(file => file.path));
  if (typeof destination !== 'string' || !destination || destination.length > 4096
    || !path.posix.isAbsolute(destination) || path.posix.normalize(destination) !== destination
    || /[\x00-\x1f\x7f]/.test(destination)) {
    throw new Error('Choose an available download folder on the device.');
  }
  if (typeof requiresToken !== 'boolean') throw new Error('Invalid HuggingFace credential choice.');
  const record = devices.record(deviceId), deviceApproval = devices.approvalSnapshot(deviceId);
  const credential = currentHfCredentialContext();
  if (requiresToken && !credential.authenticated) throw new Error('Connect your HuggingFace account before starting this device download.');
  const authorization = createHfDownloadAuthorization({
    repoId: repo, revision: rev, root: destination, files: selected,
    generation: requiresToken ? credential.generation : 'none', rootStyle: 'posix',
  });
  const choice = await showReview(remoteHfDownloadReview({
    device: record.name || record.host, repoId: repo, revision: rev, destination, deviceBinding: deviceApproval.digest,
    fileCount: authorization.fileCount, totalBytes: authorization.totalBytes,
    manifestDigest: authorization.manifestDigest, tokenGeneration: authorization.tokenGeneration,
    savedCredentialPresent: credential.authenticated, usesCredential: requiresToken,
  }));
  if (choice.response !== 1) return { cancelled: true };
  const currentCredential = requireUnchangedHfCredential(credential,
    'The saved Hugging Face credential changed during device download review. Review the request again.');
  const currentAuthorization = createHfDownloadAuthorization({
    repoId: repo, revision: rev, root: destination, files: selected,
    generation: requiresToken ? currentCredential.generation : 'none', rootStyle: 'posix',
  });
  if (!devices.isApprovalCurrent(deviceApproval)
    || currentAuthorization.requestDigest !== authorization.requestDigest) {
    throw new Error('The saved device or Hugging Face download changed during review. Review the request again.');
  }
  const token = requiresToken ? currentCredential.token : undefined;
  return sparkRequest(sparkProfile(deviceId), { action: 'hf:add', repoId: repo, revision: rev, files: selected, destination, token });
});

const itemJobs = new Map();
function itemJob(key, run) {
  const task = (itemJobs.get(key) || Promise.resolve()).catch(() => {}).then(run);
  itemJobs.set(key, task);
  task.finally(() => { if (itemJobs.get(key) === task) itemJobs.delete(key); }).catch(() => {});
  return task;
}
function localItem(id) {
  const entry = inventory.list({ refresh: true }).find(item => item.id === id);
  if (entry) return entry;
  const shared = store.getLibrary().find(item => 'shared:' + item.infohash === id);
  if (shared) return { ...shared, id, infoHash: shared.infohash };
  throw new Error('This item is no longer available. Refresh and try again.');
}
handle('item:kind', async ({ device, deviceId = devices.selectedId, id, kind }) => {
  if (!validContentKind(kind)) throw new Error('Choose My Models or Torrents.');
  if (typeof id === 'string' && id.startsWith('scan:')) {
    const entry = modelLibrary.entry(id);
    if (entry.device !== device || (device === 'spark' && entry.deviceId !== deviceId)) throw new Error('Choose the model on its saved device.');
    store.setItemKinds({ [id]: kind });
    return { state: currentState() };
  }
  if (device === 'spark') {
    await sparkRequest(sparkProfile(deviceId), { action: 'inventory:kind', id, kind });
    const status = await sparkStatusWithInventory({ force: true, deviceId });
    return { state: currentState(), status, deviceId };
  }
  if (device !== 'local') throw new Error('Choose a connected device.');
  const entry = localItem(id);
  store.setItemKinds({ [id]: kind, ...(id.startsWith('shared:') ? { ['torrent:' + entry.infoHash]: kind } : {}) });
  return { state: currentState() };
});
function knownEntry({ device, deviceId, id }) {
  const rows = device === 'spark' ? [...(devices.list().find(row => row.id === deviceId)?.status?.inventory || [])]
    : [...inventory.list(), ...store.getLibrary().map(row => ({ ...row, id: 'shared:' + row.infohash, directory: true })), ...ipfs.snapshot().downloads.map(row => ({ ...row, path: row.dest, directory: true }))];
  if (device === 'local') rows.push(...(engine?.list() || []).map(row => ({ ...row, id: 'transfer:' + row.infoHash, path: row.dataPath || row.path, directory: (row.files?.length || 0) > 1 })));
  else rows.push(...(devices.list().find(row => row.id === deviceId)?.status?.ipfs?.downloads || []).map(row => ({ ...row, path: row.dest, directory: true })));
  const row = rows.find(row => row.id === id) || modelLibrary.snapshot().items.find(row => row.id === id && row.device === device && (row.deviceId || '') === (deviceId || ''));
  if (!row) throw new Error('This copy is no longer in the library. Refresh and try again.');
  return { ...row, device, deviceId: deviceId || '' };
}
handle('item:hide', request => { entryLifecycle.hide(knownEntry(request)); return currentState(); });
handle('item:restore', ({ id }) => { entryLifecycle.restore(id); return currentState(); });
async function localLinkManifest(request) {
  if (request.device !== 'local') throw new Error('Choose a local copy for link creation.');
  const entry = knownEntry(request);
  if ([...hfDownloads.values()].some(row => ['active', 'queued'].includes(row.status) && (row.dest === entry.path || row.dest.startsWith(entry.path + path.sep)))) throw new Error('Finish or pause downloads in this folder first.');
  const manifest = request.id.startsWith('scan:') ? await modelLibrary.localManifest(request.id) : inventory.shareManifest(request.id);
  return { ...manifest, name: entry.name, path: entry.path };
}
const shareLinks = new ShareLinks({ store, resolve: localLinkManifest });
registerShareExport({ handle, state: currentState, store, inventory, dialog, review: showReview, links: shareLinks, resolve: localLinkManifest });
const publishing = new PublishingService({ store, protection: safeStorage, resolve: localLinkManifest, inventory, sessions: () => engine?.sessions() || [], review: showReview, dialog, state: currentState, handle,
  sharedCid: files => ipfs.sharedCid(collectionFiles(files)) });
const removeLocalItem = ({ device, id, deleteFiles = false, expectedFiles }) => itemJob(`${device}:local:${id}`, async () => {
  if (device !== 'local') throw new Error('Remote file deletion is not available in this Mac-first build.');
  if (typeof deleteFiles !== 'boolean') throw new Error('Choose whether to keep or delete the downloaded files.');
  const entry = localItem(id);
  if (!deleteFiles) { entryLifecycle.hide({ ...entry, device }); return { cancelled: false, state: currentState() }; }
  if (id.startsWith('shared:')) throw new Error('Remove this shared transfer from Transfers.');
  const unfinishedHf = () => [...hfDownloads.values()].filter(record => record.status !== 'done'
    && (record.dest === entry.path || record.dest.startsWith(entry.path + path.sep)));
  if (unfinishedHf().length) throw new Error('Remove unfinished transfers first, choosing whether to keep or delete their partial files. Completed-file deletion does not erase partial ownership records.');
  const inventoryIdentity = inventory.identity(id);
  if (expectedFiles) {
    const owned = inventory.rows.find(row => row.id === id);
    if (!Array.isArray(expectedFiles) || expectedFiles.length !== owned.files.length || owned.files.some(file => !expectedFiles.some(selected => entryPath(selected.dest) === entryPath(path.join(owned.destination, file.relative)) && selected.revision === file.revision))) {
      throw new Error('This folder contains files outside the selected revision. Use My Models to review the full recorded copy; no files were deleted.');
    }
  }
  const deletionPlan = deleteFiles ? inventory.deletionPlan(id) : null;
  const live = engine.list().filter(torrent => torrent.inventoryId === id || torrent.infoHash === entry.infoHash
    || (!torrent.inventoryId && torrent.dataPath === entry.path));
  const liveIdentities = live.map(torrent => engine.transferIdentity(torrent.infoHash));
  if (liveIdentities.some(identity => !identity)) throw new Error('A transfer changed while this item was loading. Refresh and try again.');
  const approval = await showReview({
    type: 'warning',
    buttons: ['Cancel', deleteFiles ? 'Delete downloaded files' : 'Remove from list'],
    defaultId: 0,
    cancelId: 0,
    message: deleteFiles ? `Delete the downloaded files for ${dialogText(entry.name)}?` : `Remove ${dialogText(entry.name)} from FrostByte?`,
    summary: deleteFiles
      ? `${reviewLabel(entry.path, 220)}\n\nPermanently delete ${entry.fileCount} recorded file${entry.fileCount === 1 ? '' : 's'} (${entry.size} bytes). This cannot be undone.`
      : `${reviewLabel(entry.path, 220)}\n\nRemove this item from My Models or Torrents and stop its FrostByte sharing transfer. Files stay on disk.`,
    detail: deleteFiles
      ? `FrostByte will delete only the exact files in this completed-download manifest, then remove its inventory and transfer records. Unrecorded files in the same folder are kept.`
      : 'The downloaded files stay in their current folder. You can add or download them again later.',
  });
  if (approval.response !== 1) return { cancelled: true, state: currentState() };
  if (inventory.identity(id) !== inventoryIdentity || liveIdentities.some(identity => !engine.isCurrentIdentity(identity))) {
    throw new Error('The downloaded item or its transfer changed during review. Review it again.');
  }
  if (unfinishedHf().length) throw new Error('An unfinished download appeared during review. Resolve that transfer before deleting this copy.');
  const operation = entryLifecycle.begin({ ...entry, device: 'local' }, 'delete');
  try {
  for (const torrent of live) {
    await withTransferMutation(() => settleTorrentRemoval({ engine, store, infoHash: torrent.infoHash, deleteData: false,
      pendingCompletionRecords, completionMoves, transferSessionRecords, completionMoveRecords }));
  }
  inventory.deleteFiles(deletionPlan, { forget: false });
  entryLifecycle.step(operation, 'files-complete');
  const terminalHf = entryLifecycle.finish(operation, inventory, [...hfDownloads.values()].map(record => normalizeHfTransferRecord(record)));
  hfDownloads.clear();
  for (const record of terminalHf) hfDownloads.set(record.id, record);
  } catch (error) {
    const phase = entryLifecycle.operations.find(row => row.id === operation)?.phase || 'prepared';
    try { entryLifecycle.step(operation, phase, error.message); } catch { /* original ownership is still saved */ }
    throw new Error(`${error.message} Some sharing or file-removal steps may have completed. The ownership record was retained; refresh and review this copy to retry.`);
  }
  pushHfState();
  enforceQueue().catch(() => {});
  return { cancelled: false, state: currentState() };
});
handle('item:remove', async request => {
  if (request.device !== 'spark') return removeLocalItem(request);
  const { id, deviceId } = request;
  if (!request.deleteFiles) { entryLifecycle.hide(knownEntry(request)); return { state: currentState() }; }
  const status = await sparkStatusWithInventory({ force: true, deviceId }), approval = devices.approvalSnapshot(deviceId);
  if (!status.capabilities?.inventoryFileDeletion) throw new Error('Update this device’s companion to enable exact-copy file deletion. Hiding remains available offline.');
  const entry = status.inventory?.find(row => row.id === id); if (!entry) throw new Error('This device copy is no longer available.');
  const proof = createHash('sha256').update(inventoryProofText(entry)).digest('hex');
  const choice = await showReview({ type: 'warning', buttons: ['Cancel', 'Delete device files'], defaultId: 0, cancelId: 0,
    message: `Delete ${dialogText(entry.name)} on this device?`, summary: `${devices.record(deviceId).name}\n${entry.path}\n\nDelete ${entry.fileCount} owned files (${entry.size} bytes). This cannot be undone.`, detail: `Only this copy’s recorded files will be removed. Unrecorded files are preserved.\nManifest approval SHA-256: ${proof}` });
  if (choice.response !== 1) return { cancelled: true, state: currentState() };
  if (!devices.isApprovalCurrent(approval)) throw new Error('The saved device changed during review.');
  await sparkRequest(sparkProfile(deviceId), { action: 'inventory:remove', id, proof });
  entryLifecycle.hide({ ...entry, device: 'spark', deviceId });
  await sparkStatusWithInventory({ force: true, deviceId }); return { state: currentState() };
});
const setItemSharing = ({ device, deviceId = devices.selectedId, id, enabled }) => itemJob(`${device}:${deviceId}:${id}`, async () => {
  if (typeof enabled !== 'boolean') throw new Error('Choose whether sharing is on or off.');
  if (device === 'spark') {
    let profile;
    if (enabled) {
      const record = devices.record(deviceId), deviceApproval = devices.approvalSnapshot(deviceId);
      const current = await sparkStatusWithInventory({ force: true, deviceId });
      const entry = current.inventory?.find(item => item.id === id);
      if (!entry) throw new Error('This item is no longer available on the device.');
      const entryIdentity = createHash('sha256').update(JSON.stringify({
        id: entry.id, name: entry.name, path: entry.path, destination: entry.destination,
        relative: entry.relative, directory: entry.directory, infoHash: entry.infoHash,
        repoId: entry.repoId, files: entry.files,
      })).digest('hex');
      if (!await confirmShare({ name: entry.name, location: entry.path, device: record.name || record.host })) {
        return { cancelled: true, state: currentState(), status: current, deviceId };
      }
      if (!devices.isApprovalCurrent(deviceApproval)) {
        throw new Error('The saved device changed during review. Review sharing again.');
      }
      const reviewed = await sparkStatusWithInventory({ force: true, deviceId });
      const reviewedEntry = reviewed.inventory?.find(item => item.id === id);
      const reviewedIdentity = reviewedEntry && createHash('sha256').update(JSON.stringify({
        id: reviewedEntry.id, name: reviewedEntry.name, path: reviewedEntry.path,
        destination: reviewedEntry.destination, relative: reviewedEntry.relative,
        directory: reviewedEntry.directory, infoHash: reviewedEntry.infoHash,
        repoId: reviewedEntry.repoId, files: reviewedEntry.files,
      })).digest('hex');
      if (!devices.isApprovalCurrent(deviceApproval) || reviewedIdentity !== entryIdentity) {
        throw new Error('The device item changed during review. Review sharing again.');
      }
      profile = sparkProfile(deviceId);
    }
    await sparkRequest(profile || sparkProfile(deviceId), { action: 'inventory:sharing', id, enabled });
    const status = await sparkStatusWithInventory({ force: true, deviceId });
    return { state: currentState(), status, deviceId };
  }
  if (device !== 'local') throw new Error('Choose a connected device.');
  const entry = localItem(id);
  const live = engine.list().filter(t => t.inventoryId === id || t.infoHash === entry.infoHash || (!t.inventoryId && t.dataPath === entry.path));
  const liveIdentities = live.map(torrent => engine.transferIdentity(torrent.infoHash));
  if (liveIdentities.some(identity => !identity)) throw new Error('A transfer changed while this item was loading. Refresh and try again.');
  const validateLive = () => {
    if (liveIdentities.some(identity => !engine.isCurrentIdentity(identity))) {
      throw new Error('The transfer changed before this sharing choice could be applied. Review it again.');
    }
  };
  if (enabled) {
    if (entry.available === false) throw new Error('Reconnect storage or restore the missing files before sharing.');
    if (originBlocksSharing(await origins.ensure(id))) throw new Error(ORIGIN_SHARE_BLOCKED);
    if (integrityBlocksSharing(await integrity.ensure(id))) throw new Error(INTEGRITY_SHARE_BLOCKED);
    if ([...hfDownloads.values()].some(record => ['active', 'queued'].includes(record.status) && (record.dest === entry.path || record.dest.startsWith(entry.path + path.sep)))) throw new Error('Finish downloads in this model before sharing it.');
    if (!live.some(torrent => torrent.seeding) && !await confirmShare({ name: entry.name, location: entry.path })) {
      return { cancelled: true, state: currentState() };
    }
    if (live.length) {
      await applyTransferChanges(live.map(torrent => ({ infoHash: torrent.infoHash, paused: false, explicitShare: true })),
        async () => { for (const torrent of live) await engine.setSharing(torrent.infoHash, true); },
        async before => { for (const record of before.values()) await engine.setSessionIntent(record.infohash, { paused: record.paused, explicitShare: record.explicitShare }); },
        validateLive);
    } else {
      const manifest = id.startsWith('shared:') ? undefined : inventory.shareManifest(id);
      await withTransferMutation(async () => {
        let seeded;
        try {
          seeded = await engine.seed(entry.path, {
            ...(manifest ? { files: manifest.files } : {}), inventoryId: id, announce: extraTrackers(),
          });
          commitTransferIntent(store, transferSessionRecords(), completionMoveRecords());
        } catch (error) {
          if (seeded) {
            try { await engine.rollbackAddition(seeded); }
            catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Sharing could not be saved or safely rolled back. Restart FrostByte.'); }
          }
          throw error;
        }
      });
    }
  } else if (live.length) {
    await applyTransferChanges(live.map(torrent => ({ infoHash: torrent.infoHash, paused: true })),
      async () => { for (const torrent of live) await engine.setSharing(torrent.infoHash, false); },
      async before => { for (const record of before.values()) await engine.setSessionIntent(record.infohash, { paused: record.paused, explicitShare: record.explicitShare }); },
      validateLive);
  }
  return { state: currentState() };
});
handle('item:sharing', setItemSharing);

const previews = new Map();
function catalogTrustsInfoHash(infoHash) {
  return catalog.all().some(entry => extractInfoHash(entry.infohash || entry.magnet) === infoHash);
}

async function authorizedTorrentSource(request, { consume = false, action = 'download' } = {}) {
  const source = request && typeof request === 'object' && !Array.isArray(request) ? request.source : request;
  const capability = request && typeof request === 'object' && !Array.isArray(request) ? request.sourceCapability : undefined;
  const normalized = normalizeSource(source);
  const infoHash = extractInfoHash(normalized);
  if (!infoHash && /\.torrent$/i.test(normalized.trim())) {
    if (consume) pathCapabilities.consume(capability, normalized, 'torrent');
    else pathCapabilities.verify(capability, normalized, 'torrent');
    return { source: normalized, infoHash: null };
  }
  const catalogTrusted = catalogTrustsInfoHash(infoHash);
  const reviewed = torrentDiscoveryAuthorizations.has(infoHash, action);
  if (!catalogTrusted && !reviewed) {
    const approval = await showReview(torrentDiscoveryReview({ infoHash, action }));
    if (approval.response !== 1) return { cancelled: true };
    if (!consume) torrentDiscoveryAuthorizations.approve(infoHash, action);
  } else if (consume && !catalogTrusted) {
    torrentDiscoveryAuthorizations.consume(infoHash, action);
  }
  return { source: normalized, infoHash };
}
handle('torrent:inspect', async (request, id) => {
  for (const controller of previews.values()) controller.abort();
  previews.clear();
  const controller = new AbortController();
  previews.set(id, controller);
  try {
    const authorization = await authorizedTorrentSource(request, { action: 'inspect' });
    if (authorization.cancelled) return authorization;
    return { preview: await inspectTorrent(authorization.source, { signal: controller.signal, dht: store.getSettings().dhtEnabled, announce: extraTrackers(), allowPeerAddresses: allowTestPeerAddresses }) };
  }
  catch (error) { return { error: error.message }; }
  finally { if (previews.get(id) === controller) previews.delete(id); }
});
handle('torrent:cancel-inspect', id => { previews.get(id)?.abort(); });

handle('torrent:add', async (source, options = {}) => {
  const selectedPaths = normalizeTorrentSelection(options.selectedPaths) ?? undefined;
  const authorization = await authorizedTorrentSource({ source, sourceCapability: options.sourceCapability }, { consume: true, action: 'download' });
  if (authorization.cancelled) return { cancelled: true, state: currentState() };
  const src = authorization.source;
  if (options.target === 'spark') {
    const metadata = !extractInfoHash(src) && /\.torrent$/i.test(src.trim()) ? (await readTorrent(src)).toString('base64') : undefined;
    const torrent = await sparkRequest(sparkProfile(options.deviceId), { action: 'torrent:add', source: metadata ? undefined : src, metadata, selectedPaths, destination: options.destination, kind: options.kind });
    return { torrent, remote: true, state: currentState() };
  }
  const localSource = !extractInfoHash(src) && /\.torrent$/i.test(src.trim()) ? await readTorrent(src) : src;
  let destination = store.getSettings().downloadDir;
  if (typeof options.destination === 'string' && path.isAbsolute(options.destination)) {
    const requested = path.resolve(options.destination);
    if (requested !== path.resolve(destination)) pathCapabilities.consume(options.destinationCapability, requested, 'save');
    destination = requested;
  }
  const t = await withTransferMutation(async () => {
    let added;
    try {
      added = await engine.add(localSource, {
        path: destination,
        selectedPaths,
        kind: options.kind,
        announce: extraTrackers(),
      });
      commitTransferIntent(store, transferSessionRecords(), completionMoveRecords());
      return added;
    } catch (error) {
      if (added) {
        try { await engine.rollbackAddition(added); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'The download could not be saved or safely stopped. Restart FrostByte.'); }
      }
      throw error;
    }
  });
  enforceQueue().catch(() => {});
  return { torrent: t, state: currentState() };
});


handle('torrent:pause', async (infoHash) => {
  await applyTransferChanges([{ infoHash, paused: true }], () => engine.pause(infoHash));
  return currentState();
});

handle('torrent:resume', async (rawInfoHash) => {
  // Normalize exactly like torrent:remove — an uppercase/whitespace variant
  // must not dodge the gate lookups below (engine matching is lenient).
  if (typeof rawInfoHash !== 'string' || !/^[a-f0-9]{40}$/i.test(rawInfoHash.trim())) throw new Error('Invalid info hash.');
  const infoHash = rawInfoHash.trim().toLowerCase();
  // A share stopped by the integrity/origin gate must stay stopped: resume
  // may not re-seed content a confirmed verdict blocked. Cache-only check
  // over every recorded identity (mirrored by the completion/share gates),
  // exactly like the restart re-seed gate — unscanned transfers are never
  // blocked, but a recorded risky/blocked verdict refuses the resume.
  const resuming = engine.list().find(item => item.infoHash === infoHash);
  if (resuming) {
    const gateIds = new Set(['shared:' + infoHash]);
    if (resuming.inventoryId) gateIds.add(resuming.inventoryId);
    const owned = inventory.list().find(item => item.infoHash === infoHash);
    if (owned) gateIds.add(owned.id);
    if (resuming.dataPath) gateIds.add(folderIntegrityId(resuming.dataPath));
    for (const id of gateIds) {
      if (originBlocksSharing(origins.get(id))) throw new Error(ORIGIN_SHARE_BLOCKED);
      if (integrityBlocksSharing(integrity.get(id))) throw new Error(INTEGRITY_SHARE_BLOCKED);
    }
  }
  try {
    await applyTransferChanges([{ infoHash, paused: false }], () => engine.resume(infoHash));
    privacy.record('resume_ok');
  } catch (error) { privacy.record('resume_error'); privacy.error(error); throw error; }
  enforceQueue().catch(() => {});
  return currentState();
});

handle('torrent:remove', async ({ infoHash, deleteData }) => {
  const owned = inventory.list().find(item => item.infoHash === infoHash);
  if (deleteData && owned) { await removeLocalItem({ device: 'local', id: owned.id, deleteFiles: true }); return currentState(); }
  let approvedIdentity = null;
  if (deleteData) {
    const torrent = engine.list().find(item => item.infoHash === infoHash);
    approvedIdentity = engine.transferIdentity(infoHash);
    if (!torrent || !approvedIdentity) throw new Error('This transfer is no longer available.');
    const choice = await showReview({
      type: 'warning',
      buttons: ['Cancel', 'Delete downloaded files'],
      defaultId: 0,
      cancelId: 0,
      message: `Delete the downloaded files for ${dialogText(torrent.name)}?`,
      summary: `${reviewLabel(approvedIdentity.dataPath, 220)}\n\nPermanently delete these downloaded files. This cannot be undone.`,
      detail: `${exactReviewDetails({ name: torrent.name, dataPath: approvedIdentity.dataPath,
        infoHash: approvedIdentity.infoHash, session: approvedIdentity.sessionGeneration })}\n\nThese exact downloaded files will be removed from disk. This cannot be undone.`,
    });
    if (choice.response !== 1) return currentState();
  }
  await withTransferMutation(() => {
    if (approvedIdentity && !engine.isCurrentIdentity(approvedIdentity)) {
      throw new Error('The transfer or downloaded path changed during review. Review deletion again.');
    }
    return settleTorrentRemoval({ engine, store, infoHash, deleteData: !!deleteData,
      pendingCompletionRecords, completionMoves, transferSessionRecords, completionMoveRecords });
  });
  enforceQueue().catch(() => {});
  return currentState();
});

/**
 * Share something already on this machine. Returns a magnet link to hand to
 * whoever you want to have it.
 */
async function shareLocalFolder({ targetPath, name, remember = true, pathCapability, scanId }) {
  const p = targetPath || await pickPath();
  if (!p) return { cancelled: true };
  const recordedItems = inventory.list({ refresh: true });
  if (recordedItems.some(item => sameLocalPath(item.path, p) && originBlocksSharing(origins.get(item.id)))) throw new Error(ORIGIN_SHARE_BLOCKED);
  // Integrity gate for anything already known at this path — recorded download,
  // discovered model, or previously shared folder. Scanned before the review
  // dialog so a risky copy is refused without prompting. Unknown paths are left
  // to the capability grant + review dialog, exactly as the origin gate does.
  const recordedAtPath = recordedItems.find(item => sameLocalPath(item.path, p));
  const sharedAtPath = store.getLibrary().find(item => sameLocalPath(item.path, p));
  const knownId = recordedAtPath?.id || (sharedAtPath ? 'shared:' + sharedAtPath.infohash : null);
  if (knownId && integrityBlocksSharing(await integrity.ensure(knownId))) throw new Error(INTEGRITY_SHARE_BLOCKED);
  // A path with no recorded identity is scanned before it can seed at all.
  // The verdict is persisted under a path-keyed id; on scan failure sharing
  // proceeds exactly as before (unknown never blocks), with a visible note.
  let unrecordedFolderId = null;
  let folderPreScan = null;
  if (!knownId) {
    unrecordedFolderId = folderIntegrityId(p);
    try {
      // A folder is walked with listFolderFiles; a single FILE is described
      // as a one-entry collection rooted at its parent (listFolderFiles only
      // walks directories, and an empty file list would fingerprint nothing).
      const stat = await fs.promises.stat(p);
      const item = stat.isDirectory()
        ? { path: p, files: await listFolderFiles(p) }
        : { path: path.dirname(p), files: [{ path: path.basename(p), size: stat.size }] };
      folderPreScan = await integrity.ensure(unrecordedFolderId, { item });
      if (integrityBlocksSharing(folderPreScan)) throw new Error(INTEGRITY_SHARE_BLOCKED);
    } catch (error) {
      if (String(error?.message || '').includes(INTEGRITY_SHARE_BLOCKED)) throw error;
      note(`Could not scan ${path.basename(p)} before sharing: ${error.message}`, 'warn');
    }
  }
  const scanned = scanId ? modelLibrary.entry(scanId) : null;
  if (scanned && (scanned.device !== 'local' || !sameLocalPath(scanned.path, p))) throw new Error('Choose a discovered local model.');
  const scanIdentity = scanned && JSON.stringify(scanned);
  if (scanned) await modelLibrary.localManifest(scanId);
  const recordedHfFile = recordedItems.some(item => item.source === 'hf' && item.available
    && Array.isArray(item.fileNames) && item.fileNames.some(file => sameLocalPath(path.resolve(item.destination, file), p)));
  const known = store.getLibrary().some(item => sameLocalPath(item?.path, p))
    || recordedItems.some(item => sameLocalPath(item?.path, p)) || recordedHfFile || Boolean(scanned);
  if (targetPath && !known) pathCapabilities.verify(pathCapability, p, 'seed');
  if (!await confirmShare({ name: name || path.basename(p), location: p })) return { cancelled: true, state: currentState() };
  if (targetPath && !known) pathCapabilities.consume(pathCapability, p, 'seed');
  if (scanned && JSON.stringify(modelLibrary.entry(scanId)) !== scanIdentity) throw new Error('The discovered model changed during review. Scan it again.');
  if (scanned && integrityBlocksSharing(await integrity.ensure(scanId))) throw new Error(INTEGRITY_SHARE_BLOCKED);
  // TOCTOU (round-2 N8): the review dialog can stay open while the folder
  // changes. Re-scan the exact bytes after approval; a changed fingerprint,
  // a failed re-read, or a risky verdict refuses the seed — the decision must
  // rest on current bytes, never on the pre-dialog scan.
  if (unrecordedFolderId) {
    let recheck = null;
    try {
      // Re-read exactly what the pre-dialog scan read: a folder is walked, a
      // single FILE is re-analyzed as a one-entry collection rooted at its
      // parent. Passing an empty file list would fingerprint nothing and let
      // changed bytes through — the decision must rest on the current bytes.
      const stat = await fs.promises.stat(p);
      const item = stat.isDirectory()
        ? { path: p, files: await listFolderFiles(p) }
        : { path: path.dirname(p), files: [{ path: path.basename(p), size: stat.size }] };
      recheck = await integrity.ensure(unrecordedFolderId, { item, force: true });
    } catch (error) {
      // The pre-dialog scan could not read this path either: keep the
      // historical warn-and-proceed behaviour instead of turning a benign
      // read failure into a fatal refusal.
      if (!folderPreScan) note(`Could not re-scan ${path.basename(p)} before sharing: ${error.message}`, 'warn');
      else throw new Error(`The folder changed while the share review was open (${error.message}). Nothing was shared — pick it again to re-scan.`);
    }
    if (recheck) {
      if (recheck.status !== 'done') throw new Error('The folder changed while the share review was open. Nothing was shared — pick it again to re-scan.');
      if (folderPreScan?.status === 'done' && recheck.fingerprint !== folderPreScan.fingerprint) throw new Error('The folder changed while the share review was open. Nothing was shared — pick it again to re-scan.');
      if (integrityBlocksSharing(recheck)) throw new Error(INTEGRITY_SHARE_BLOCKED);
    }
  }
  const scanManifest = scanned ? await modelLibrary.localManifest(scanId) : null;

  // Use the same platform path equivalence that authorized the request above.
  // Windows callers may spell an existing drive/path with different casing;
  // losing its inventory identity here would seed the whole folder instead of
  // the exact completed-file manifest.
  const owned = recordedItems.find(item => sameLocalPath(item.path, p));
  const t = await withTransferMutation(async () => {
    let seeded;
    const previousTransfers = store.state.transfers, previousMoves = store.state.completionMoves;
    try {
      seeded = await engine.seed(p, { name: name || path.basename(p), announce: extraTrackers(), ...(owned ? { inventoryId: owned.id, files: inventory.shareManifest(owned.id).files } : scanManifest ? { files: scanManifest.files } : {}) });
      store.state.transfers = transferSessionRecords();
      store.state.completionMoves = completionMoveRecords();
      if (remember) store.addToLibrary({ path: p, name: seeded.name, infohash: seeded.infoHash, magnet: seeded.magnetURI });
      else commitTransferIntent(store, store.state.transfers, store.state.completionMoves);
      return seeded;
    } catch (error) {
      store.state.transfers = previousTransfers; store.state.completionMoves = previousMoves;
      if (seeded) {
        try { await engine.rollbackAddition(seeded); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'The share could not be saved or safely stopped. Restart FrostByte.'); }
      }
      throw error;
    }
  });
  recordInventory(() => inventory.registerTorrent(t), t.name);
  note(`Now sharing ${t.name}.`);
  return { torrent: t, state: currentState() };
}
handle('library:seed', request => {
  if (request && Object.hasOwn(request, 'scanId')) throw new Error('Use the discovered model sharing control.');
  return shareLocalFolder(request);
});

handle('library:scan', () => modelLibrary.start());
handle('library:scan-cancel', () => modelLibrary.cancel());
handle('library:import-folder', async () => {
  const pick = await dialog.showOpenDialog(win, {
    title: 'Import Existing Model Folder into Library',
    properties: ['openDirectory'],
  });
  if (pick.canceled || !pick.filePaths?.[0]) return { cancelled: true };
  return modelLibrary.importLocalFolder(pick.filePaths[0], { name: store.getLocalDevice()?.name || 'This computer' });
});
const setDiscoveredSharing = ({ id, enabled } = {}) => itemJob(`scan:${id}`, async () => {
  if (typeof enabled !== 'boolean') throw new Error('Choose whether sharing is on or off.');
  const entry = modelLibrary.entry(id);
  if (!entry.available && enabled) throw new Error('Scan this model location again before sharing.');
  if (entry.device === 'local') {
    if (enabled) return shareLocalFolder({ targetPath: entry.path, name: entry.name, scanId: id });
    const existing = inventory.list().find(item => sameLocalPath(item.path, entry.path));
    if (existing) return setItemSharing({ device: 'local', id: existing.id, enabled: false });
    const shared = store.getLibrary().find(item => sameLocalPath(item.path, entry.path));
    if (shared) return setItemSharing({ device: 'local', id: 'shared:' + shared.infohash, enabled: false });
    return { state: currentState() };
  }
  if (enabled) {
    const result = await controlSpark('seed', entry.relative || '.', entry.root, entry.deviceId);
    if (result?.cancelled) return { cancelled: true, state: currentState() };
  } else {
    const status = await sparkStatusWithInventory({ force: true, deviceId: entry.deviceId });
    const existing = status.inventory?.find(item => item.path === entry.path);
    if (existing) return setItemSharing({ device: 'spark', deviceId: entry.deviceId, id: existing.id, enabled: false });
    for (const torrent of status.torrents || []) if (torrent.dataPath === entry.path) await controlSpark('torrent:pause', torrent.infoHash, undefined, entry.deviceId);
  }
  const status = await sparkStatusWithInventory({ force: true, deviceId: entry.deviceId });
  return { status, deviceId: entry.deviceId, state: currentState() };
});
handle('library:scan-sharing', setDiscoveredSharing);

registerLibraryBatch({ handle, resolve: knownEntry,
  context: row => row.device === 'spark' ? devices.approvalSnapshot(row.deviceId).digest : 'local',
  review: showReview, hide: row => entryLifecycle.hide(row), state: currentState,
  stopSharing: async row => {
    if (row.id.startsWith('ipfs:')) {
      if (row.device === 'spark') {
        await sparkRequest(sparkProfile(row.deviceId), { action: 'ipfs:sharing', id: row.id, enabled: false });
        await sparkStatusWithInventory({ force: true, deviceId: row.deviceId });
      } else await ipfs.sharing(row.id, false);
    } else if (row.id.startsWith('scan:')) {
      await setDiscoveredSharing({ id: row.id, enabled: false });
    } else if (row.id.startsWith('transfer:')) {
      throw new Error('Use Transfers to pause or remove this unfinished download.');
    } else await setItemSharing({ device: row.device, deviceId: row.deviceId, id: row.id, enabled: false });
  },
});

handle('library:unseed', async ({ infoHash }) => {
  await withTransferMutation(() => settleTorrentRemoval({ engine, store, infoHash, pendingCompletionRecords,
    completionMoves, transferSessionRecords, completionMoveRecords }));
  return currentState();
});

handle('library:reveal', revealKnownPath);

handle('catalog:add', async (entry) => {
  const normalized = normalizeCatalogEntry(entry);
  if (!catalogTrustsInfoHash(normalized.infohash)) {
    const approval = await showReview(torrentDiscoveryReview({
      infoHash: normalized.infohash, action: 'catalog', name: normalized.name,
    }));
    if (approval.response !== 1) return { cancelled: true, state: currentState() };
  }
  const e = catalog.add(normalized);
  note(`Added ${e.name} to your catalog.`);
  return currentState();
});

handle('catalog:remove', (id) => {
  catalog.remove(id);
  return currentState();
});

handle('catalog:importUrl', async (url) => {
  const requested = validateCatalogUrl(url).href;
  const approval = await showReview(catalogImportReview(requested));
  if (approval.response !== 1) return { cancelled: true };
  const { data: json } = await fetchCatalogJson(requested);
  const list = Array.isArray(json) ? json : json?.models;
  if (!Array.isArray(list)) throw new Error('That JSON has no "models" array.');
  // Share the settings FIFO so a failing older settings request completes its
  // rollback before this URL is committed, and a later request cannot be
  // rolled back over this import.
  const result = await settingsMutations.run(() => persistCatalogImport({ catalog, store, entries: list, catalogUrl: requested }));
  const { imported } = result;
  // A failed settings write normally restores the exact previous catalog and
  // rejects the IPC. If the bounded rollback itself failed, the durable truth
  // is that the entries were imported, so return them with an explicit warning.
  if (!result.settingsSaved) note(`Catalog entries were saved, but the catalog address could not be saved and the exact rollback failed: ${result.settingsError.message}; ${result.rollbackError.message}`, 'warn');
  if (imported.skipped) note(`Imported ${imported.added.length} catalog entries; skipped ${imported.skipped} malformed entries.`, 'warn');
  return currentState();
});

handle('settings:set', (patch, capabilities = {}) => settingsMutations.run(async () => {
  const prev = store.getSettings();
  const sensitive = {
    openAtLogin: patch?.openAtLogin === true && prev.openAtLogin !== true,
    upnpEnabled: patch?.upnpEnabled === true && prev.upnpEnabled !== true,
  };
  if (sensitive.openAtLogin || sensitive.upnpEnabled) {
    const approval = await showReview(sensitiveSettingsReview(sensitive));
    if (approval.response !== 1) return { cancelled: true, state: currentState() };
    if (JSON.stringify(store.getSettings()) !== JSON.stringify(prev)) throw new Error('Settings changed during review. Review this change again.');
  }
  if (Object.hasOwn(patch ?? {}, 'downloadDir') && !sameLocalPath(patch.downloadDir, prev.downloadDir)) {
    pathCapabilities.consume(capabilities.downloadDir, patch.downloadDir, 'save');
  }
  if (patch?.completedDir && !sameLocalPath(patch.completedDir, prev.completedDir || prev.downloadDir)) {
    pathCapabilities.consume(capabilities.completedDir, patch.completedDir, 'completed');
  }
  const changesLoginItem = typeof patch?.openAtLogin === 'boolean' && patch.openAtLogin !== prev.openAtLogin;
  if (changesLoginItem) {
    try { setOpenAtLogin({ ...loginItemOptions, openAtLogin: patch.openAtLogin }); }
    catch { throw new Error('Could not change the start-at-login setting. The previous setting was kept.'); }
  }
  let next;
  try { next = store.setSettings(patch); }
  catch (error) {
    const failures = [error];
    if (changesLoginItem) {
      try { setOpenAtLogin({ ...loginItemOptions, openAtLogin: prev.openAtLogin }); }
      catch (rollbackError) {
        failures.push(rollbackError);
        note('Could not restore the previous operating-system login setting. Review Start at login in Settings.', 'error');
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Could not save the settings or fully restore the previous operating-system login setting. Review Start at login before retrying.');
    }
    throw error;
  }
  try {
    engine.setDownloadPath(next.downloadDir);
    await applySettingsLive(prev, next);
  } catch (error) {
    const failures = [error];
    // Other main-process work (notably device selection) may update unrelated
    // compatibility fields while a router operation is pending. Restore only
    // the keys this transaction wrote, and never overwrite a same-key change
    // whose current value no longer matches this transaction's committed value.
    const current = store.getSettings();
    const restore = {};
    const changedDuringApply = [];
    for (const key of Object.keys(patch ?? {})) {
      if (JSON.stringify(current[key]) === JSON.stringify(next[key])) restore[key] = prev[key];
      else changedDuringApply.push(key);
    }
    try { if (Object.keys(restore).length) store.setSettings(restore); }
    catch (rollbackError) { failures.push(rollbackError); }
    if (changedDuringApply.length) {
      failures.push(new Error(`Settings changed during rollback: ${changedDuringApply.join(', ')}.`));
    }
    if (changesLoginItem) {
      try { setOpenAtLogin({ ...loginItemOptions, openAtLogin: prev.openAtLogin }); }
      catch (rollbackError) { failures.push(rollbackError); }
    }
    try {
      engine.setDownloadPath(prev.downloadDir);
      await applySettingsLive(next, prev);
    } catch (rollbackError) { failures.push(rollbackError); }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Could not apply the settings or fully restore their previous state. Restart FrostByte before retrying.');
    }
    throw error;
  }
  if (next.autoCheckUpdates && !prev.autoCheckUpdates) updates.check({ automatic: true }).catch(() => {});
  return currentState();
}));

handle('rates:turtle', () => settingsMutations.run(async () => {
  const enable = !rates.inAltMode();
  if (enable) {
    const choice = await showReview({ type: 'question', buttons: ['Cancel', 'Enable ALT limits'], defaultId: 0, cancelId: 0,
      message: 'Switch this computer to ALT limits?',
      summary: `Download: ${nextKbs('altDownKBs')} KB/s · Upload: ${nextKbs('altUpKBs')} KB/s.\n\nThese replace your normal limits, including unlimited.`,
      detail: 'This choice persists after restarting. Return to Normal for your usual limits, or choose Scheduled in Bandwidth settings. Other devices are unaffected.' });
    if (choice.response !== 1) return { cancelled: true, state: currentState() };
  }
  store.setSettings({ bandwidthMode: enable ? 'alt' : 'normal' });
  const applied = rates.apply();
  note(enable
    ? `Alternative limits on — ↓ ${nextKbs('altDownKBs')} · ↑ ${nextKbs('altUpKBs')} KB/s.`
    : 'Alternative limits off — normal limits restored.');
  return { state: currentState(), applied };
}));

function nextKbs(key) {
  return Number(store.getSettings()[key]) > 0 ? store.getSettings()[key] : '∞';
}

/** Apply what can change at runtime; the UI marks the rest "restart required". */
async function applySettingsLive(prev, next) {
  if (!engine) return;
  engine.setMaxConns(next.maxConns);
  rates.apply();
  if (prev.maxActiveDownloads !== next.maxActiveDownloads) {
    enforceQueue().catch(error => note(`Could not apply the download queue setting yet: ${error.message}`, 'warn'));
    hfPump();
  }

  // A live-apply failure must reject the whole settings transaction so the durable
  // choice rolls back (and any concurrent device-settings commit is preserved).
  // Ordinary UPnP mapping failures are already handled inside enable() (logged +
  // retried); only an unconfirmed router cleanup reaches here, and that is a real
  // failure the user must see rather than a silently-saved setting.
  if (prev.upnpEnabled !== next.upnpEnabled) {
    if (next.upnpEnabled) await maybeMapUpnp();
    else await upnp.disable();
  }
  if (next.dhtEnabled !== prev.dhtEnabled) {
    note('The DHT setting takes effect after a restart.', 'warn');
  }
}

handle('dialog:pickFolder', () => pickPath());
handle('dialog:pickSaveDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Where should models go?' });
  return r.canceled ? null : pathCapabilities.grant(r.filePaths[0], 'save');
});
handle('dialog:pickTorrentFile', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'], filters: [{ name: 'Torrent', extensions: ['torrent'] }],
  });
  return r.canceled ? null : pathCapabilities.grant(r.filePaths[0], 'torrent');
});
handle('dialog:registerDroppedTorrent', async target => {
  if (typeof target !== 'string' || !/\.torrent$/i.test(target.trim()) || !path.isAbsolute(target)) throw new Error('Drop a local .torrent metadata file.');
  const exactTarget = path.resolve(target);
  const approval = await showReview(localTorrentFileReview(exactTarget));
  if (approval.response !== 1) return null;
  await readTorrent(exactTarget); // validates type, size, links, and the opened object after review
  return pathCapabilities.grant(exactTarget, 'torrent');
});
handle('dialog:pickModelFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'openDirectory'], title: 'Pick a model file or folder to share',
  });
  return r.canceled ? null : pathCapabilities.grant(r.filePaths[0], 'seed');
});
handle('dialog:pickCompletedDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Where should finished models go?' });
  return r.canceled ? null : pathCapabilities.grant(r.filePaths[0], 'completed');
});

async function openExternal(value) {
  const accepted = privacy.accepted;
  const destination = classifyExternalUrl(value, { accepted });
  if (destination.requiresNativeReview) {
    const approval = await showReview(externalUrlReview(destination.url));
    if (approval.response !== 1) return { cancelled: true };
    const current = classifyExternalUrl(destination.url, { accepted: privacy.accepted });
    if (!accepted || !privacy.accepted || current.url !== destination.url || !current.requiresNativeReview) {
      throw new Error('The external link authorization changed during review. Review the link again.');
    }
  }
  await shell.openExternal(destination.url);
  return { cancelled: false };
}
handle('shell:openExternal', openExternal);

async function pickPath() {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'openDirectory'],
    title: 'Choose a model file or folder to share',
  });
  return r.canceled ? null : r.filePaths[0];
}

/* ------------------------------------------------------------ HF IPC */

handle('hf:search', async (q, options) => {
  const query = String(q ?? '');
  const input = typeof options === 'object' && options ? options : { limit: Number(options) || 40 };
  // Anonymous, read-only search is covered by the terms accepted on first launch (the privacy gate blocks
  // this channel until then) and disclosed in the privacy notice. Gated, authenticated and download
  // requests keep their exact-request reviews.
  const result = await hfBrowse(query, input);
  return { ...result, cancelled: false };
});
handle('hf:facets', () => hfFacets());

let pirateFaceSearchAbort = null;
let pirateFaceDetailAbort = null;

handle('pirateface:search', async (q, options) => {
  const { normalized, endpoint } = normalizePirateFaceQuery(q);
  if (!normalized) {
    return { query: '', endpoint: '', models: [], source: 'pirateface', cancelled: false };
  }
  const input = typeof options === 'object' && options ? options : { limit: Number(options) || 50 };
  const approval = await showReview(pirateFaceBrowseReview({ endpoint, target: normalized }));
  if (approval.response !== 1) return { query: normalized, endpoint, models: [], source: 'pirateface', cancelled: true };
  pirateFaceSearchAbort?.abort();
  const controller = new AbortController();
  pirateFaceSearchAbort = controller;
  try {
    const result = await pirateFaceSearch(normalized, { limit: input.limit, signal: controller.signal });
    return { ...result, cancelled: false };
  } catch (error) {
    if (controller.signal.aborted) return { query: normalized, endpoint, models: [], source: 'pirateface', aborted: true, cancelled: false };
    throw error;
  } finally {
    if (pirateFaceSearchAbort === controller) pirateFaceSearchAbort = null;
  }
});

handle('pirateface:torrents', async (repoId, options) => {
  const input = typeof options === 'object' && options ? options : {};
  const quant = input.quant ? String(input.quant) : '';
  const acceptTerms = input.acceptTerms ? String(input.acceptTerms) : '';
  const { repo, endpoint } = pirateFaceTorrentsEndpoint(repoId, { quant, acceptTerms });
  const approval = await showReview(pirateFaceBrowseReview({ endpoint, target: repo }));
  if (approval.response !== 1) return { cancelled: true };
  if (acceptTerms) {
    const termsApproval = await showReview(pirateFaceTermsReview({
      repoId: repo,
      endpoint,
      termsId: acceptTerms,
      termsName: typeof input.termsName === 'string' ? input.termsName : acceptTerms,
      termsUrl: typeof input.termsUrl === 'string' ? input.termsUrl : '',
      policyUrl: typeof input.policyUrl === 'string' ? input.policyUrl : '',
    }));
    if (termsApproval.response !== 1) return { cancelled: true };
  }
  pirateFaceDetailAbort?.abort();
  const controller = new AbortController();
  pirateFaceDetailAbort = controller;
  try {
    const result = await pirateFaceRepoTorrents(repo, { quant, acceptTerms, signal: controller.signal });
    return { ...result, cancelled: false };
  } catch (error) {
    if (controller.signal.aborted) return { aborted: true, cancelled: false };
    throw error;
  } finally {
    if (pirateFaceDetailAbort === controller) pirateFaceDetailAbort = null;
  }
});

async function authorizeAuthenticatedHfRequest(action, repoId, revision) {
  const credential = currentHfCredentialContext();
  const endpoint = hfAuthenticatedEndpoint({ action, repoId, revision });
  if (!credential.authenticated) {
    // Anonymous public metadata (model details, refs) is the same read-only class as search and is
    // covered by the first-launch terms. Using the saved account always requires an exact review below.
    return { cancelled: false, token: undefined };
  }
  const approval = await showReview(authenticatedHfRequestReview({
    action, endpoint, repoId, revision, user: credential.user, tokenGeneration: credential.generation,
  }));
  if (approval.response !== 1) return { cancelled: true };
  const current = requireUnchangedHfCredential(credential,
    'The saved Hugging Face credential changed during review. Review the authenticated request again.');
  if (hfAuthenticatedEndpoint({ action, repoId, revision }) !== endpoint) {
    throw new Error('The Hugging Face request changed during review. Review it again.');
  }
  return { cancelled: false, token: current.token };
}

handle('hf:model', async (repoId, revision) => {
  const repo = validateHfRepoId(repoId);
  const rev = revision === undefined || revision === null || revision === '' ? undefined : normalizeHfRevision(revision);
  const authorization = await authorizeAuthenticatedHfRequest('model', repo, rev);
  if (authorization.cancelled) return { cancelled: true };
  const result = await hfModelInfo(repo, { token: authorization.token, revision: rev });
  return result;
});
// Model cards are fetched anonymously (same public read class as search, covered by the first-launch terms) so
// the saved token is never sent for README text. Gated cards report restricted instead of prompting.
handle('hf:readme', async (repoId, revision) => {
  const repo = validateHfRepoId(repoId);
  const rev = revision === undefined || revision === null || revision === '' ? 'main' : normalizeHfRevision(revision);
  return hfReadme(repo, { revision: rev });
}, { notifyErrors: false });
handle('hf:card-image', async url => {
  if (store.getSettings().modelCardImages === false) throw new Error('Model card images are turned off in Settings.');
  return fetchCardImage(url);
}, { notifyErrors: false });
handle('hf:refs', async repoId => {
  const repo = validateHfRepoId(repoId);
  const authorization = await authorizeAuthenticatedHfRequest('refs', repo);
  if (authorization.cancelled) return { cancelled: true };
  const result = await hfRefs(repo, { token: authorization.token });
  return result;
});

function requireEmptyHfDestination(dest) {
  try {
    fs.lstatSync(dest);
    throw new Error('A file already exists at this HuggingFace destination. Move or remove it before retrying.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}


handle('publisher:create', request => publisher.create(request));
handle('publisher:import', request => publisher.create(request, true));
handle('publisher:unlock', password => publisher.unlock(password));
handle('publisher:lock', () => publisher.lock());
handle('publisher:export-mnemonic', password => publisher.export(password));
handle('publisher:acknowledge-backup', request => publisher.acknowledge(request));
handle('publisher:close-reveal', id => publisher.closeReveal(id));
handle('publisher:clear', () => publisher.clear());

handle('hf:token:set', async (token) => {
  const t = String(token ?? '').trim();
  const before = hfCredentialStateSnapshot(store.state);
  const currentUser = typeof store.state.hfUser === 'string' ? store.state.hfUser : '';
  const currentRole = typeof store.state.hfRole === 'string' ? store.state.hfRole : '';
  const hasSavedCredential = Boolean(store.state.hfTokenEnc || store.state.hfTokenMigrationRequired || Object.hasOwn(store.state, 'hfTokenPlain'));
  if (!t) {
    if (!hasSavedCredential) return { cleared: true, cancelled: false };
    const approval = await showReview(hfCredentialChangeReview({ action: 'clear', currentUser, currentRole }));
    if (approval.response !== 1) return { cleared: false, cancelled: true };
    if (hfCredentialStateSnapshot(store.state) !== before) throw new Error('The saved Hugging Face credential changed during review. Review the removal again.');
    hfTokenClear();
    return { cleared: true, cancelled: false };
  }
  const submitted = describeHfToken(t);
  const validationApproval = await showReview(hfTokenValidationReview({
    endpoint: HF_WHOAMI_ENDPOINT, byteLength: submitted.byteLength, fingerprint: submitted.fingerprint,
  }));
  if (validationApproval.response !== 1) return { cancelled: true };
  if (hfCredentialStateSnapshot(store.state) !== before
    || describeHfToken(t).fingerprint !== submitted.fingerprint) {
    throw new Error('The Hugging Face credential changed during review. Validate the token again.');
  }
  const who = await hfWhoami(t);
  if (!who.valid) throw new Error('HuggingFace says that token is invalid.');
  const approval = await showReview(hfCredentialChangeReview({
    action: 'set', currentUser, currentRole, nextUser: who.user, nextRole: who.role,
  }));
  if (approval.response !== 1) return { cancelled: true };
  if (hfCredentialStateSnapshot(store.state) !== before) throw new Error('The saved Hugging Face credential changed during review. Validate and review the new token again.');
  if (safeStorage?.isEncryptionAvailable?.() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text') {
    store.setHfCredentialState({ hfTokenEnc: safeStorage.encryptString(t).toString('base64'), hfTokenPlain: undefined,
      hfTokenMigrationRequired: false, hfUser: who.user, hfRole: who.role });
  } else {
    throw new Error(`Secure token storage is unavailable. ${credentialRecovery} and try again.`);
  }
  return { user: who.user, role: who.role, encrypted: !!store.state.hfTokenEnc, cancelled: false };
});

handle('hf:download', async ({ repoId, revision, files, source = 'hf', peerDeviceId = devices.selectedId }) => {
  if (!['hf', 'hybrid'].includes(source)) throw new Error('Choose HuggingFace or HF + device.');
  if (source === 'hybrid') devices.record(peerDeviceId);
  const repo = validateHfRepoId(repoId);
  const rev = typeof revision === 'string' && /^[a-f0-9]{40}$/i.test(revision) ? revision.toLowerCase() : '';
  if (!rev) throw new Error('Choose model metadata with a pinned Hugging Face revision before downloading.');
  if (!Array.isArray(files) || !files.length) throw new Error('Nothing selected to download.');
  if (files.length > 2000) throw new Error('Choose no more than 2,000 files at once.');
  const list = files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file) || typeof file.path !== 'string' || file.path.length > 4096) throw new Error('A selected HuggingFace file is invalid.');
    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('A selected HuggingFace file has an invalid size.');
    // Pinned LFS digest from model metadata; used to verify the download when the
    // CDN ETag is absent or weak (A5). Shape-validated, never trusted blindly.
    const sha256 = /^[a-f0-9]{64}$/i.test(file.sha256 || '') ? String(file.sha256).toLowerCase() : null;
    return { path: file.path, size, sha256 };
  });
  validateHfDownloadSelection(repo, list.map(file => file.path));
  const queueSnapshot = new Map(hfDownloads);
  const base = path.resolve(store.getSettings().downloadDir);
  const created = [], queued = [];
  const nextDownloads = new Map(hfDownloads);
  for (const f of list) hfDestination(base, repo, f.path);
  const candidateIds = list.map(file => hfTransferId(repo, rev, file.path, base));
  if (hfDownloads.size + candidateIds.filter(id => !hfDownloads.has(id)).length > 10_000) {
    throw new Error('Download history is full. Clear finished HuggingFace transfers before starting more.');
  }
  for (const f of list) {
    const id = hfTransferId(repo, rev, f.path, base);
    const existing = nextDownloads.get(id);
    const dest = hfDestination(base, repo, f.path);
    const namespaceKeys = hfDestinationPathKeys(dest);
    const namespace = new Set(namespaceKeys);
    for (const record of nextDownloads.values()) {
      if (record.id === id) continue;
      const other = hfDestinationPathKeys(record.dest);
      if (!other.some(key => namespace.has(key))) continue;
      const sameFile = record.repoId === repo && record.filePath === f.path && other[0] === namespaceKeys[0];
      if (sameFile && !['active', 'queued'].includes(record.status)) continue;
      throw new Error(sameFile
        ? 'Another revision of this file is already downloading.'
        : 'A selected HuggingFace file conflicts with another download filename.');
    }
    if (existing?.status === 'done') continue;
    if (existing && existing.status !== 'done' && existing.status !== 'error' && existing.status !== 'cancelled') continue;
    requireEmptyHfDestination(dest);
    if (existing) nextDownloads.delete(id); // retry of a finished/failed row
    const rec = {
      id,
      repoId: repo,
      source,
      peerDeviceId: source === 'hybrid' ? peerDeviceId : undefined,
      revision: rev,
      filePath: f.path,
      dest,
      baseDir: base,
      total: Number(f.size) || 0,
      sha256: f.sha256 || null,
      downloaded: 0,
      speedBps: 0,
      etaMs: 0,
      status: 'queued',
      error: '',
      startedAt: 0,
    };
    nextDownloads.set(id, rec);
    queued.push(rec);
    created.push(id);
  }
  if (!queued.length) {
    return { started: [], cancelled: false, downloads: [...hfDownloads.values()].map(publicHfTransfer) };
  }
  const credential = currentHfCredentialContext();
  const authorization = createHfDownloadAuthorization({
    repoId: repo, revision: rev, root: base,
    files: queued.map(record => ({ path: record.filePath, size: record.total })),
    generation: credential.generation,
  });
  const approval = await showReview(hfDownloadReview({
    repoId: repo, revision: rev, root: base, fileCount: authorization.fileCount,
    totalBytes: authorization.totalBytes, manifestDigest: authorization.manifestDigest,
    tokenGeneration: authorization.tokenGeneration, user: credential.user, action: 'start',
  }));
  if (approval.response !== 1) {
    return { started: [], cancelled: true, downloads: [...hfDownloads.values()].map(publicHfTransfer) };
  }
  if (!sameHfQueueSnapshot(queueSnapshot)) {
    throw new Error('The Hugging Face queue changed during download review. Review the current queue again.');
  }
  const currentCredential = requireUnchangedHfCredential(credential,
    'The saved Hugging Face credential changed during download review. Review the current request again.');
  if (path.resolve(store.getSettings().downloadDir) !== base) {
    throw new Error('The Hugging Face download folder changed during review. Review the current destination again.');
  }
  const currentAuthorization = createHfDownloadAuthorization({
    repoId: repo, revision: rev, root: base,
    files: queued.map(record => ({ path: record.filePath, size: record.total })),
    generation: currentCredential.generation,
  });
  if (currentAuthorization.requestDigest !== authorization.requestDigest) {
    throw new Error('The Hugging Face download changed during review. Review the current request again.');
  }
  for (const record of queued) {
    record.authorization = hfTransferAuthorization(authorization, { path: record.filePath, size: record.total });
  }
  // Commit the durable queue before exposing it to the worker. A failed state
  // write must not leave an RPC-rejected download parked in memory.
  persistHf(nextDownloads);
  hfDownloads.clear();
  for (const [id, record] of nextDownloads) hfDownloads.set(id, record);
  hfQueue.push(...queued);
  hfPump();
  return { started: created, cancelled: false, downloads: [...hfDownloads.values()].map(publicHfTransfer) };
});

handle('hf:pause', ({ id }) => {
  const rec = hfDownloads.get(id);
  if (!rec || !['active', 'queued'].includes(rec.status)) return false;
  const previous = { pauseRequested: rec.pauseRequested, status: rec.status };
  rec.pauseRequested = true;
  if (rec.status === 'queued') rec.status = 'paused';
  try { persistHf(); }
  catch (error) { Object.assign(rec, previous); throw error; }
  if (previous.status === 'active') rec.controller.abort();
  else delete rec.controller;
  pushHfState(); return true;
});
async function resumeLocalHf(ids) {
  ids = validateHfResumeIds(ids);
  const records = ids.map(id => hfDownloads.get(id));
  const credential = currentHfCredentialContext();
  const { authorization, snapshots } = prepareHfResume(records, credential.generation);
  const approval = await showReview(hfDownloadReview({
    ...authorization, user: credential.user, action: 'resume',
  }));
  if (approval.response !== 1) return { cancelled: true };
  requireUnchangedHfCredential(credential,
    'The saved Hugging Face credential changed during resume review. Review the current request again.');
  if (records.some((record, index) => hfDownloads.get(record.id) !== record
    || hfResumeRecordSnapshot(record) !== snapshots[index])) {
    throw new Error('The Hugging Face transfer changed during review. Review the current request again.');
  }
  if (shuttingDown) throw new Error('FrostByte is shutting down. Resume after restarting.');
  const resumed = records.map(record => ({ ...record, pauseRequested: false, cancelled: false,
    error: '', status: 'queued', authorization: hfTransferAuthorization(authorization, { path: record.filePath, size: record.total }) }));
  const nextDownloads = new Map(hfDownloads);
  for (const record of resumed) nextDownloads.set(record.id, record);
  // Publish the entire approved group durably before any worker can start.
  persistHf(nextDownloads);
  for (const record of resumed) hfDownloads.set(record.id, record);
  hfQueue.push(...resumed); hfPump(); pushHfState();
  return { cancelled: false, resumed: ids };
}

handle('hf:resume', ({ id }) => {
  const record = hfDownloads.get(id);
  if (!record || !['paused', 'error'].includes(record.status)) return false;
  return resumeLocalHf([id]);
});
handle('hf:resume-group', ({ ids, device, deviceId } = {}) => {
  if (device === 'local') return resumeLocalHf(ids);
  if (device === 'spark' && typeof deviceId === 'string' && deviceId) return resumeRemoteHf(ids, deviceId);
  throw new Error('Choose the device that holds this model download.');
});
handle('hf:cancel', ({ id }) => {
  const rec = hfDownloads.get(id);
  if (!rec) return false;
  if (rec.status === 'queued') {
    const previous = rec.status; rec.status = 'paused'; rec.pauseRequested = true;
    try { persistHf(); } catch (error) { rec.status = previous; rec.pauseRequested = false; throw error; }
  } else if (rec.status === 'active') {
    const previous = rec.cancelled;
    rec.cancelled = true;
    try { persistHf(); }
    catch (error) { rec.cancelled = previous; throw error; }
    rec.controller.abort();
  } else return false;
  pushHfState();
  return true;
});

handle('hf:remove', async ({ ids } = {}) => {
  if (!Array.isArray(ids) || !ids.length || ids.length > 10_000 || ids.some(id => typeof id !== 'string')) {
    throw new Error('Choose one or more model transfer records to remove.');
  }
  const selected = new Set(ids);
  const records = [...selected].map(id => hfDownloads.get(id)).filter(Boolean);
  if (records.some(record => ['active', 'queued'].includes(record.status))) {
    throw new Error('Pause or cancel active downloads before removing their transfer records.');
  }
  const partials = records.filter(record => record.status !== 'done');
  let removePartials = false, plans;
  if (partials.length) {
    // A missing/unmounted drive must not prevent keeping recoverable history.
    let cleanupError;
    try { plans = planHfPartials(partials); } catch (error) { cleanupError = error.message; }
    const approval = await showReview({ type: 'warning', buttons: ['Cancel', 'Keep resumable files', ...(plans ? ['Delete partial files'] : [])], defaultId: 0, cancelId: 0,
      message: 'Remove these model transfers?', summary: `${partials.length} unfinished files. Completed files stay in My Models.`,
      detail: records.map(row => row.dest).join('\n') + '\n\nKeeping files saves their resume records in Hidden & retained entries. Deleting partials cannot be undone.' + (cleanupError ? '\nCleanup unavailable: ' + cleanupError : '') });
    if (approval.response === 0) return { cancelled: true };
    removePartials = approval.response === 2;
    if (records.some(row => hfDownloads.get(row.id) !== row || ['active', 'queued'].includes(row.status))) throw new Error('A transfer changed during review. Pause and review again.');
    const retained = (store.state.retainedHf || []).filter(row => !selected.has(row.id));
    if (retained.length + partials.length > 10000) throw new Error('Restore or clean retained downloads before removing more.');
    store._commitStateFields({ retainedHf: [...retained, ...partials.map(row => normalizeHfTransferRecord({ ...row, status: 'paused', cancelled: false }))] });
    if (removePartials) deleteHfPartials(plans);
  }
  inventory.migrateHf(records);
  const nextDownloads = new Map(hfDownloads);
  for (const id of selected) nextDownloads.delete(id);
  store._commitStateFields({ hfDownloads: [...nextDownloads.values()].map(row => normalizeHfTransferRecord(row)),
    retainedHf: (store.state.retainedHf || []).filter(row => !removePartials || !selected.has(row.id)) });
  hfDownloads.clear();
  for (const [id, record] of nextDownloads) hfDownloads.set(id, record);
  pushHfState();
  return true;
});

handle('hf:restore-retained', async ({ id, deviceId }) => {
  if (deviceId) { await sparkRequest(sparkProfile(deviceId), { action: 'hf:restore', id }); await sparkStatusWithInventory({ force: true, deviceId }); return currentState(); }
  const saved = (store.state.retainedHf || []).find(row => row.id === id);
  if (!saved) throw new Error('This retained transfer is no longer available.');
  const record = normalizeHfTransferRecord({ ...saved, status: 'paused', cancelled: false }, { forRestore: true });
  if (hfDownloads.has(id)) throw new Error('This transfer is already present.');
  const next = new Map(hfDownloads); next.set(id, record);
  store._commitStateFields({ hfDownloads: [...next.values()].map(row => normalizeHfTransferRecord(row)), retainedHf: store.state.retainedHf.filter(row => row.id !== id) });
  hfDownloads.set(id, record); pushHfState(); return currentState();
});

handle('hf:clear', (ids) => {
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 10000 || ids.some(id => typeof id !== 'string'))) throw new Error('Invalid download selection.');
  const selected = ids === undefined ? null : new Set(ids);
  // A completed shard can still belong to an unfinished model. The grouped UI
  // supplies only files from fully completed models; older callers retain clear-all behavior.
  inventory.migrateHf([...hfDownloads.values()]);
  const nextDownloads = new Map(hfDownloads);
  for (const [id, rec] of nextDownloads) {
    if ((!selected || selected.has(id)) && rec.status === 'done') {
      nextDownloads.delete(id);
    }
  }
  persistHf(nextDownloads);
  hfDownloads.clear();
  for (const [id, record] of nextDownloads) hfDownloads.set(id, record);
  pushHfState();
  return true;
});

handle('hf:reveal', ({ dest }) => revealKnownPath(dest));

/* ------------------------------------------------------------------- Hub */
/**
 * Handlers return the raw payload; handle() wraps every result as { ok, data }.
 * Refusals still need an explicit shape, so they throw HubRefusal, which
 * handle() turns into { ok: false, error } and the renderer can branch on.
 */
class HubRefusal extends Error {
  constructor(message, code = 'hub_error') { super(message); this.code = code; }
}
const refuse = (message, code) => new HubRefusal(message, code);
const hubErr = (err) => { throw err instanceof HubRefusal ? err : new HubRefusal(err?.message || 'Hub request failed.', err?.code || 'hub_error'); };
/** Map a Firebase auth error to a Hub refusal, preserving the friendly message. */
const firebaseErr = (err) => {
  if (err instanceof HubRefusal) throw err;
  const message = err?.message || 'Firebase sign-in failed.';
  // Map on the stable Firebase machine code (set by firebase-auth.js), not prose.
  const machine = String(err?.code || '').split(' : ')[0].trim();
  const codeByMachine = {
    EMAIL_NOT_FOUND: 'hub_bad_credentials',
    INVALID_PASSWORD: 'hub_bad_credentials',
    INVALID_LOGIN_CREDENTIALS: 'hub_bad_credentials',
    USER_DISABLED: 'hub_bad_credentials',
    EMAIL_EXISTS: 'hub_email_exists',
    WEAK_PASSWORD: 'hub_weak_password',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'hub_rate_limited',
    INVALID_EMAIL: 'hub_bad_request',
    MISSING_PASSWORD: 'hub_bad_request',
    TOKEN_EXPIRED: 'hub_unauthorized',
    INVALID_REFRESH_TOKEN: 'hub_unauthorized',
    MISSING_REFRESH_TOKEN: 'hub_unauthorized',
    INVALID_GRANT_TYPE: 'hub_unauthorized',
  };
  throw new HubRefusal(message, codeByMachine[machine] || 'hub_auth_error');
};

// A signed Hub feed is trusted only after its ed25519 signature over BUNDLE_DOMAIN
// verifies. TLS authenticates the origin; this authenticates the content, so a
// compromised or hostile Hub cannot forge version/digest/severity nudges (A2).
// The envelope is { ...feedBody, signature, feedPubKey }; returns the normalized feed.
function verifiedUpdateFeed(data) {
  if (!data || typeof data !== 'object' || typeof data.signature !== 'string' || typeof data.feedPubKey !== 'string') {
    throw refuse('Hub update feed is not signed.', 'hub_unsigned_feed');
  }
  if (!verifyUpdateFeed(data)) {
    throw refuse('Hub update feed signature is invalid.', 'hub_bad_signature');
  }
  const feed = normalizeUpdateFeed(data);
  if (!feed) throw refuse('Hub returned no usable update feed.', 'hub_bad_feed');
  return feed;
}

handle('hub:search', async (request) => {
  const client = await hubClient() || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!await reviewHub(client, 'search')) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  const res = await client.search(request || {}).catch(hubErr);
  if (!res) throw refuse('No Hub result.', 'hub_not_found');
  return { ...res.data, etag: res.etag };
});
handle('hub:recipe', async (request) => {
  const client = await hubClient() || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!await reviewHub(client, 'recipe')) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  const res = await client.recipe(request?.id, { etag: request?.etag }).catch((err) => {
    // P2 tombstone contract: a withdrawn recipe is 410, not "not found" —
    // surface it distinctly so the UI can explain the withdraw.
    if (err?.status === 410) throw refuse('This recipe was withdrawn by its publisher.', 'hub_withdrawn');
    throw hubErr(err);
  });
  if (!res) throw refuse('Recipe is not listed.', 'hub_not_found');
  if (res.status === 304) return { notModified: true, etag: res.etag };
  return { ...res.data, etag: res.etag };
});
handle('hub:manifest', async (request) => {
  const client = await hubClient() || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!await reviewHub(client, 'manifest')) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  const res = request?.digest
    ? await client.manifestByDigest(String(request.digest), { etag: request?.etag }).catch(hubErr)
    : await client.recipeManifest(request?.id, { etag: request?.etag }).catch(hubErr);
  if (!res) throw refuse('Manifest is not available.', 'hub_not_found');
  if (res.status === 304) return { notModified: true, etag: res.etag };
  return { ...res.data, etag: res.etag };
});
handle('hub:creator', async (pubkey, etag) => {
  const client = await hubClient() || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!await reviewHub(client, 'creator')) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  const res = await client.creator(String(pubkey || ''), { etag }).catch(hubErr);
  if (!res) throw refuse('Creator is not listed.', 'hub_not_found');
  if (res.status === 304) return { notModified: true, etag: res.etag };
  return { ...res.data, etag: res.etag };
});
handle('hub:creator-by-handle', async (handle) => {
  const check = validateHandle(handle);
  if (!check.ok) throw refuse(check.message, 'hub_bad_request');
  const client = await hubClient() || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!await reviewHub(client, 'creator')) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  const res = await client.creatorByHandle(check.handle).catch(hubErr);
  if (!res) throw refuse('No creator with that handle.', 'hub_not_found');
  return res.data;
});

// ---- Account management (ADR 003) -------------------------------------------
// Every mutation is session-authenticated, native-reviewed, and validated in
// main against the shared rules before anything leaves the device. After a
// successful write the cached account is refreshed from the server so the
// renderer never displays a locally-claimed profile as verified.

async function refreshVerifiedAccount(client) {
  const res = await client.me().catch(hubErr);
  if (!res?.data) throw refuse('Hub account endpoint was not found.', 'hub_not_found');
  const existing = getHubAccountStore(store);
  const account = applyHubAccount(store, {
    ...res.data,
    tenantId: res.data.tenantId || existing.tenantId || '',
    desktopSessionId: existing.desktopSessionId || '',
    isAdmin: Boolean(res.data.isAdmin),
    verifiedAt: Date.now(),
  }, client.origin);
  const entitlement = syncVerifiedHubEntitlement(res.data.entitlement);
  push('hub:changes', { account, entitlement });
  return { account, entitlement };
}

async function accountClient(action) {
  evictStaleTenantHubSession();
  const client = await hubClient({ authenticated: true }) || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!client.getToken()) throw refuse('Sign in to your FrostByte account first.', 'hub_unauthorized');
  if (!await reviewHub(client, action, { authenticated: true })) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  return client;
}

handle('hub:update-me', async (patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw refuse('A profile patch is required.', 'hub_bad_request');
  const keys = Object.keys(patch);
  if (!keys.length) throw refuse('Nothing to update.', 'hub_bad_request');
  const clean = {};
  for (const key of keys) {
    if (!CLIENT_WRITABLE_USER_FIELDS.includes(key)) {
      if (key === 'handle') throw refuse('Use the handle control to change your handle.', 'hub_bad_request');
      throw refuse(`Field "${key}" cannot be edited from the app.`, 'hub_bad_request');
    }
    if (key === 'bio') {
      const check = validateBio(patch.bio);
      if (!check.ok) throw refuse(check.message, 'hub_bad_request');
      clean.bio = check.bio;
    } else if (key === 'displayName') {
      const check = validateDisplayName(patch.displayName);
      if (!check.ok) throw refuse(check.message, 'hub_bad_request');
      clean.displayName = check.displayName;
    } else if (key === 'photoUrl') {
      const check = validatePhotoUrl(patch.photoUrl);
      if (!check.ok) throw refuse(check.message, 'hub_bad_request');
      clean.photoUrl = check.photoUrl;
    } else {
      clean[key] = patch[key];
    }
  }
  const client = await accountClient('update-profile');
  await client.updateMe(clean).catch(hubErr);
  return refreshVerifiedAccount(client);
});

handle('hub:set-handle', async (handle) => {
  const check = validateHandle(handle);
  if (!check.ok) throw refuse(check.message, 'hub_bad_request');
  const client = await accountClient('set-handle');
  const res = await client.setHandle(check.handle).catch(hubErr);
  const refreshed = await refreshVerifiedAccount(client);
  return { ...refreshed, handle: res?.data?.handle || check.handle };
});

handle('hub:release-handle', async () => {
  const client = await accountClient('release-handle');
  await client.releaseHandle().catch(hubErr);
  return refreshVerifiedAccount(client);
});

handle('hub:publisher-keys', async () => {
  const client = await accountClient('publisher-keys');
  const res = await client.publisherKeys().catch(hubErr);
  return { keys: Array.isArray(res?.data?.keys) ? res.data.keys : [] };
});

handle('hub:bind-publisher', async () => {
  // The challenge is issued for THIS device's publisher key only; the renderer
  // never supplies a key or a signature. Signing happens in main with the
  // keychain-unlocked session, exactly like publication signing.
  const status = publisher.status();
  if (!status.present || status.invalid) throw refuse('Create a publisher identity first (Settings → Publisher).', 'hub_bad_request');
  if (!status.unlocked) throw refuse('Unlock your publisher identity first (Settings → Publisher).', 'hub_publisher_locked');
  const keyCheck = validatePubKey(status.pubKey);
  if (!keyCheck.ok) throw refuse('This publisher key is malformed.', 'hub_bad_request');
  const client = await accountClient('publisher-bind');
  const challenge = await client.publisherChallenge(keyCheck.pubKey).catch(hubErr);
  const { challengeId, nonce } = challenge?.data || {};
  if (!challengeId || typeof nonce !== 'string') throw refuse('Hub did not issue a binding challenge.', 'hub_error');
  let signature;
  try {
    // Domain-separated bind frame: the Hub-supplied nonce is embedded, never
    // signed raw. A hostile Hub cannot smuggle other protocol payloads.
    signature = publisher.signChallenge(publisher.bindChallengeMessage(keyCheck.pubKey, nonce));
  }
  catch (err) { throw refuse(err.message || 'Could not sign the binding challenge.', 'hub_publisher_locked'); }
  const res = await client.bindPublisherKey({ pubKey: keyCheck.pubKey, challengeId, signature }).catch(hubErr);
  const refreshed = await refreshVerifiedAccount(client);
  note('Publisher key bound to your FrostByte account.', 'ok');
  return { ...refreshed, pubKey: res?.data?.pubKey || keyCheck.pubKey, boundAt: res?.data?.boundAt || '' };
});

handle('hub:unbind-publisher', async (pubKey) => {
  const check = validatePubKey(pubKey);
  if (!check.ok) throw refuse(check.message, 'hub_bad_request');
  const client = await accountClient('publisher-unbind');
  await client.unbindPublisherKey(check.pubKey).catch(hubErr);
  return refreshVerifiedAccount(client);
});
// Recipe files must be grounded in real, completed downloads on this device.
// The renderer's size/sha256 claims are NOT trusted: we recompute SHA-256 from
// the actual local bytes and re-stat the size, so a published recipe always
// describes files that really exist here and match what was downloaded. This
// also covers non-LFS files (no Hub SHA-256) and restored transfer records
// (normalizeHfTransferRecord does not persist sha256).
async function verifiedRecipeFiles(manifest) {
  const repoId = manifest?.modelRef?.repoId;
  const revision = String(manifest?.modelRef?.revision || '').toLowerCase();
  if (!repoId || !/^[a-f0-9]{40}$/.test(revision)) {
    throw refuse('A recipe must pin a model repo and a 40-character Hugging Face revision.', 'hub_manifest_invalid');
  }
  const claimed = Array.isArray(manifest?.files) ? manifest.files : [];
  if (!claimed.length) throw refuse('A recipe must list at least one file.', 'hub_manifest_invalid');
  if (claimed.length > RECIPE_MAX_FILES) throw refuse(`A recipe can list at most ${RECIPE_MAX_FILES} files.`, 'hub_manifest_invalid');
  // Dedupe before hashing so a repeated path never triggers a multi-GB rehash.
  // The validator also rejects duplicates (NFD-lowercase), but only after we
  // would have hashed each copy — fail fast here instead.
  const seen = new Set();
  const unique = [];
  for (const file of claimed) {
    const key = String(file?.path ?? '').normalize('NFD').toLowerCase();
    if (seen.has(key)) throw refuse(`Duplicate file path "${file?.path}" in the recipe.`, 'hub_manifest_invalid');
    seen.add(key);
    unique.push(file);
  }
  const byPath = new Map();
  for (const record of hfDownloads.values()) {
    if (record.status === 'done' && record.repoId === repoId && String(record.revision).toLowerCase() === revision) {
      byPath.set(record.filePath, record);
    }
  }
  const files = [];
  for (const file of unique) {
    const record = byPath.get(file?.path);
    if (!record) throw refuse(`File "${file?.path}" is not a completed download of ${repoId} on this device. Download it first.`, 'hub_recipe_file_missing');
    let stat;
    try { stat = await fs.promises.stat(record.dest); }
    catch { throw refuse(`The downloaded file for "${file.path}" is missing from disk. Re-download it before publishing.`, 'hub_recipe_file_missing'); }
    if (!stat.isFile()) throw refuse(`"${file.path}" is not a regular file on disk.`, 'hub_recipe_file_missing');
    const sha256 = await sha256File(record.dest);
    // Integrity: when the live transfer record carries the Hub LFS SHA-256 the
    // download was verified against, the local bytes MUST still match it. A
    // locally modified/corrupted file would otherwise publish a "truthful-to-
    // disk" hash that consumers downloading the original HF bytes could never
    // verify. Restored records lack sha256 (not persisted), so this check is
    // live-session-only; the rehash still grounds those to real local bytes.
    if (record.sha256 && record.sha256 !== sha256) {
      throw refuse(`"${file.path}" no longer matches the hash it was downloaded with. It may have been modified or corrupted — re-download it before publishing.`, 'hub_recipe_file_modified');
    }
    // Re-stat AFTER hashing so size and sha256 describe the same file state
    // (a concurrent append between stat and hash would otherwise split them).
    let post;
    try { post = await fs.promises.stat(record.dest); }
    catch { throw refuse(`The downloaded file for "${file.path}" disappeared during hashing. Re-download it before publishing.`, 'hub_recipe_file_missing'); }
    if (post.size !== stat.size) throw refuse(`"${file.path}" changed size while being hashed. Re-download it before publishing.`, 'hub_recipe_file_modified');
    files.push({ path: record.filePath, size: post.size, sha256 });
  }
  return files;
}

handle('hub:publish', async (manifest) => {
  // P2 share loop. Signing happens in main with the keychain-unlocked session;
  // the renderer supplies the manifest but NEVER a key or signature. The
  // NORMALIZED manifest returned by signRecipe is exactly what gets transmitted
  // (review B4) — sending the raw object would change the digest server-side.
  const status = publisher.status();
  if (!status.present || status.invalid) throw refuse('Create a publisher identity first (Settings → Publisher).', 'hub_bad_request');
  if (!status.unlocked) throw refuse('Unlock your publisher identity first (Settings → Publisher).', 'hub_publisher_locked');
  // Ground the file list in real local downloads BEFORE signing: recompute
  // size + SHA-256 from disk so the signed manifest is truthful.
  const grounded = { ...manifest, files: await verifiedRecipeFiles(manifest) };
  let signed;
  try { signed = publisher.signRecipe(grounded); }
  catch (err) { throw refuse(err.message || 'Could not sign the recipe.', 'hub_manifest_invalid'); }
  const client = await accountClient('recipe-publish');
  // accountClient already ran the native review for 'recipe-publish' — a
  // second reviewHub('publish') here would double-prompt AND throw (no such
  // label). One review per request, at the credential boundary.
  const res = await client.publishRecipe({
    manifest: signed.manifest, digest: signed.digest, terms: HUB_PUBLISH_TERMS, signature: signed.signature,
  }).catch(hubErr);
  note(`Recipe "${signed.manifest.title}" published to FrostNet.`, 'ok');
  return { ...(res?.data || {}), manifest: signed.manifest };
});
handle('hub:withdraw', async (id) => {
  if (!/^[a-z0-9-]{1,64}$/.test(id || '')) throw refuse('Invalid recipe id.', 'hub_bad_request');
  const client = await accountClient('recipe-withdraw');
  // Single review via accountClient('recipe-withdraw') — see hub:publish.
  const res = await client.withdrawRecipe(id).catch(hubErr);
  note('Recipe withdrawn from FrostNet. Existing downloads remain verifiable.', 'ok');
  return res?.data || { ok: true, id, status: 'withdrawn' };
});
handle('hub:health', async () => {
  // P0 honesty: the Settings "Check Hub" probe must hit the DEPLOYED /v1/health,
  // not /v1/search (not deployed — probing it reported a healthy Hub as
  // unreachable). Anonymous read behind the same native review gate as every
  // other public Hub read; no token is attached.
  const client = await hubClient() || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!await reviewHub(client, 'health')) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  const res = await client.health().catch(hubErr);
  if (!res) throw refuse('Hub health endpoint is not available.', 'hub_not_found');
  return res.data;
});
// P3: a persisted Firebase session means server follows are authoritative.
// Detection is session-shaped (refresh credential bound to the canonical Hub
// origin), never a tier check — free signed-in users follow creators too.
function hubSessionPresent() {
  try {
    const { present, origin } = store.getHubRefreshCredential();
    return Boolean(present && origin === HUB_API_BASE && hubRefreshToken(HUB_API_BASE));
  } catch { return false; }
}

// P3 home feed cache: 60s in-memory TTL + manual Refresh bypass (Gate P3:
// app shows operator content within one feed TTL). Keyed by mode so the
// signed-in following feed never serves the anonymous composition.
const hubFeedCache = new Map();
const HUB_FEED_TTL_MS = 60_000;

function validateFollowKey(pubkey) {
  if (typeof pubkey !== 'string' || !/^[a-f0-9]{64}$/i.test(pubkey)) throw refuse('Follow with a 64-character creator key.', 'hub_bad_request');
  return pubkey.toLowerCase();
}

handle('hub:feed', async (options = {}) => {
  const { limit, cursor, following, refresh } = options && typeof options === 'object' ? options : {};
  const mode = following ? 'following' : 'home';
  if (!refresh) {
    const cached = hubFeedCache.get(mode);
    if (cached && Date.now() - cached.at < HUB_FEED_TTL_MS) return cached.data;
  }
  evictStaleTenantHubSession();
  // Anonymous-readable; following=1 rides the session bearer (server refuses
  // API keys). When signed in, the home feed still works anonymously — the
  // renderer asks for following=1 explicitly.
  const authenticated = mode === 'following';
  const client = await hubClient({ authenticated }) || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (authenticated && !client.getToken()) throw refuse('Sign in to see recipes from creators you follow.', 'hub_unauthorized');
  if (!await reviewHub(client, 'feed', { authenticated })) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  const res = await client.feed({ limit, cursor, following: mode === 'following' }).catch(hubErr);
  if (!res) throw refuse('The FrostNet feed is not available right now.', 'hub_not_found');
  const data = res.data;
  // Cache only first pages (cursors compose; caching mid-walk would strand
  // the client on a stale page).
  if (!cursor) hubFeedCache.set(mode, { at: Date.now(), data });
  return data;
});
handle('hub:announcements', async () => {
  const client = await hubClient() || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!await reviewHub(client, 'announcements')) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  const res = await client.announcements().catch(hubErr);
  if (!res) throw refuse('Announcements are not available right now.', 'hub_not_found');
  return res.data;
});
handle('hub:me-follows', async () => {
  if (!hubSessionPresent()) return { follows: [], local: getHubConfigStore(store).follows, signedIn: false };
  const client = await accountClient('me-follows');
  const res = await client.meFollows().catch(hubErr);
  if (!res) throw refuse('Your follow list is not available right now.', 'hub_not_found');
  return { follows: res.data?.follows || [], limit: res.data?.limit, signedIn: true };
});
handle('hub:follow', async (pubkey) => {
  const key = validateFollowKey(pubkey);
  if (hubSessionPresent()) {
    // Signed-in: the SERVER is the source of truth (P3 review S5/S6 — no
    // dual-write, no cross-account local leakage). Failure leaves state
    // unchanged and surfaces honestly.
    const client = await accountClient('follow');
    await client.follow(key).catch(hubErr);
    hubFeedCache.delete('following');
    return { follows: null, server: true, pubkey: key };
  }
  // Signed-out: local-only device list. Nothing is sent anywhere.
  const cfg = getHubConfigStore(store);
  if (cfg.follows.includes(key)) return { follows: cfg.follows, server: false };
  if (cfg.follows.length >= FOLLOW_CAP) throw refuse(`You can follow at most ${FOLLOW_CAP} creators on this device. Sign in to follow more from your account.`, 'follow_cap');
  const next = applyHubConfig(store, { follows: [...cfg.follows, key] });
  push('hub:changes', { follows: next.follows });
  return { follows: next.follows, server: false };
});
handle('hub:unfollow', async (pubkey) => {
  const key = validateFollowKey(pubkey);
  if (hubSessionPresent()) {
    const client = await accountClient('unfollow');
    // Server DELETE is idempotent — a missing follow is success.
    await client.unfollow(key).catch(hubErr);
    hubFeedCache.delete('following');
    return { follows: null, server: true, pubkey: key };
  }
  const cfg = getHubConfigStore(store);
  const next = applyHubConfig(store, { follows: cfg.follows.filter(v => v !== key) });
  push('hub:changes', { follows: next.follows });
  return { follows: next.follows, server: false };
});
handle('hub:follows-migrate', async () => {
  // Explicit opt-in ONLY (P3 decision 5): the pre-existing device list is
  // never auto-uploaded. The user presses the button after signing in.
  if (!hubSessionPresent()) throw refuse('Sign in first, then add your device follows to your account.', 'hub_unauthorized');
  const cfg = getHubConfigStore(store);
  if (!cfg.follows.length) return { migrated: 0, failed: 0, remaining: [] };
  const client = await accountClient('follows-migrate');
  let migrated = 0;
  const failed = [];
  for (const key of cfg.follows) {
    try {
      await client.follow(key);
      migrated += 1;
    } catch (err) {
      failed.push({ pubkey: key, code: err?.code || 'hub_error' });
    }
  }
  // Only remove locally-migrated entries on full success of each; failures
  // stay on the device list so the user can retry.
  const failedKeys = new Set(failed.map(f => f.pubkey));
  const remaining = cfg.follows.filter(k => failedKeys.has(k));
  applyHubConfig(store, { follows: remaining });
  hubFeedCache.delete('following');
  return { migrated, failed: failed.length, remaining };
});
handle('hub:updates', async (since, cursor) => {
  const ent = getHubEntitlementStore(store);
  if (!['plus', 'pro'].includes(ent.tier)) throw refuse('Plus or Pro is needed for live updates.', 'hub_forbidden');
  // Same stale-tenant eviction as every authenticated surface (review R2).
  evictStaleTenantHubSession();
  const client = await hubClient({ authenticated: true }) || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!await reviewHub(client, 'updates', { authenticated: true })) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  // Send only the last sync time; what is installed stays on this device.
  const res = await client.updates({ since: Number.isFinite(since) ? since : undefined, cursor }).catch(hubErr);
  if (!res) return { items: [], nextCursor: '' };
  // Verify the signed envelope before exposing any feed content to the renderer.
  const feed = verifiedUpdateFeed(res.data);
  return { ...feed, nextCursor: typeof res.data?.nextCursor === 'string' ? res.data.nextCursor : '' };
});
handle('hub:bundle-latest', async (etag) => {
  const client = await hubClient() || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!await reviewHub(client, 'bundle-latest')) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  const res = await client.bundleLatest({ etag }).catch(hubErr);
  if (!res) throw refuse('No bundle is published.', 'hub_not_found');
  if (res.status === 304) return { notModified: true, etag: res.etag };
  return { ...res.data, etag: res.etag };
});
handle('hub:bundle-segment', async (digest, etag) => {
  const client = await hubClient() || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!await reviewHub(client, 'bundle-segment')) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  const res = await client.bundleSegment(String(digest || ''), { etag }).catch(hubErr);
  if (!res) throw refuse('Bundle segment is not available.', 'hub_not_found');
  if (res.status === 304) return { notModified: true, etag: res.etag };
  return { ...res.data, etag: res.etag };
});
handle('hub:changes', async (cursor, limit, etag) => {
  const client = await hubClient() || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!await reviewHub(client, 'changes')) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  const res = await client.changes({ cursor, limit, etag }).catch(hubErr);
  if (!res) return { items: [], nextCursor: '' };
  if (res.status === 304) return { notModified: true, etag: res.etag };
  return { ...res.data, etag: res.etag };
});
handle('hub:bundle-import', (payload) => {
  // Offline bundle import is local-only: it records which signed bundle this
  // device mirrors. The bundle's own signature is verified by the caller.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw refuse('Bundle is invalid.', 'hub_bad_request');
  const digest = typeof payload.bundleDigest === 'string' ? payload.bundleDigest : '';
  if (digest && !/^[a-f0-9]{64}$/.test(digest)) throw refuse('Bundle digest is invalid.', 'hub_bad_request');
  if (digest) applyHubConfig(store, { bundleDigest: digest });
  const cfg = getHubConfigStore(store);
  push('hub:changes', { bundleDigest: cfg.bundleDigest });
  return { bundleDigest: cfg.bundleDigest };
});
handle('hub:check-update', async ({ installed } = {}) => {
  const ent = getHubEntitlementStore(store);
  if (!['plus', 'pro'].includes(ent.tier)) throw refuse('Plus or Pro is needed for update checks.', 'hub_forbidden');
  // Same stale-tenant eviction as every authenticated surface (review R2).
  evictStaleTenantHubSession();
  // The feed is fetched and validated here, never supplied by the renderer.
  // Only the local inventory of installed engines/recipes/configs crosses IPC.
  const client = await hubClient({ authenticated: true }) || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!await reviewHub(client, 'updates', { authenticated: true })) throw new HubRefusal('Hub request cancelled.', 'hub_cancelled');
  const res = await client.updates({ limit: 1 }).catch(hubErr);
  const feed = verifiedUpdateFeed(res?.data);
  const result = compareAgainstFeed({ installed: installed || {}, feed });
  const fetchedAt = Date.now();
  store.setHubUpdates({ fetchedAt, nudges: result.nudges });
  push('hub:updates', { nudges: result.nudges, fetchedAt });
  // appVersion lets the home page state honestly what this check covered:
  // the signed feed nudges installed engines/recipes/configs — it is NOT an
  // app-binary update channel (that is the packaged UpdateChecker).
  return { ...result, fetchedAt, appVersion: app.getVersion() };
});
handle('hub:config', () => getHubConfigStore(store));
// The production Hub API is pinned in main. Renderer-supplied Hub URLs are no
// longer accepted; this IPC only permits non-network display preferences.
handle('hub:set-config', (patch) => {
  if (patch && typeof patch === 'object' && Object.hasOwn(patch, 'hubUrl')) {
    throw refuse('The FrostByte Hub URL is managed by the application.', 'hub_bad_request');
  }
  const before = getHubConfigStore(store);
  applyHubConfig(store, patch || {});
  const after = getHubConfigStore(store);
  const cleared = before.hasToken && !after.hasToken;
  const account = getHubAccountStore(store);
  const entitlement = getHubEntitlementStore(store);
  if (cleared) {
    hubEntitlements.set({ tier: entitlement.tier, status: entitlement.status, fetchedAt: entitlement.fetchedAt, currentPeriodEnd: entitlement.currentPeriodEnd, entitlements: entitlement.entitlements, source: entitlement.source });
    push('hub:updates', { tier: entitlement.tier });
  }
  push('hub:changes', { follows: after.follows, hubUrl: after.hubUrl, bundleDigest: after.bundleDigest, hasToken: after.hasToken, account, entitlement });
  return after;
});
handle('hub:entitlement', () => getHubEntitlementStore(store));
handle('hub:set-entitlement', (value) => {
  // The renderer may only select local tiers. Plus/Pro come from the Hub server
  // with a verified subscription, never from a renderer claim.
  const requested = rendererEntitlementRequest(value);
  const ent = applyHubEntitlement(store, requested);
  hubEntitlements.set({ tier: ent.tier, status: ent.status, fetchedAt: ent.fetchedAt, currentPeriodEnd: ent.currentPeriodEnd, entitlements: ent.entitlements, source: ent.source });
  push('hub:updates', { tier: ent.tier });
  return ent;
});
handle('hub:set-token', async (token) => {
  const cfg = getHubConfigStore(store);
  if (typeof token !== 'string' || !token) {
    const { account, entitlement } = clearHubAccount(store);
    hubEntitlements.set({ tier: entitlement.tier, status: entitlement.status, fetchedAt: entitlement.fetchedAt, currentPeriodEnd: entitlement.currentPeriodEnd, entitlements: entitlement.entitlements, source: entitlement.source });
    push('hub:changes', { hasToken: false, account, entitlement });
    push('hub:updates', { tier: entitlement.tier });
    return { hasToken: false };
  }
  if (cfg.hubUrl !== HUB_API_BASE) throw refuse('FrostByte Hub is not configured correctly.', 'hub_not_configured');
  const trimmed = token.trim();
  if (!bearerAllowed(HUB_API_BASE)) throw refuse('Refusing to save a token for an unapproved Hub.', 'hub_insecure_origin');
  const described = describeHubToken(trimmed);
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
    throw refuse(`Secure token storage is unavailable. ${credentialRecovery} and try again.`, 'hub_no_secure_storage');
  }
  const approval = await showReview(hubTokenSaveReview({ origin: HUB_API_BASE, ...described }));
  if (approval.response !== 1) throw new HubRefusal('Saving the Hub token was cancelled.', 'hub_cancelled');
  if (store.state.hubConfig?.hubUrl !== HUB_API_BASE) applyHubConfig(store, { hubUrl: HUB_API_BASE });
  const resetEntitlement = applyHubEntitlement(store, { tier: 'free', status: 'inactive', source: 'local', fetchedAt: Date.now() });
  store.setHubCredential({
    hubTokenEnc: safeStorage.encryptString(trimmed).toString('base64'),
    hubTokenOrigin: HUB_API_BASE,
    hubTokenFingerprint: described.fingerprint,
  });
  store._commitStateFields({
    hubAccount: { ...EMPTY_HUB_ACCOUNT },
  });
  // A manually pasted token replaces any Firebase session for this origin. Drop
  // the old refresh token + expiry so ensureHubIdToken can never resurrect the
  // previous account's credential over the manually saved one.
  store.setHubRefreshCredential({ hubRefreshEnc: '', hubRefreshOrigin: '' });
  store.setHubTokenExpiry({ hubTokenExpiresAt: 0, hubTokenExpiryOrigin: '' });
  hubEntitlements.set({
    tier: resetEntitlement.tier,
    status: resetEntitlement.status,
    fetchedAt: resetEntitlement.fetchedAt,
    currentPeriodEnd: resetEntitlement.currentPeriodEnd,
    entitlements: resetEntitlement.entitlements,
    source: resetEntitlement.source,
  });
  const account = getHubAccountStore(store);
  push('hub:changes', { hasToken: true, account, entitlement: resetEntitlement });
  push('hub:updates', { tier: resetEntitlement.tier });
  return { hasToken: true, origin: HUB_API_BASE, fingerprint: described.fingerprint };
});

function syncVerifiedHubEntitlement(rawEntitlement) {
  if (!rawEntitlement || typeof rawEntitlement !== 'object' || Array.isArray(rawEntitlement)) {
    return getHubEntitlementStore(store);
  }
  // Comped/operator entitlements with no fixed Stripe period end receive a
  // bounded 7-day rolling lease so offline desktop startups keep Pro/Plus
  // without granting an infinite unrevokable token.
  const fallbackLease = (rawEntitlement.source === 'admin' || rawEntitlement.source === 'admin_override')
    ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    : null;
  const ent = applyHubEntitlement(store, {
    tier: rawEntitlement.tier,
    status: rawEntitlement.status || 'active',
    source: 'server',
    fetchedAt: Date.now(),
    currentPeriodEnd: rawEntitlement.currentPeriodEnd ?? fallbackLease,
    entitlements: rawEntitlement.entitlements || {},
  });
  hubEntitlements.set({
    tier: ent.tier,
    status: ent.status,
    fetchedAt: ent.fetchedAt,
    currentPeriodEnd: ent.currentPeriodEnd,
    entitlements: ent.entitlements,
    source: ent.source,
  });
  push('hub:updates', { tier: ent.tier });
  return ent;
}

handle('hub:account', () => {
  if (evictStaleTenantHubSession()) {
    push('hub:changes', { hasToken: false, account: getHubAccountStore(store), entitlement: getHubEntitlementStore(store) });
  }
  return {
    account: getHubAccountStore(store),
    entitlement: getHubEntitlementStore(store),
    config: getHubConfigStore(store),
  };
});

/** Remove stale pending browser sign-in requests; the verifier is memory-only. */
function pruneDesktopAuthRequests() {
  const now = Date.now();
  for (const [state, entry] of pendingDesktopAuth) {
    if (!entry || entry.expiresAt <= now) pendingDesktopAuth.delete(state);
  }
}

/** Open the production website in the system browser for all login options. */
handle('hub:sign-in-with-browser', async () => {
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
    throw refuse(`Secure token storage is unavailable. ${credentialRecovery} and try again.`, 'hub_no_secure_storage');
  }
  pruneDesktopAuthRequests();
  if (pendingDesktopAuth.size >= 3) throw refuse('A sign-in is already in progress.', 'hub_signin_pending');
  const request = createDesktopAuthRequest();
  const signInUrl = validateDesktopSignInUrl(request.url).toString();
  const approval = await showReview(desktopAuthBrowserReview());
  if (approval.response !== 1) throw new HubRefusal('FrostByte sign-in was cancelled.', 'hub_cancelled');
  pendingDesktopAuth.set(request.state, request);
  push('hub:auth-status', { status: 'browser-open', message: 'Complete sign-in in your browser…' });
  try {
    await shell.openExternal(signInUrl);
  } catch (err) {
    pendingDesktopAuth.delete(request.state);
    throw refuse(`Could not open the browser: ${err.message}`, 'hub_browser_open_failed');
  }
  return { status: 'browser-open', state: request.state, expiresAt: request.expiresAt };
});

const inFlightDesktopAuth = new Set();

/** Complete a one-time code received through frostbyte://auth. */
async function completeDesktopAuthUrl(rawUrl) {
  const { code, state } = parseDesktopAuthUrl(rawUrl);
  const inFlightKey = `${state}:${code}`;
  if (inFlightDesktopAuth.has(inFlightKey)) return null;
  pruneDesktopAuthRequests();
  const request = pendingDesktopAuth.get(state);
  if (!request) throw refuse('That sign-in link is no longer active. Start sign-in again.', 'hub_signin_state');
  pendingDesktopAuth.delete(state);
  inFlightDesktopAuth.add(inFlightKey);
  try {
    const approval = await showReview(desktopAuthExchangeReview({ state }));
    if (approval.response !== 1) throw new HubRefusal('FrostByte sign-in was cancelled.', 'hub_cancelled');
    push('hub:auth-status', { status: 'exchanging', message: 'Completing browser sign-in…' });
    const exchangeClient = createHubClient({ hubUrl: HUB_API_BASE });
    const exchange = await exchangeClient.desktopExchange({
      code,
      state,
      codeVerifier: request.codeVerifier,
    }).catch(() => null);
    const payload = exchange?.data || null;
    if (!payload?.customToken || payload?.tenantId !== FIREBASE_CONFIG.tenantId) {
      throw refuse('Browser sign-in could not be completed. Start sign-in again.', 'hub_auth_error');
    }
    const session = await firebaseAuth.exchangeCustomToken({ customToken: payload.customToken }).catch(firebaseErr);
    if (session.tenantId !== FIREBASE_CONFIG.tenantId) {
      throw refuse('That account does not belong to this FrostByte tenant.', 'hub_auth_error');
    }
    const result = await completeHubSignIn(session, HUB_API_BASE, payload.sessionId);
    push('hub:auth-status', { status: 'complete', message: 'Signed in through FrostByte.', data: result });
    return result;
  } finally {
    inFlightDesktopAuth.delete(inFlightKey);
  }
}

/**
 * Finish a browser sign-in: bind the pinned Hub API, verify the account
 * against the Hub, persist the encrypted session, and publish the verified
 * account + entitlement. The custom-token exchange, not a password, is what
 * the desktop sees; the website saw the user's chosen login method.
 */
async function completeHubSignIn(session, origin, desktopSessionId = '') {
  if (store.state.hubConfig?.hubUrl !== origin) applyHubConfig(store, { hubUrl: origin });
  // Verify the Firebase ID token against the Hub before persisting anything, so
  // a rejected credential never lands on disk. me() also provisions the profile.
  const client = createHubClient({ hubUrl: origin, token: session.token });
  const res = await client.me().catch(hubErr);
  if (!res?.data) throw refuse('Hub account endpoint was not found.', 'hub_not_found');
  const described = persistFirebaseSession(session, origin);
  const account = applyHubAccount(store, {
    ...res.data,
    // Real tenant only (review F1) — no configured-tenant fallback labeling.
    tenantId: session.tenantId || '',
    isAdmin: Boolean(res.data.isAdmin),
    ...(desktopSessionId ? { desktopSessionId } : {}),
    verifiedAt: Date.now(),
  }, origin);
  const entitlement = syncVerifiedHubEntitlement(res.data.entitlement);
  const nextCfg = getHubConfigStore(store);
  push('hub:changes', {
    hubUrl: nextCfg.hubUrl,
    follows: nextCfg.follows,
    bundleDigest: nextCfg.bundleDigest,
    hasToken: true,
    account,
    entitlement,
  });
  note(`Signed in to Hub as ${account.displayName || account.email}.`, 'ok');
  return { account, entitlement, config: nextCfg, fingerprint: described.fingerprint };
}

handle('hub:refresh-account', async () => {
  // Evict a stale-tenant session before minting a token (review F2) — same
  // hook as hub:account / restoreHubSession, so a cached root-pool refresh
  // token can never be sent to a tenant-gated Hub.
  evictStaleTenantHubSession();
  const client = await hubClient({ authenticated: true }) || refuse(HUB_NOT_CONFIGURED_MESSAGE, 'hub_not_configured');
  if (!client.getToken()) throw refuse('Sign in or save a Hub token before verifying your account.', 'hub_unauthorized');
  if (!await reviewHub(client, 'account', { authenticated: true })) {
    throw new HubRefusal('Hub account check was cancelled.', 'hub_cancelled');
  }
  const res = await client.me().catch(hubErr);
  if (!res?.data) throw refuse('Hub account endpoint was not found.', 'hub_not_found');
  const existingAccount = getHubAccountStore(store);
  const account = applyHubAccount(store, {
    ...res.data,
    // Server-confirmed tenant, else the cached label — never the configured
    // tenant as a fallback (review F1).
    tenantId: res.data.tenantId || existingAccount.tenantId || '',
    desktopSessionId: existingAccount.desktopSessionId || '',
    isAdmin: Boolean(res.data.isAdmin),
    verifiedAt: Date.now(),
  }, client.origin);
  const entitlement = syncVerifiedHubEntitlement(res.data.entitlement);
  const nextCfg = getHubConfigStore(store);
  push('hub:changes', { hasToken: nextCfg.hasToken, account, entitlement });
  return { account, entitlement, config: nextCfg };
});

handle('hub:logout', async () => {
  // Logout revokes only this desktop session at the Hub when reachable, then
  // always clears local credentials. Never refresh or require a network round trip:
  // local sign-out must succeed even when the session is expired or offline.
  const cfg = getHubConfigStore(store);
  const hadToken = Boolean(cfg.hasToken);
  const accountBeforeLogout = getHubAccountStore(store);
  const sessionId = accountBeforeLogout.desktopSessionId || '';
  if (sessionId) {
    try {
      const liveToken = hubToken(HUB_API_BASE).token
        || (await ensureHubIdToken().then((s) => s.token).catch(() => ''));
      if (liveToken) {
        const revokeClient = createHubClient({ hubUrl: HUB_API_BASE, token: liveToken });
        await revokeClient.desktopRevoke({ sessionId, bearer: liveToken }).catch(() => null);
      }
    } catch { /* Local logout still succeeds offline. */ }
  }
  const { account, entitlement } = clearHubAccount(store);
  hubEntitlements.set({
    tier: entitlement.tier,
    status: entitlement.status,
    fetchedAt: entitlement.fetchedAt,
    currentPeriodEnd: entitlement.currentPeriodEnd,
    entitlements: entitlement.entitlements,
    source: entitlement.source,
  });
  const nextCfg = getHubConfigStore(store);
  push('hub:changes', { hasToken: false, account, entitlement });
  push('hub:updates', { tier: entitlement.tier });
  note('Signed out of FrostByte Hub on this device.', 'ok');
  return { signedOut: true, hadToken, account, entitlement, config: nextCfg };
});

/* ------------------------------------------------------------------- menus */

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Add Magnet or .torrent…', accelerator: 'CmdOrCtrl+O', click: () => push('menu:action', 'add-source') },
        { label: 'Share a Model Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => push('menu:action', 'seed-folder') },
        { type: 'separator' },
        { label: 'Toggle Alternative Limits', accelerator: 'CmdOrCtrl+D', click: () => push('menu:action', 'turtle') },
        { type: 'separator' },
        { label: 'Open Downloads Folder', click: () => shell.openPath(store.getSettings().downloadDir) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Find downloads', accelerator: 'CmdOrCtrl+F', click: () => push('menu:action', 'focus-search') },
        { label: 'Transfers', accelerator: 'CmdOrCtrl+1', click: () => push('menu:action', 'tab-transfers') },
        { label: 'My Models', accelerator: 'CmdOrCtrl+2', click: () => push('menu:action', 'tab-library') },
        { label: 'Torrents', accelerator: 'CmdOrCtrl+3', click: () => push('menu:action', 'tab-catalog') },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }, { role: 'reload' }] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Feedback on GitHub…', click: () => push('menu:action', 'feedback') },
        { label: 'Privacy and terms', click: () => push('menu:action', 'privacy') },
        { label: 'About FrostByte', click: () => push('menu:action', 'about') },
        { type: 'separator' },
        ...[
          ['FrostByte on GitHub', COMMUNITY_LINKS.app],
          ['Follow Blackfrost_AI on GitHub', COMMUNITY_LINKS.github],
          ['Follow @blackfrost_ai on X', COMMUNITY_LINKS.x],
          ['Email support@blackfrostai.com', COMMUNITY_LINKS.support],
        ].map(([label, url]) => ({ label, click: async () => {
          try { await openExternal(url); } catch (err) { note(err.message, 'warn'); }
        } })),
        { type: 'separator' },
        { label: 'Licenses and Third-Party Notices', click: () => shell.openPath(app.isPackaged ? path.join(process.resourcesPath, 'Legal') : path.resolve(here, '../../licenses')) },
        { label: 'Storage location', click: () => shell.openPath(store.appDir) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* --------------------------------------------------------------- lifecycle */

async function registerAppProtocol() {
  await protocol.handle('frostbyte', request => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const target = resolveAppAsset(request.url, appRoot);
      if (!target) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(target).href, { method: request.method });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

app.whenReady().then(() => {
  powerMonitor.on('lock-screen', () => publisher.lock());
  powerMonitor.on('suspend', () => publisher.lock());
});

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  await registerAppProtocol();
  migrateLegacyHfToken();
  if (app.isPackaged) {
    try { app.setAsDefaultProtocolClient('frostbyte'); } catch { /* OS registration handled by installer */ }
  }
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(here, '../../assets/brand/app-icon.png'));
  startRuntime();
  buildMenu();
  startupReady = true;
  focusWindow();
  for (const arg of process.argv || []) {
    if (isDesktopAuthCandidate(arg)) receiveDesktopAuthUrl(arg);
  }
  for (const source of downloadSourcesFromArguments(process.argv, { isPackaged: app.isPackaged })) receiveSource(source);

  // Register the login item only when enabled — writing "off" on an
  // unsigned dev build trips a macOS permission error that pollutes the log.
  try {
    if (store.getSettings().openAtLogin) setOpenAtLogin({ ...loginItemOptions, openAtLogin: true });
  } catch { note('Start at login could not be registered with this desktop session. Review it in Settings.', 'error'); }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) focusWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let gracefulShutdownPromise = null;
let shutdownExitCode = 0;
function gracefulShutdown({ exitCode = 0 } = {}) {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode ? 1 : 0);
  if (gracefulShutdownPromise) return gracefulShutdownPromise;
  gracefulShutdownPromise = (async () => {
    const cleanup = new ShutdownCleanup();
    publishing.stop();
    for (const controller of shareLinks.running.values()) controller.abort();
    // Stop launch events from creating or reviving a window while teardown is
    // draining accepted work. New source requests remain bounded in memory
    // until the process exits.
    startupReady = false;
    shuttingDown = true;
    modelLibrary.cancel();
    const disarmFailsafe = armShutdownFailsafe(() => {
      console.error('Graceful shutdown exceeded 60 seconds; recovery records were retained and FrostByte will exit with an error.');
      app.exit(1);
    });
    try {
      clearHfPersistRetry();
      if (transferPersistRetryTimer) clearTimeout(transferPersistRetryTimer);
      transferPersistRetryTimer = null;
      clearInterval(updateTimer);
      clearInterval(ipfsTimer);
      await cleanup.attempt('Assistant shutdown', async () => {
        await assistant?.cancelAll();
        await assistant?.stopManagedRuntime?.();
      });
      await cleanup.attempt('Model scan shutdown', () => modelLibrary.pending);
      await cleanup.attempt('Network discovery shutdown', () => networkDevices.close());
      await cleanup.attempt('IPFS shutdown', () => ipfs.close());
      await cleanup.attempt('Privacy state cleanup', () => privacy.clear());
      await cleanup.attempt('Settings transaction drain', () => settingsMutations.close());
      await cleanup.attempt('Device setup shutdown', () => sparkSetup.shutdown());
      await cleanup.attempt('Torrent preview cancellation', () => {
        for (const controller of previews.values()) controller.abort();
      });
      if (tickTimer) clearInterval(tickTimer);
      // Drain item operations FIRST: they are the producers of transfer mutations
      // (removeLocalItem / setItemSharing call withTransferMutation). Closing the
      // coordinator before they finish would reject their authorized mutations and
      // leave sticky pending entryOperations records for work that never started.
      await cleanup.attempt('Item operation drain', () => Promise.allSettled([...itemJobs.values()]));
      // Then stop accepting transfer work and let every already-authorized mutation
      // finish or roll back before the final restart checkpoint is written.
      await cleanup.attempt('Transfer transaction drain', () => transferMutations.close());
      await cleanup.attempt('Final transfer checkpoint', () => {
        commitTransferIntent(store, transferSessionRecords(), completionMoveRecords());
      });
      await cleanup.attempt('Pre-cancellation Hugging Face checkpoint', () => persistHf());
      await cleanup.attempt('Hugging Face download cancellation', () => {
        for (const rec of hfDownloads.values()) if (rec.status === 'active') rec.controller.abort();
      });
      await cleanup.attempt('Hugging Face download drain', () => Promise.allSettled([...hfJobs]));
      // Aborting an active worker changes its durable restart intent. Record the
      // settled queued/paused/error state after every worker has observed the
      // abort; failures inside a worker are otherwise intentionally all-settled.
      await cleanup.attempt('Final Hugging Face checkpoint', () => persistHf());
      await cleanup.retry('Router mapping removal', () => upnp?.disable(), 2);
      await cleanup.attempt('Torrent engine shutdown', () => engine?.destroy());
      cleanup.throwIfFailed();
      // The initial native quit was cancelled while we drained resources.
      // Re-entering app.quit() here can leave macOS with no windows but a live
      // main process. All checkpoints and cleanup have completed at this point.
      app.exit(shutdownExitCode);
    } finally {
      disarmFailsafe();
    }
  })();
  return gracefulShutdownPromise;
}

function finishGracefulShutdown(options) {
  gracefulShutdown(options).catch(error => {
    console.error('Graceful shutdown failed:', error);
    app.exit(1);
  });
}

app.on('before-quit', (e) => {
  publisher.lock();
  if (forceQuit || !engine || engine._destroyed) return;
  e.preventDefault();

  const sharing = engine.list().filter((t) => t.seeding).length;
  if (sharing > 0 && store.getSettings().confirmExitSeeding) {
    dialog.showMessageBox({
      type: 'warning',
      buttons: ['Quit anyway', 'Keep sharing'],
      defaultId: 1,
      cancelId: 1,
      message: `Still sharing ${sharing} item${sharing === 1 ? '' : 's'}`,
      detail: 'Peers pulling from this box right now would lose it as a source.',
      checkboxLabel: 'Never show again when quitting while sharing',
      checkboxChecked: false,
      noLink: true,
    }).then(async (r) => {
      if (r.response === 0) {
        if (r.checkboxChecked) await settingsMutations.run(() => store.setSettings({ confirmExitSeeding: false }));
        forceQuit = true; finishGracefulShutdown();
      }
    }).catch(() => { forceQuit = true; finishGracefulShutdown(); });
    return;
  }
  forceQuit = true;
  finishGracefulShutdown();
});

let fatalShutdownStarted = false;
function fatalShutdown(reason) {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error(error);
  if (fatalShutdownStarted) return;
  fatalShutdownStarted = true;
  forceQuit = true;
  try { privacy.record('unexpected_error'); } catch { /* crash path must stay minimal */ }
  try { note('Frost/Byte encountered an unexpected error and is closing safely.', 'error'); } catch { /* renderer may be gone */ }
  const failsafe = setTimeout(() => app.exit(1), 10_000);
  failsafe.unref?.();
  gracefulShutdown({ exitCode: 1 }).catch(shutdownError => {
    console.error('Graceful crash shutdown failed:', shutdownError);
    app.exit(1);
  }).finally(() => clearTimeout(failsafe));
}

process.on('uncaughtException', fatalShutdown);
process.on('unhandledRejection', fatalShutdown);

export { currentState, privacy, engine };
