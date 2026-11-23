import path from 'node:path';

function exact(value, max, label) {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}.`);
  return JSON.stringify(value);
}

// Keep summaries readable. The unabridged, escaped values remain in Details.
export function reviewLabel(value, max = 160) {
  const text = JSON.stringify(String(value ?? '')).slice(1, -1)
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16)}`);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function reviewSize(bytes) {
  if (!bytes) return '0 B';
  const unit = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${Number((bytes / 1024 ** unit).toFixed(1))} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}

const remember = (kind, scope, context) => ({ kind, scope, label: `Never show again ${context}` });
function hfBrowsePermission(endpoint, generation = 'none') {
  const url = new URL(endpoint);
  if (url.origin !== 'https://huggingface.co' || url.username || url.password || !/^\/api\/models(?:\/|$)/.test(url.pathname)) return undefined;
  return generation === 'none'
    ? remember('hf-public-browse', [url.origin], 'for public Hugging Face browsing')
    : remember('hf-account-browse', [url.origin, generation], 'for browsing with this Hugging Face account');
}

/** Preserve every reviewed character while still allowing a fallback for blank labels. */
export function exactReviewText(value, fallback, max = 4096) {
  const reviewed = typeof value === 'string' && value.trim() ? value : fallback;
  if (typeof reviewed !== 'string' || !reviewed || reviewed.length > max || reviewed.includes('\0')) {
    throw new Error('The action contains an invalid review value.');
  }
  return JSON.stringify(reviewed);
}

/** Native prompt for a renderer-selected public network destination. */
export function catalogImportReview(url) {
  return {
    summary: `Import the catalog from:\n${reviewLabel(url, 220)}\n\nOnly continue if you trust this address.`,
    type: 'question',
    buttons: ['Cancel', 'Import catalog'],
    defaultId: 0,
    cancelId: 0,
    message: 'Connect to this catalog address?',
    detail: `FrostByte will request the exact public HTTPS address below:\n\n${exact(url, 4096, 'catalog URL')}\n\nRedirects are rejected. Import the final HTTPS address separately so you can review it.\n\nOnly continue if you recognize and trust it.`,
  };
}

/** Native prompt before a long-lived access token crosses to a paired device. */
export function remoteHfCredentialReview({ device, repoId, action }) {
  if (!['start', 'resume'].includes(action)) throw new Error('Invalid remote download action.');
  return {
    summary: `${reviewLabel(repoId)}\nDevice: ${reviewLabel(device)}\n\nThis device will receive your saved token, including its access to other repositories.`,
    type: 'warning',
    buttons: ['Cancel', action === 'start' ? 'Send token and download' : 'Send token and resume'],
    defaultId: 0,
    cancelId: 0,
    message: 'Send your stored Hugging Face token to this device?',
    detail: `Device: ${exact(device, 512, 'device name')}\n\nRepository: ${exact(repoId, 200, 'repository ID')}\n\nThe paired device will receive the token for this ${action === 'start' ? 'download' : 'resume attempt'}. The token may grant access to other repositories allowed by your Hugging Face account.`,
  };
}

export function sensitiveSettingsReview({ openAtLogin, upnpEnabled }) {
  const changes = [];
  if (openAtLogin) changes.push('• Start FrostByte automatically when you sign in');
  if (upnpEnabled) changes.push('• Ask the router to expose FrostByte’s peer port with UPnP/NAT-PMP');
  if (!changes.length) throw new Error('No sensitive settings change requires review.');
  return {
    type: 'warning',
    buttons: ['Cancel', 'Allow changes'],
    defaultId: 0,
    cancelId: 0,
    message: 'Allow these system and network changes?',
    detail: changes.join('\n'),
  };
}

export function clipboardWriteReview(value) {
  return {
    summary: `Copy this text to your clipboard:\n\n${reviewLabel(value, 180)}`,
    remember: remember('clipboard', [], 'when copying text'),
    type: 'question',
    buttons: ['Cancel', 'Copy'],
    defaultId: 0,
    cancelId: 0,
    message: 'Copy to clipboard?',
    detail: exact(value, 8192, 'clipboard text'),
  };
}

