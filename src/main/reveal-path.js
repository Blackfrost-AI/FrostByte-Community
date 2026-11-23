import path from 'node:path';

function pathsFor(platform) {
  return platform === 'win32' ? path.win32 : platform === 'posix' ? path.posix : path;
}

function normalizeLocal(value, platform, paths) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw new Error('Choose a known local file or folder.');
  }
  if (platform === 'win32' && /^(?:\\\\|\/\/|\\[?.]\\)/.test(value)) {
    throw new Error('Network and device paths cannot be opened from the app.');
  }
  if (!paths.isAbsolute(value)) throw new Error('Choose a known local file or folder.');
  return paths.resolve(value);
}

/** Allow reveal only for an exact path already supplied by trusted main-process state. */
export function approvedRevealPath(value, allowed, { platform = process.platform } = {}) {
  const paths = pathsFor(platform);
  const target = normalizeLocal(value, platform, paths);
  const key = platform === 'win32' ? target.toLowerCase() : target;
  for (const candidate of allowed ?? []) {
    try {
      const normalized = normalizeLocal(candidate, platform, paths);
      if ((platform === 'win32' ? normalized.toLowerCase() : normalized) === key) return target;
    } catch { /* invalid saved paths grant no authority */ }
  }
  throw new Error('That path is not part of a current FrostByte download.');
}
