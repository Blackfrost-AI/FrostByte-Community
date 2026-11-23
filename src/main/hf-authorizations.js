import { createHash } from 'node:crypto';
import path from 'node:path';

export const HF_ORIGIN = 'https://huggingface.co';
export const HF_WHOAMI_ENDPOINT = `${HF_ORIGIN}/api/whoami-v2`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactString(value, max, label) {
  if (typeof value !== 'string' || !value || value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function tokenGeneration(value) {
  if (value === 'none' || /^sha256:[a-f0-9]{64}$/.test(value || '')) return value;
  throw new Error('Invalid Hugging Face credential generation.');
}

/** A non-secret, exact description of the token that would cross the network. */
export function describeHfToken(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw new Error('That HuggingFace token is invalid.');
  }
  const bytes = Buffer.from(value, 'utf8');
  const fingerprint = sha256(bytes);
  return { byteLength: bytes.length, fingerprint, generation: `sha256:${fingerprint}` };
}

/** Compare this exact string after a native review; it deliberately stays inside main. */
export function hfCredentialStateSnapshot(state) {
  const fields = ['hfTokenEnc', 'hfTokenPlain', 'hfTokenMigrationRequired', 'hfUser', 'hfRole'];
  return JSON.stringify(fields.map(key => [key, Object.hasOwn(state, key), state[key]]));
}

export function describeSavedHfCredential(state, token) {
  const snapshot = hfCredentialStateSnapshot(state);
  const descriptor = token ? describeHfToken(token) : null;
  return {
    snapshot,
    generation: descriptor?.generation || 'none',
    authenticated: Boolean(descriptor),
    user: typeof state.hfUser === 'string' && state.hfUser.length <= 200 && !/[\0\r\n]/.test(state.hfUser)
      ? state.hfUser : '',
  };
}

export function normalizeHfRevision(value) {
  return exactString(value, 200, 'Hugging Face revision');
}

export function hfAuthenticatedEndpoint({ action, repoId, revision }) {
  exactString(repoId, 200, 'Hugging Face repository ID');
  const encodedRepo = repoId.split('/').map(encodeURIComponent).join('/');
  if (action === 'refs') return `${HF_ORIGIN}/api/models/${encodedRepo}/refs`;
  if (action === 'model') {
    const suffix = revision ? `/revision/${encodeURIComponent(normalizeHfRevision(revision))}` : '';
    return `${HF_ORIGIN}/api/models/${encodedRepo}${suffix}?blobs=true`;
  }
  throw new Error('Invalid authenticated Hugging Face request.');
}

function normalizedManifest(files) {
  if (!Array.isArray(files) || !files.length || files.length > 2000) {
    throw new Error('Invalid Hugging Face download manifest.');
  }
  const rows = files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Invalid Hugging Face download manifest.');
    const filePath = exactString(file.path, 4096, 'Hugging Face file path');
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid Hugging Face file size.');
    return { path: filePath, size: file.size };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.size - right.size);
  for (let index = 1; index < rows.length; index++) {
    if (rows[index - 1].path === rows[index].path) throw new Error('The Hugging Face download manifest contains a duplicate path.');
  }
  return rows;
}

/** Build the exact request identity displayed by the native download review. */
export function createHfDownloadAuthorization({ repoId, revision, root, files, generation, rootStyle = 'local' }) {
  repoId = exactString(repoId, 200, 'Hugging Face repository ID');
  revision = exactString(revision, 40, 'Hugging Face revision').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Hugging Face downloads require a pinned revision.');
  const paths = rootStyle === 'posix' ? path.posix : rootStyle === 'local' ? path : null;
  if (!paths || typeof root !== 'string' || !root || root.length > 32768 || root.includes('\0') || !paths.isAbsolute(root)) {
    throw new Error('Invalid Hugging Face download root.');
  }
  root = paths.resolve(root);
  generation = tokenGeneration(generation);
  const manifest = normalizedManifest(files);
  let totalBytes = 0;
  for (const file of manifest) {
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes)) throw new Error('The Hugging Face download selection is too large.');
  }
  const manifestDigest = sha256(JSON.stringify(manifest));
  const request = {
    version: 1, repoId, revision, root, fileCount: manifest.length,
    totalBytes, manifestDigest, tokenGeneration: generation,
  };
  return { ...request, requestDigest: sha256(JSON.stringify(request)), manifest };
}

export function hfTransferAuthorization(summary, file) {
  const manifest = normalizedManifest([file]);
  const item = manifest[0];
  const authorization = {
    version: 1,
    fileCount: summary.fileCount,
    totalBytes: summary.totalBytes,
    manifestDigest: summary.manifestDigest,
    tokenGeneration: tokenGeneration(summary.tokenGeneration),
    requestDigest: summary.requestDigest,
  };
  authorization.itemDigest = sha256(JSON.stringify({ requestDigest: authorization.requestDigest, ...item }));
  return authorization;
}

/** Validate persisted authority against both the transfer identity and current credential. */
export function verifyHfTransferAuthorization(record, value, currentGeneration) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || !Number.isSafeInteger(value.fileCount) || value.fileCount < 1 || value.fileCount > 2000
    || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0
    || !/^[a-f0-9]{64}$/.test(value.manifestDigest || '')
    || !/^[a-f0-9]{64}$/.test(value.requestDigest || '')
    || !/^[a-f0-9]{64}$/.test(value.itemDigest || '')) {
    throw new Error('This Hugging Face transfer has no valid native authorization. Resume it to review the request.');
  }
  const generation = tokenGeneration(value.tokenGeneration);
  if (currentGeneration !== undefined && generation !== tokenGeneration(currentGeneration)) {
    throw new Error('The Hugging Face credential changed after this download was approved. Resume it to review the current request.');
  }
  const request = {
    version: 1,
    repoId: exactString(record.repoId, 200, 'Hugging Face repository ID'),
    revision: exactString(record.revision, 40, 'Hugging Face revision').toLowerCase(),
    root: path.resolve(exactString(record.baseDir, 32768, 'Hugging Face download root')),
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
    manifestDigest: value.manifestDigest,
    tokenGeneration: generation,
  };
  if (sha256(JSON.stringify(request)) !== value.requestDigest
    || sha256(JSON.stringify({ requestDigest: value.requestDigest,
      path: exactString(record.filePath, 4096, 'Hugging Face file path'), size: record.total })) !== value.itemDigest) {
    throw new Error('The Hugging Face transfer changed after native authorization. Review the download again.');
  }
  return { ...value, tokenGeneration: generation };
}

/** Short-lived, main-owned authority derived only from reviewed requests and HF responses. */