export function torrentDiscoveryReview({ infoHash, action, name = '' }) {
  if (!/^[a-f0-9]{40}$/.test(infoHash || '') || !['inspect', 'download', 'catalog'].includes(action)) {
    throw new Error('Invalid torrent discovery review.');
  }
  const saving = action === 'catalog';
  const label = saving ? 'Save source' : action === 'inspect' ? 'Contact peers' : 'Start download';
  return {
    summary: `${name ? `${reviewLabel(name)}\n\n` : ''}${saving ? 'Save this torrent source for future downloads.' : 'Find this torrent on the public peer network.'}\n\nPeers can see your IP address. Torrent downloads can also upload pieces.`,
    remember: saving ? undefined : remember('torrent-discovery', [], 'when finding torrents on the public peer network'),
    type: 'warning',
    buttons: ['Cancel', label],
    defaultId: 0,
    cancelId: 0,
    message: saving ? 'Save this torrent source?' : 'Find torrent peers?',
    detail: `${name ? `Name: ${exact(name, 200, 'catalog name')}\n\n` : ''}Content identity (infohash):\n${exact(infoHash, 40, 'torrent infohash')}\n\n${saving
      ? 'Saving this source allows a later Pull action to send this exact identity to the configured public trackers and/or DHT.'
      : 'FrostByte will send this exact identity to the configured public trackers and/or DHT to find torrent metadata and peers. Torrent downloads can upload received pieces, and completed downloads keep sharing when your seeding setting is on.'}`,
  };
}

export function pairedPeerEndpointsReview({ device, identity, planDigest, infoHash, peers }) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)
    || !/^[a-f0-9]{64}$/.test(planDigest || '') || !/^[a-f0-9]{40}$/.test(infoHash || '')
    || !Array.isArray(peers) || !peers.length || peers.length > 8
    || peers.some(peer => typeof peer !== 'string' || !peer || peer.length > 64 || /[\0\r\n]/.test(peer))) {
    throw new Error('Invalid paired-peer endpoint review.');
  }
  return {
    summary: `${reviewLabel(device)} suggests these peer addresses:\n${peers.join('\n')}\n\nOnly connect to addresses you trust. They may be on your private network.`,
    type: 'warning',
    buttons: ['Cancel', 'Connect to these addresses'],
    defaultId: 0,
    cancelId: 0,
    message: 'Let this paired device direct peer connections?',
    detail: `Device: ${exact(device, 512, 'device name')}\n\nRepository: ${exact(identity.repoId, 200, 'repository ID')}\nFile: ${exact(identity.filePath, 4096, 'HF file path')}\nRevision: ${exact(identity.revision, 40, 'HF revision')}\n\nTorrent identity: ${exact(infoHash, 40, 'torrent infohash')}\nPlan identity: ${exact(planDigest, 64, 'peer plan identity')}\n\nExact addresses:\n${JSON.stringify(peers)}\n\nThese addresses may reach services on your private network. Continue only if they belong to the paired device or peers you trust.`,
  };
}

export function deviceAccessRemovalReview({ device, host }) {
  return {
    summary: `${reviewLabel(device)} · ${reviewLabel(host)}\n\nRemove this app’s access and forget the connection. Files and downloads on the device stay in place.`,
    type: 'warning',
    buttons: ['Keep connection', 'Remove access and forget'],
    defaultId: 0,
    cancelId: 0,
    message: 'Remove this device connection?',
    detail: `Device: ${exact(device, 512, 'device name')}\nAddress: ${exact(host, 512, 'device address')}\n\nFrostByte will ask the companion to remove this app’s restricted SSH key, then delete the saved connection on this computer. Downloads and files on the device stay in place.`,
  };
}

export function hfCredentialChangeReview({ action, currentUser = '', currentRole = '', nextUser = '', nextRole = '' }) {
  if (!['clear', 'set'].includes(action)) throw new Error('Invalid Hugging Face credential action.');
  const current = currentUser ? `${exact(currentUser, 200, 'current Hugging Face user')}${currentRole ? ` · role ${exact(currentRole, 100, 'current Hugging Face role')}` : ''}` : '(saved account identity unavailable)';
  const next = nextUser ? `${exact(nextUser, 200, 'new Hugging Face user')}${nextRole ? ` · role ${exact(nextRole, 100, 'new Hugging Face role')}` : ''}` : '(none)';
  return {
    summary: action === 'clear'
      ? `${reviewLabel(currentUser || 'Saved account')}\n\nPrivate and gated downloads will need a new token.`
      : `Account: ${reviewLabel(nextUser || 'Hugging Face')}${nextRole ? ` · ${reviewLabel(nextRole, 40)}` : ''}\n\nStore this token using operating-system encryption for Hugging Face requests.`,
    type: 'warning',
    buttons: ['Cancel', action === 'clear' ? 'Remove token' : 'Save token'],
    defaultId: 0,
    cancelId: 0,
    message: action === 'clear' ? 'Remove the saved Hugging Face token?' : 'Save this Hugging Face account token?',
    detail: action === 'clear'
      ? `Current account: ${current}\n\nGated and private downloads will stop working until another token is saved.`
      : `Current account: ${currentUser ? current : '(none)'}\nNew account: ${next}\n\nThe token will be stored with operating-system encryption and used for Hugging Face requests from this computer.`,
  };
}

