import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const AUTOSTART_MARKER = 'X-FrostByte-Autostart=true';
const MAX_DESKTOP_BYTES = 16 * 1024;

function cleanAbsolutePath(value) {
  return typeof value === 'string' && value === value.trim() && path.isAbsolute(value)
    && value.length <= 4096 && !/[\0\r\n]/.test(value) ? value : '';
}

export function linuxAutostartPath({
  environment = process.env,
  home = os.homedir(),
  desktopId = 'ai.blackfrost.frostbyte.desktop',
} = {}) {
  if (!/^[a-z0-9.-]+\.desktop$/i.test(desktopId) || desktopId.includes('..')) {
    throw new Error('The Linux autostart desktop identity is invalid.');
  }
  const isolated = cleanAbsolutePath(environment?.FROSTBYTE_HOME);
  const configured = cleanAbsolutePath(environment?.XDG_CONFIG_HOME);
  const fallbackHome = cleanAbsolutePath(home);
  if (!isolated && !configured && !fallbackHome) throw new Error('The Linux configuration folder is unavailable.');
  const root = isolated ? path.join(isolated, 'xdg-config') : configured || path.join(fallbackHome, '.config');
  return path.join(root, 'autostart', desktopId);
}

function desktopQuoted(value) {
  const clean = cleanAbsolutePath(value);
  if (!clean) throw new Error('The Linux autostart executable path is invalid.');
  // Freedesktop Exec quoting requires these characters to be escaped inside a
  // quoted argument. The command is data in the desktop entry, never a shell.
  return `"${clean.replace(/[\\"`$]/g, character => `\\${character}`)}"`;
}

export function linuxAutostartEntry({ app, environment = process.env, name = 'Frost/Byte' } = {}) {
  const appImage = cleanAbsolutePath(environment?.APPIMAGE);
  const executable = appImage || cleanAbsolutePath(app?.getPath?.('exe'));
  const displayName = String(name || '').trim();
  if (!displayName || displayName.length > 200 || /[\0\r\n]/.test(displayName)) {
    throw new Error('The Linux autostart application name is invalid.');
  }
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${displayName}`,
    'Comment=Start FrostByte after desktop sign-in',
    `Exec=${desktopQuoted(executable)}`,
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    AUTOSTART_MARKER,
    '',
  ].join('\n');
}

function requireRealDirectory(directory) {
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    stat = fs.lstatSync(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('The Linux autostart folder must be a real directory.');
  }
}

function removeOwnedEntry(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_DESKTOP_BYTES) {
    throw new Error('The existing Linux autostart entry is not a safe FrostByte file.');
  }
  if (!fs.readFileSync(file, 'utf8').split(/\r?\n/).includes(AUTOSTART_MARKER)) {
    throw new Error('The existing Linux autostart entry is not owned by FrostByte.');
  }
  fs.unlinkSync(file);
}

export function setLinuxAutostart({
  app,
  openAtLogin,
  environment = process.env,
  home = os.homedir(),
  desktopId,
  name,
} = {}) {
  if (typeof openAtLogin !== 'boolean') throw new Error('The Linux autostart choice is invalid.');
  const target = linuxAutostartPath({ environment, home, desktopId });
  if (!openAtLogin) {
    removeOwnedEntry(target);
    return target;
  }

  const directory = path.dirname(target);
  requireRealDirectory(directory);
  let existing;
  try { existing = fs.lstatSync(target); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('The existing Linux autostart entry is not a safe regular file.');
  }
  if (existing && (existing.size <= 0 || existing.size > MAX_DESKTOP_BYTES
    || !fs.readFileSync(target, 'utf8').split(/\r?\n/).includes(AUTOSTART_MARKER))) {
    throw new Error('The existing Linux autostart entry is not owned by FrostByte.');
  }

  const value = linuxAutostartEntry({ app, environment, name });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, value, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* cleanup */ }
    try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return target;
}

export function setOpenAtLogin({
  app,
  openAtLogin,
  platform = process.platform,
  environment = process.env,
  home = os.homedir(),
  desktopId,
  name,
} = {}) {
  // Preserve Electron's native call on every platform. It is authoritative on
  // macOS/Windows and keeps platform test instrumentation observable on Linux.
  app.setLoginItemSettings({ openAtLogin });
  if (platform === 'linux') {
    return setLinuxAutostart({ app, openAtLogin, environment, home, desktopId, name });
  }
  return null;
}
