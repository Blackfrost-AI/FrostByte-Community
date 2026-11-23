/** Filesystem-name rules shared by untrusted torrent and Hub metadata. */

const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001f]/u;
const WINDOWS_DEVICE_STEM = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/iu;

const windowsRules = platform => platform === 'win32' || platform === 'portable';
const insensitiveRules = platform => platform === 'win32' || platform === 'darwin' || platform === 'portable';

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/** A conservative key for Windows and default case-insensitive macOS volumes. */
export function filesystemPathKey(value, platform = 'portable') {
  let result = String(value).replaceAll('\\', '/');
  if (insensitiveRules(platform)) {
    // Upper-then-lower also folds common multi-code-point forms such as ss/ß
    // and ligatures. NFD catches composed/decomposed names on default APFS.
    result = result.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD');
  }
  return result;
}

export function validatePortableComponent(value, { platform = 'portable', label = 'File path' } = {}) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || hasUnpairedSurrogate(value)) {
    throw new Error(`${label} contains an invalid name.`);
  }
  if (Buffer.byteLength(value, 'utf8') > 255 || ((platform === 'darwin' || platform === 'portable') && Buffer.byteLength(value.normalize('NFD'), 'utf8') > 255)) {
    throw new Error(`${label} contains a name longer than the filesystem limit.`);
  }
  if (windowsRules(platform)) {
    if (WINDOWS_FORBIDDEN.test(value) || /[ .]$/u.test(value)) {
      throw new Error(`${label} contains a name that Windows cannot store.`);
    }
    // Win32 resolves DOS device aliases even with an extension, and accepts
    // spelling variants that place spaces or dots between the alias and that
    // extension. Reject the normalized stem before a path reaches Windows.
    const deviceStem = value.split('.', 1)[0].replace(/[ .]+$/u, '');
    if (WINDOWS_DEVICE_STEM.test(deviceStem)) {
      throw new Error(`${label} uses a reserved Windows device name.`);
    }
    if (value.length > 255) throw new Error(`${label} contains a name longer than the Windows filesystem limit.`);
  }
  return value;
}

export function validatePortableRelativePath(value, {
  platform = 'portable', label = 'File path', maxLength = 4096, allowBackslash = false,
} = {}) {
  if (typeof value !== 'string' || !value || value.length > maxLength || value.includes('\0')) {
    throw new Error(`${label} is invalid.`);
  }
  if (!allowBackslash && value.includes('\\')) throw new Error(`${label} is invalid.`);
  const result = allowBackslash ? value.replaceAll('\\', '/') : value;
  if (result.startsWith('/') || /^[a-z]:/iu.test(result)) throw new Error(`${label} must be relative.`);
  const components = result.split('/');
  if (components.some(component => !component)) throw new Error(`${label} contains an invalid name.`);
  for (const component of components) validatePortableComponent(component, { platform, label });
  return result;
}

/** Reject duplicate files, file/directory aliases, and generated-name aliases. */
export function validatePortablePathSet(values, {
  platform = 'portable', label = 'File paths', artifactSuffixes = [],
} = {}) {
  const files = new Set();
  const directories = new Set();
  const namespaces = new Map();
  for (const value of values) {
    const components = value.split('/');
    const keys = components.map(component => filesystemPathKey(component, platform));
    for (let index = 1; index < keys.length; index++) {
      const ancestor = keys.slice(0, index).join('/');
      if (files.has(ancestor)) throw new Error(`${label} contain a file and folder with the same filesystem name.`);
      directories.add(ancestor);
    }
    const key = keys.join('/');
    if (files.has(key)) throw new Error(`${label} contain names that collide on a supported filesystem.`);
    if (directories.has(key)) throw new Error(`${label} contain a file and folder with the same filesystem name.`);
    files.add(key);

    for (const suffix of ['', ...artifactSuffixes]) {
      const last = components.at(-1) + suffix;
      validatePortableComponent(last, { platform, label });
      const namespace = [...keys.slice(0, -1), filesystemPathKey(last, platform)].join('/');
      const prior = namespaces.get(namespace);
      if (prior !== undefined && prior !== key) {
        throw new Error(`${label} collide with a temporary download filename.`);
      }
      namespaces.set(namespace, key);
    }
  }
  return values;
}