/** Native boundary before a renderer-supplied bearer token reaches whoami. */
export function hfTokenValidationReview({ endpoint, byteLength, fingerprint }) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 16_384
    || !/^[a-f0-9]{64}$/.test(fingerprint || '')) throw new Error('Invalid Hugging Face token review.');
  return {
    summary: 'Send the token you entered to huggingface.co to check its account and permissions. The token stays hidden in this dialog.',
    type: 'question',
    buttons: ['Cancel', 'Validate token'],
    defaultId: 0,
    cancelId: 0,
    message: 'Check this Hugging Face token?',
    detail: `Exact HTTPS endpoint:\n${exact(endpoint, 4096, 'Hugging Face endpoint')}\n\nToken length: ${byteLength} UTF-8 bytes\nToken SHA-256 fingerprint: ${exact(fingerprint, 64, 'token fingerprint')}\n\nThe token itself is hidden. Its fingerprint lets you verify that the exact submitted credential is the one being validated.`,
  };
}

/** Native boundary whenever a saved bearer token accompanies metadata. */
export function authenticatedHfRequestReview({ action, endpoint, repoId, revision = '', user = '', tokenGeneration }) {
  if (!['model', 'refs'].includes(action) || !/^sha256:[a-f0-9]{64}$/.test(tokenGeneration || '')) {
    throw new Error('Invalid authenticated Hugging Face request review.');
  }
  return {
    summary: `${reviewLabel(repoId)}\n\nLoad ${action === 'refs' ? 'available versions' : 'model details'} from huggingface.co using your saved ${reviewLabel(user || 'Hugging Face', 80)} token.`,
    remember: hfBrowsePermission(endpoint, tokenGeneration),
    type: 'question',
    buttons: ['Cancel', 'Send authenticated request'],
    defaultId: 0,
    cancelId: 0,
    message: 'Use your Hugging Face account?',
    detail: `Repository: ${exact(repoId, 200, 'repository ID')}${revision ? `\nRevision: ${exact(revision, 200, 'revision')}` : ''}${user ? `\nSaved account: ${exact(user, 200, 'Hugging Face account')}` : ''}\n\nExact HTTPS endpoint:\n${exact(endpoint, 4096, 'Hugging Face endpoint')}\n\nCredential generation: ${exact(tokenGeneration, 71, 'credential generation')}\n\nThe token is hidden, but it will be sent as a Bearer credential with this exact request.`,
  };
}

/** Native boundary for the exact durable work entering the local HF queue. */
export function hfDownloadReview({ repoId, revision, root, fileCount, totalBytes, manifestDigest, tokenGeneration, user = '', action = 'start' }) {
  if (!['start', 'resume'].includes(action) || !/^[a-f0-9]{40}$/.test(revision || '')
    || !Number.isSafeInteger(fileCount) || fileCount < 1 || fileCount > 2000
    || !Number.isSafeInteger(totalBytes) || totalBytes < 0
    || !/^[a-f0-9]{64}$/.test(manifestDigest || '')
    || !/^(?:none|sha256:[a-f0-9]{64})$/.test(tokenGeneration || '')) {
    throw new Error('Invalid Hugging Face download review.');
  }
  const authenticated = tokenGeneration !== 'none';
  return {
    summary: `${reviewLabel(repoId)}\n${fileCount} file${fileCount === 1 ? '' : 's'} · ${reviewSize(totalBytes)}\nTo: ${reviewLabel(root, 200)}\n\n${authenticated ? 'Uses your saved Hugging Face token.' : 'Downloads from Hugging Face without an account token.'}`,
    remember: remember('hf-local-download', [root, tokenGeneration], 'for Hugging Face downloads here'),
    type: 'question',
    buttons: ['Cancel', action === 'resume' ? 'Resume download' : 'Start download'],
    defaultId: 0,
    cancelId: 0,
    message: action === 'resume' ? 'Resume this Hugging Face download?' : 'Start this Hugging Face download?',
    detail: `Repository: ${exact(repoId, 200, 'repository ID')}\nPinned revision: ${exact(revision, 40, 'revision')}\nDownload root: ${exact(root, 32768, 'download root')}\nFiles: ${fileCount}\nTotal declared bytes: ${totalBytes}\nNormalized manifest SHA-256: ${exact(manifestDigest, 64, 'manifest digest')}\nCredential generation: ${exact(tokenGeneration, 71, 'credential generation')}${authenticated && user ? `\nSaved account: ${exact(user, 200, 'Hugging Face account')}` : ''}\n\n${authenticated ? 'The saved token will be sent only to approved Hugging Face endpoints for these pinned files.' : 'This request will use public Hugging Face access without a saved token.'}`,
  };
}

