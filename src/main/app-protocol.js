import path from 'node:path';

const EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf']);

export function resolveAppAsset(value, appRoot) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== 'frostbyte:' || url.hostname !== 'app' || url.port || url.username || url.password) return null;
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const [, section, ...parts] = decoded.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  const roots = {
    renderer: path.join(appRoot, 'src/renderer'),
    shared: path.join(appRoot, 'src/shared'),
    assets: path.join(appRoot, 'assets'),
  };
  const root = roots[section];
  if (!root) return null;
  const target = path.resolve(root, ...parts);
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) || !EXTENSIONS.has(path.extname(target).toLowerCase())) return null;
  return target;
}

/** Bind privileged IPC to the one live application document, not a URL lookalike. */
export function isAuthorizedAppIpc(event, expectedContents, expectedUrl) {
  if (!event || !expectedContents || typeof expectedUrl !== 'string') return false;
  if (typeof expectedContents.isDestroyed === 'function' && expectedContents.isDestroyed()) return false;
  return event.sender === expectedContents
    && event.senderFrame === expectedContents.mainFrame
    && event.senderFrame?.url === expectedUrl;
}

/** Deny renderer-controlled navigation, embedded webviews, and permissions. */
export function lockDownAppWebContents(contents) {
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

/** Debug probes may use saved credentials, so packaged apps never honor them. */
export function allowDebugHfProbe(value, isPackaged) {
  return !isPackaged && typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
