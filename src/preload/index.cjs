/**
 * The renderer's entire view of the outside world.
 *
 * Deliberately a short, explicit list. The UI cannot touch the filesystem or
 * the network except through these calls, and everything it receives is plain
 * serialisable data — no Torrent objects, no Node handles, no paths it can
 * wander off with.
 *
 * CommonJS preload so the renderer can use Electron's process sandbox.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const onRuntimeEvent = listener => {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on('runtime:event', wrapped);
  return () => ipcRenderer.removeListener('runtime:event', wrapped);
};

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const invokeData = async (channel, ...args) => {
  const result = await invoke(channel, ...args);
  if (!result || result.ok !== true) throw new Error(result?.error || 'The FrostByte request failed.');
  return result.data;
};
const listen = (channel, callback) => {
  if (typeof callback !== 'function') throw new Error('A FrostByte event listener must be a function.');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
const pathGrants = new Map();
const launchGrants = new Map();
const rememberSelection = selected => {
  if (!selected || typeof selected !== 'object') return selected;
  if (typeof selected.path !== 'string' || typeof selected.capability !== 'string' || typeof selected.purpose !== 'string') throw new Error('The file picker returned an invalid selection.');
  pathGrants.set(`${selected.purpose}\0${selected.path}`, selected.capability);
  while (pathGrants.size > 64) pathGrants.delete(pathGrants.keys().next().value);
  return selected.path;
};
const pathGrant = (value, purpose) => {
  const key = `${purpose}\0${value}`;
  const capability = pathGrants.get(key);
  pathGrants.delete(key);
  return capability;
};
const peekPathGrant = (value, purpose) => pathGrants.get(`${purpose}\0${value}`);
const isTorrentPath = value => typeof value === 'string' && /\.torrent$/i.test(value.trim());
const rememberLaunchDelivery = delivery => {
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)
    || typeof delivery.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(delivery.id)
    || !Object.hasOwn(delivery, 'source')) throw new Error('The application returned an invalid launch request.');
  const selected = delivery.source;
  if (selected && typeof selected === 'object' && !Array.isArray(selected)
    && typeof selected.path === 'string' && typeof selected.capability === 'string'
    && typeof selected.purpose === 'string') {
    launchGrants.set(delivery.id, {
      key: `${selected.purpose}\0${selected.path}`,
      capability: selected.capability,
    });
  }
  return { id: delivery.id, source: rememberSelection(selected) };
};
const pick = async channel => {
  const result = await invoke(channel);
  if (!result.ok) throw new Error(result.error);
  return rememberSelection(result.data);
};

contextBridge.exposeInMainWorld('frostbyte', {
  getPrivacy: () => invoke('privacy:status'),
  legalDocuments: () => invoke('privacy:documents'),
  acceptTerms: value => invoke('privacy:accept', value),
  quit: () => invoke('privacy:quit'),
  // Compatibility only: v1.0 rejects diagnostics opt-ins and report submission.
  // Feedback now opens the exact official GitHub URL through openExternal.
  setDiagnostics: value => invoke('privacy:diagnostics', value),
  previewDiagnostics: () => invoke('privacy:preview'),
  prepareFeedback: value => invoke('feedback:prepare', value),
  sendFeedback: id => invoke('feedback:send', id),
  discardFeedback: () => invoke('feedback:discard'),
  copyText: async value => {
    const result = await invoke('clipboard:write', value);
    if (!result.ok) throw new Error(result.error);
    return result.data?.cancelled !== true;
  },
  /* read state */
  getState: () => invoke('app:state'),
  localDeviceTelemetry: () => invokeData('devices:local-telemetry'),
  networkDevices: {
    inventory: () => invokeData('network-devices:inventory'),
    snapshot: () => invokeData('network-devices:snapshot'),
    scan: request => invokeData('network-devices:scan', request),
    cancel: () => invokeData('network-devices:cancel'),
    setOverlay: (id, enabled) => invokeData('network-devices:overlay', id, enabled),
    onChanged: callback => listen('network-devices:changed', callback),
  },
  resetConfirmations: () => invoke('confirmations:reset'),
  onConfirmations: cb => ipcRenderer.on('confirmations:changed', (_e, value) => cb(value)),
  checkUpdates: () => invoke('updates:check'),
  downloadUpdate: () => invoke('updates:download'),
  onUpdates: cb => ipcRenderer.on('updates:status', (_e, value) => cb(value)),
  pendingSources: async () => {
    const result = await invoke('app:sources');
    if (result.ok && Array.isArray(result.data)) result.data = result.data.map(rememberLaunchDelivery);
    return result;
  },
  acknowledgeSource: async id => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('The launch request identifier is invalid.');
    try {
      const result = await invoke('app:source-ack', id);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    } finally {
      const grant = launchGrants.get(id);
      launchGrants.delete(id);
      if (grant && pathGrants.get(grant.key) === grant.capability) pathGrants.delete(grant.key);
    }
  },
  onSource: (cb) => ipcRenderer.on('app:source', () => cb()),
  sparkConnect: (host) => invoke('spark:connect', host),
  deviceStatus: (force = false) => invoke('devices:status', force === true),
  selectDevice: id => invoke('devices:select', id),
  configureDevice: (id, options) => invoke('devices:configure', id, options),
  forgetDevice: id => invoke('devices:forget', id),
  forgetDeviceLocal: id => invoke('devices:forget-local', id),
  updateDevice: id => invoke('devices:update', id),
  onDevices: cb => ipcRenderer.on('devices:changed', (_e, value) => cb(value)),
  sparkStatus: (force = false, deviceId) => invoke('spark:status', force === true, deviceId),
  sparkDeviceTelemetry: (deviceId, force = false) => invokeData('spark:device-telemetry', deviceId, force === true),
  sparkDeviceRecipes: (deviceId) => invokeData('spark:device-recipes', deviceId),
  sparkModelCheck: (deviceId, recipeId) => invokeData('spark:model-check', deviceId, recipeId),
  sparkModelStart: (deviceId, recipeId) => invokeData('spark:model-start', deviceId, recipeId),
  sparkModelStop: (deviceId, recipeId) => invokeData('spark:model-stop', deviceId, recipeId),
  sparkFiles: (relative, root, deviceId) => invoke('spark:files', relative, root, deviceId),
  sparkControl: (action, id, root, deviceId, options) => invoke('spark:control', action, id, root, deviceId, options),
  sparkHfDownload: (request) => invoke('spark:hf-download', request),
  sparkFolders: (request) => invoke('spark:folders', request),
  sparkStorageAdd: (request) => invoke('spark:storage-add', request),
  sparkSetupProbe: (request) => invoke('spark:setup-probe', request),
  sparkSetupInstall: (request) => invoke('spark:setup-install', request),
  sparkSetupConnect: (request) => invoke('spark:setup-connect', request),
  sparkSetupCancel: (sessionId) => invoke('spark:setup-cancel', sessionId),
  onSparkSetupProgress: (cb) => ipcRenderer.on('spark:setup-progress', (_e, payload) => cb(payload)),

  ipfsInspect: options => invoke('ipfs:inspect', options),
  ipfsAdd: options => invoke('ipfs:add', { ...options, ...(options.deviceId ? {} : { destinationCapability: pathGrant(options.destination, 'save') }) }),
  ipfsControl: options => invoke('ipfs:control', options),
  ipfsSharing: options => invoke('ipfs:sharing', options),
  ipfsClearCache: () => invoke('ipfs:clear-cache'),
  onIpfsProgress: cb => ipcRenderer.on('ipfs:progress', (_e, value) => cb(value)),
  aeonOpen: options => invoke('aeon:open', options),
  aeonIntegrityScan: options => invoke('aeon:integrity-scan', options),

  /* transfers */
  add: (source, options = {}) => invoke('torrent:add', source, {
    ...options,
    ...(isTorrentPath(source) ? { sourceCapability: pathGrant(source, 'torrent') } : {}),
    ...(options.target !== 'spark' && options.destination ? { destinationCapability: pathGrant(options.destination, 'save') } : {}),
  }),
  inspectTorrent: (source, id) => invoke('torrent:inspect', { source, sourceCapability: isTorrentPath(source) ? peekPathGrant(source, 'torrent') : undefined }, id),
  cancelInspect: (id) => invoke('torrent:cancel-inspect', id),
  droppedFilePath: async (file) => {
    const selected = await invoke('dialog:registerDroppedTorrent', webUtils.getPathForFile(file));
    if (!selected.ok) throw new Error(selected.error);
    return rememberSelection(selected.data);
  },
  pause: (infoHash) => invoke('torrent:pause', infoHash),
  resume: (infoHash) => invoke('torrent:resume', infoHash),
  remove: (infoHash, deleteData = false) => invoke('torrent:remove', { infoHash, deleteData }),

  /* sharing what this box already holds */
  shareFolder: (targetPath, name) => invoke('library:seed', { targetPath, name, pathCapability: pathGrant(targetPath, 'seed') }),
  scanModels: () => invoke('library:scan'),
  cancelModelScan: () => invoke('library:scan-cancel'),
  importModelFolder: () => invoke('library:import-folder'),
  shareDiscoveredModel: request => invoke('library:scan-sharing', request),
  onModelScan: callback => listen('library:scan-progress', callback),
  unseed: (infoHash) => invoke('library:unseed', { infoHash }),
  reveal: (targetPath) => invoke('library:reveal', targetPath),
  setItemSharing: (request) => invoke('item:sharing', request),
  setItemKind: (request) => invoke('item:kind', request),
  removeItem: (request) => invoke('item:remove', request),
  hideItem: request => invoke('item:hide', request),
  batchItems: (action, items) => invoke('items:batch', { action, items }),
  restoreItem: id => invoke('item:restore', { id }),
  previewLinks: keys => invoke('links:preview', { keys }),
  exportLinks: (keys, format) => invoke('links:export', { keys, format }),
  importLinks: () => invoke('links:import'),
  createLinks: keys => invoke('links:create', { keys }),
  controlLinks: (key, action) => invoke('links:control', { key, action }),
  connectFrostnet: request => invoke('publishing:connect', request),
  disconnectFrostnet: () => invoke('publishing:disconnect'),
  previewRelease: request => invoke('publishing:preview', request),
  cancelReleasePreview: () => invoke('publishing:cancel'),
  submitRelease: (digest, withdraw = false) => invoke('publishing:submit', { digest, withdraw }),
  retryPublication: id => invoke('publishing:retry', { id }),
  exportRelease: digest => invoke('publishing:export', { digest }),
  importRelease: () => invoke('publishing:import'),

  /* catalog */
  addCatalogEntry: (entry) => invoke('catalog:add', entry),
  removeCatalogEntry: (id) => invoke('catalog:remove', id),
  importCatalogUrl: (url) => invoke('catalog:importUrl', url),

  /* HuggingFace */
  hfSearch: (q, limit) => invoke('hf:search', q, limit),
  hfFacets: () => invoke('hf:facets'),
  hfModel: (repoId, revision) => invoke('hf:model', repoId, revision),
  hfRefs: (repoId) => invoke('hf:refs', repoId),
  hfReadme: (repoId, revision) => invoke('hf:readme', repoId, revision),
  hfCardImage: (url) => invoke('hf:card-image', url),
  hfSetToken: (token) => invoke('hf:token:set', token),
  hfDownload: ({ repoId, revision, files, source, peerDeviceId }) => invoke('hf:download', { repoId, revision, files, source, peerDeviceId }),
  hfPause: id => invoke('hf:pause', { id }),
  hfResume: id => invoke('hf:resume', { id }),
  hfResumeGroup: ({ ids, device, deviceId }) => invoke('hf:resume-group', { ids, device, deviceId }),
  hfCancel: (id) => invoke('hf:cancel', { id }),
  hfRemove: (ids) => invoke('hf:remove', { ids }),
  hfRestoreRetained: (id, deviceId) => invoke('hf:restore-retained', { id, deviceId }),
  hfClearFinished: (ids) => invoke('hf:clear', ids),
  hfReveal: (dest) => invoke('hf:reveal', { dest }),
  onHfProgress: (cb) => ipcRenderer.on('hf:progress', (_e, payload) => cb(payload)),

  /* Pirate Face (optional community torrent index) */
  pirateFaceSearch: (q, opts) => invoke('pirateface:search', q, opts),
  pirateFaceTorrents: (repoId, opts) => invoke('pirateface:torrents', repoId, opts),


  /* Publisher identity (AEON-compatible BIP39 → ed25519) */
  publisherCreate: (request) => invoke('publisher:create', request),
  publisherImport: (request) => invoke('publisher:import', request),
  publisherUnlock: (password) => invoke('publisher:unlock', password),
  publisherLock: () => invoke('publisher:lock'),
  publisherExportMnemonic: (password) => invoke('publisher:export-mnemonic', password),
  publisherClear: () => invoke('publisher:clear'),
  publisherAcknowledgeBackup: request => invoke('publisher:acknowledge-backup', request),
  /* Hub (Plus/Pro network + offline bundle) */
  hubSearch: request => invoke('hub:search', request),
  hubHealth: () => invoke('hub:health'),
  hubRecipe: request => invoke('hub:recipe', request),
  hubManifest: request => invoke('hub:manifest', request),
  hubCreator: (pubkey, etag) => invoke('hub:creator', pubkey, etag),
  hubCreatorByHandle: (handle) => invoke('hub:creator-by-handle', handle),
  /* Account management (ADR 003): profile, handle alias, publisher binding */
  hubUpdateMe: patch => invoke('hub:update-me', patch),
  hubSetHandle: handle => invoke('hub:set-handle', handle),
  hubReleaseHandle: () => invoke('hub:release-handle'),
  hubPublisherKeys: () => invoke('hub:publisher-keys'),
  hubBindPublisher: () => invoke('hub:bind-publisher'),
  hubUnbindPublisher: pubKey => invoke('hub:unbind-publisher', pubKey),
  hubPublish: manifest => invoke('hub:publish', manifest),
  hubWithdraw: id => invoke('hub:withdraw', id),
  hubFollow: pubkey => invoke('hub:follow', pubkey),
  runtimeModels: refresh => invokeData('runtime:models', refresh === true),
  runtimeConversations: () => invokeData('runtime:conversations'),
  runtimeNew: () => invokeData('runtime:new'),
  runtimeHistory: id => invokeData('runtime:history', id),
  runtimeClear: () => invokeData('runtime:clear'),
  chatStream: input => invokeData('chat:stream', input),
  chatCancel: id => invokeData('chat:cancel', id),
  onRuntimeEvent,
  hubUnfollow: pubkey => invoke('hub:unfollow', pubkey),
  /* Community home (P3): feed, announcements, server follow graph */
  hubFeed: options => invoke('hub:feed', options),
  hubAnnouncements: () => invoke('hub:announcements'),
  hubMeFollows: () => invoke('hub:me-follows'),
  hubFollowsMigrate: () => invoke('hub:follows-migrate'),
  hubUpdates: (since, cursor) => invoke('hub:updates', since, cursor),
  hubBundleLatest: (etag) => invoke('hub:bundle-latest', etag),
  hubBundleSegment: (digest, etag) => invoke('hub:bundle-segment', digest, etag),
  hubChanges: (cursor, limit, etag) => invoke('hub:changes', cursor, limit, etag),
  hubBundleImport: (payload) => invoke('hub:bundle-import', payload),
  // The update feed is fetched and validated in the main process; the renderer
  // supplies only the local inventory of what is installed on this device.
  hubCheckUpdate: (installed) => invoke('hub:check-update', { installed }),
  hubConfig: () => invoke('hub:config'),
  hubSetConfig: patch => invoke('hub:set-config', patch),
  hubEntitlement: () => invoke('hub:entitlement'),
  hubSetEntitlement: value => invoke('hub:set-entitlement', value),
  hubSetToken: token => invoke('hub:set-token', token),
  hubAccount: () => invoke('hub:account'),
  hubSignInWithBrowser: () => invoke('hub:sign-in-with-browser'),
  hubRefreshAccount: () => invoke('hub:refresh-account'),
  hubLogout: (opts) => invoke('hub:logout', opts),
  onHubUpdates: cb => listen('hub:updates', cb),
  onHubChanges: cb => listen('hub:changes', cb),
  onHubAuthStatus: cb => listen('hub:auth-status', cb),
  publisherCloseReveal: id => invoke('publisher:close-reveal', id),

  /* settings and native dialogs */
  setSettings: (patch) => invoke('settings:set', patch, {
    ...(patch?.downloadDir ? { downloadDir: pathGrant(patch.downloadDir, 'save') } : {}),
    ...(patch?.completedDir ? { completedDir: pathGrant(patch.completedDir, 'completed') } : {}),
  }),
  pickSaveDir: () => pick('dialog:pickSaveDir'),
  pickTorrentFile: () => pick('dialog:pickTorrentFile'),
  pickModelFolder: () => pick('dialog:pickModelFolder'),
  pickCompletedDir: () => pick('dialog:pickCompletedDir'),
  toggleTurtle: () => invoke('rates:turtle'),
  openExternal: (url) => invoke('shell:openExternal', url),

  /* events pushed from main */
  onTorrent: (cb) => ipcRenderer.on('engine:torrent', (_e, payload) => cb(payload)),
  onNotice: (cb) => ipcRenderer.on('engine:notice', (_e, payload) => cb(payload)),
  onMenuAction: (cb) => ipcRenderer.on('menu:action', (_e, action) => cb(action)),
});