export function remoteHfDownloadReview({ device, repoId, revision, destination, fileCount, totalBytes,
  manifestDigest, tokenGeneration, savedCredentialPresent, usesCredential, deviceBinding, action = 'start', status = 'new', downloadedBytes = 0 }) {
  if (typeof savedCredentialPresent !== 'boolean' || typeof usesCredential !== 'boolean'
    || !['start', 'resume'].includes(action)
    || typeof status !== 'string' || !status || status.length > 80 || /[\0\r\n]/.test(status)
    || !Number.isSafeInteger(downloadedBytes) || downloadedBytes < 0 || totalBytes > 0 && downloadedBytes > totalBytes
    || !/^[a-f0-9]{40}$/.test(revision || '')
    || !Number.isSafeInteger(fileCount) || fileCount < 1 || fileCount > 2000
    || !Number.isSafeInteger(totalBytes) || totalBytes < 0
    || !/^[a-f0-9]{64}$/.test(manifestDigest || '')
    || !/^(?:none|sha256:[a-f0-9]{64})$/.test(tokenGeneration || '')
    || (usesCredential && tokenGeneration === 'none')) {
    throw new Error('Invalid remote Hugging Face download review.');
  }
  return {
    summary: `${reviewLabel(repoId)}\n${fileCount} file${fileCount === 1 ? '' : 's'} · ${reviewSize(totalBytes)}\nDevice: ${reviewLabel(device, 100)}\nTo: ${reviewLabel(destination, 180)}\n\n${usesCredential ? 'This device will receive your saved Hugging Face token, including access to other repositories.' : 'No account token is sent to the device.'}`,
    remember: !usesCredential && /^[a-f0-9]{64}$/.test(deviceBinding || '')
      ? remember('hf-device-download', [deviceBinding, destination], 'for public Hugging Face downloads here') : undefined,
    type: usesCredential ? 'warning' : 'question',
    buttons: ['Cancel', action === 'resume' ? 'Resume on device' : 'Queue on device'],
    defaultId: 0,
    cancelId: 0,
    message: action === 'resume'
      ? 'Resume on this device?'
      : 'Download to this device?',
    detail: `Device: ${exact(device, 512, 'device name')}\nRepository: ${exact(repoId, 200, 'repository ID')}\nPinned revision: ${exact(revision, 40, 'revision')}\nDevice destination: ${exact(destination, 4096, 'device destination')}\nFiles: ${fileCount}\nTotal declared bytes: ${totalBytes}${action === 'resume' ? `\nCurrent state: ${exact(status, 80, 'download state')}\nAlready downloaded bytes: ${downloadedBytes}` : ''}\nNormalized manifest SHA-256: ${exact(manifestDigest, 64, 'manifest digest')}\nSaved credential present: ${savedCredentialPresent ? 'YES' : 'NO'}\nCredential sent to device: ${usesCredential ? 'YES' : 'NO'}\nCredential generation: ${exact(tokenGeneration, 71, 'credential generation')}\n\nThe paired companion will receive this exact pinned manifest and may write all declared bytes under the selected device folder.${usesCredential ? ' It will also receive the saved token for this attempt.' : ''}`,
  };
}

export function externalUrlReview(url) {
  return {
    summary: reviewLabel(url, 260),
    remember: new URL(url).origin === 'https://huggingface.co'
      ? remember('hf-browser', ['https://huggingface.co'], 'when opening Hugging Face model pages') : undefined,
    type: 'question',
    buttons: ['Cancel', 'Open in browser'],
    defaultId: 0,
    cancelId: 0,
    message: 'Open this model page in your browser?',
    detail: `Exact external URL:\n${exact(url, 4096, 'external URL')}\n\nYour browser will receive this address. Continue only if this is the Hugging Face model page you intended to open.`,
  };
}

export function privacyAcceptanceReview({ termsVersion, privacyVersion, diagnosticsEnabled = false }) {
  if (diagnosticsEnabled !== false) throw new Error('FrostByte 1.0 does not support automatic diagnostics.');
  return {
    summary: 'Save your acceptance of the FrostByte 1.0 terms and privacy notice on this computer.\n\nNo analytics, automatic diagnostic reports, or in-app feedback collection. You’ll be asked again only if the notices change.',
    type: 'warning',
    buttons: ['Quit or keep reviewing', 'Accept and continue'],
    defaultId: 0,
    cancelId: 0,
    message: 'Accept the FrostByte 1.0 terms and privacy notice?',
    detail: `Terms: ${exact(termsVersion, 200, 'terms version')}\nPrivacy notice: ${exact(privacyVersion, 200, 'privacy version')}\n\nNo analytics, automatic diagnostic reports, or in-app feedback collection. Previous diagnostics opt-ins cannot enable reporting.\n\nAcceptance and application state are saved on your computer. Optional feedback opens GitHub in your browser; you choose what to submit there. Peer-to-peer transfers, connected devices, update checks, and services you use still exchange the network data needed to work.`,
  };
}

export function localTorrentFileReview(file) {
  return {
    summary: `Read the file you dropped:\n${reviewLabel(file, 220)}\n\nYou’ll choose what to download after the preview.`,
    remember: remember('torrent-file', [path.dirname(file)], 'for torrent files in this folder'),
    type: 'question',
    buttons: ['Cancel', 'Read torrent file'],
    defaultId: 0,
    cancelId: 0,
    message: 'Preview this torrent file?',
    detail: `Exact local path:\n${exact(file, 32768, 'torrent file path')}\n\nTorrent metadata can reveal filenames and sizes. Continue only if you just dropped this file into FrostByte.`,
  };
}

export function pirateFaceBrowseReview({ endpoint, target }) {
  const cleanEndpoint = exact(endpoint, 2048, 'Pirate Face endpoint');
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Invalid Pirate Face endpoint.');
  }
  if (parsed.origin !== 'https://pirateface.co' || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Pirate Face browse review requires https://pirateface.co.');
  }
  return {
    summary: `Send a public lookup to pirateface.co:\n${reviewLabel(target, 180)}\n\nNo tokens or local library details are sent. Downloading any magnet stays gated by FrostByte’s separate torrent review.`,
    remember: remember('pirateface-public-browse', ['https://pirateface.co'], 'for public Pirate Face browsing'),
    type: 'question',
    buttons: ['Cancel', 'Connect to Pirate Face'],
    defaultId: 0,
    cancelId: 0,
    message: 'Connect to Pirate Face (pirateface.co)?',
    detail: `Exact external endpoint:\n${cleanEndpoint}\n\nPirate Face is an independent third-party torrent index. Your IP address, user-agent, and this lookup leave your computer over HTTPS (redirects rejected, credentials omitted).\n\nSeed counts are index-reported observations, not availability guarantees. FrostByte strips third-party trackers and webseeds when inspecting or downloading magnets and uses only your local DHT and tracker settings.`,
  };
}

function safeReviewHttpsUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : '';
  } catch {
    return '';
  }
}

export function pirateFaceTermsReview({ repoId, endpoint, termsId, termsName, termsUrl = '', policyUrl = '' }) {
  const cleanRepo = exact(repoId, 240, 'repository ID');
  const cleanEndpoint = exact(endpoint, 2048, 'Pirate Face endpoint');
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Invalid Pirate Face endpoint.');
  }
  if (parsed.origin !== 'https://pirateface.co' || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Pirate Face terms review requires https://pirateface.co.');
  }
  const cleanId = exact(termsId, 80, 'license terms ID');
  const cleanName = reviewLabel(termsName || termsId, 160);
  const displayRepo = reviewLabel(repoId, 160);
  const safeTermsUrl = safeReviewHttpsUrl(termsUrl);
  const safePolicyUrl = safeReviewHttpsUrl(policyUrl);
  const refs = [
    safeTermsUrl ? `Terms URL: ${reviewLabel(safeTermsUrl, 320)}` : '',
    safePolicyUrl ? `Policy URL: ${reviewLabel(safePolicyUrl, 320)}` : '',
  ].filter(Boolean).join('\n');
  return {
    summary: `${cleanName} applies to ${displayRepo}.\n\nAcknowledge that you have reviewed the upstream license terms before requesting this community magnet.`,
    type: 'warning',
    buttons: ['Cancel', 'Acknowledge terms & load magnet'],
    defaultId: 0,
    cancelId: 0,
    message: `Acknowledge ${cleanName} for ${reviewLabel(repoId, 120)}?`,
    detail: `Repository: ${cleanRepo}\nTerms parameter: ${exact(`accept_terms=${termsId}`, 120, 'license terms parameter')}\nExact endpoint:\n${cleanEndpoint}${refs ? `\n\n${refs}` : ''}\n\nThis sends accept_terms=${reviewLabel(termsId, 80)} to pirateface.co to unlock its community magnet record. It does not grant legal acceptance on your behalf or bypass Hugging Face gated-repository approval.`,
  };
}
