import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeJson } from './store.js';

// These are permissions for specific routine actions, not a switch that turns
// off native approval. Only main-process review builders can request a grant.
const KINDS = new Set([
  'clipboard', 'hf-public-browse', 'hf-account-browse', 'hf-local-download',
  'hf-device-download', 'hf-browser', 'pirateface-public-browse',
  'torrent-discovery', 'torrent-file',
  'ipfs-discovery', 'ipfs-download',
  'hub-public-browse', 'hub-account-browse',
  'network-discovery',
  'studio-project-write', 'studio-project-git', 'studio-agent-write', 'studio-agent-exec',
]);
const VERSION = 1; // Bump when the meaning of a remembered permission changes.
const MAX_GRANTS = 256;
const MAX_BYTES = 64 * 1024;

function permissionKey(permission) {
  if (!permission) return null;
  const { kind, scope, label } = permission;
  if (!KINDS.has(kind) || !Array.isArray(scope) || scope.length > 8
    || scope.some(value => typeof value !== 'string' || value.length > 32768 || value.includes('\0'))
    || typeof label !== 'string' || !label || label.length > 180 || /[\r\n\0]/.test(label)) {
    throw new Error('Invalid remembered confirmation.');
  }
  return `${kind}:${createHash('sha256').update(JSON.stringify([VERSION, kind, scope])).digest('hex')}`;
}

/** Native, compact confirmations with opt-in, main-owned permission memory. */
export class ConfirmationService {
  constructor({ directory, showMessageBox, onChange = () => {} }) {
    this.file = path.join(directory, 'confirmations.json');
    this.showMessageBox = showMessageBox;
    this.onChange = onChange;
    this.grants = new Set();
    this.epoch = 0;
    this.pending = 0;
    let fd;
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES
        || typeof process.getuid === 'function' && stat.uid !== process.getuid()) return;
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd), after = fs.lstatSync(this.file);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_BYTES
        || opened.dev !== stat.dev || opened.ino !== stat.ino || after.dev !== stat.dev || after.ino !== stat.ino) return;
      const body = Buffer.alloc(opened.size);
      if (opened.size && fs.readSync(fd, body, 0, opened.size, 0) !== opened.size) return;
      const saved = JSON.parse(body.toString('utf8'));
      if (saved.version !== VERSION || !Array.isArray(saved.grants) || saved.grants.length > MAX_GRANTS) return;
      for (const key of saved.grants) {
        if (typeof key !== 'string') continue;
        const split = key.lastIndexOf(':');
        if (KINDS.has(key.slice(0, split)) && /^[a-f0-9]{64}$/.test(key.slice(split + 1))) this.grants.add(key);
      }
    } catch { /* Missing or invalid preferences always ask again. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  snapshot() { return { remembered: this.grants.size }; }

  reset() {
    this.save(new Set());
    // An open dialog cannot undo a reset with an older choice.
    this.epoch++;
    return this.snapshot();
  }

  save(grants) {
    writeJson(this.file, { version: VERSION, grants: [...grants] }, { maxBytes: MAX_BYTES });
    this.grants = grants;
    this.onChange(this.snapshot());
  }

  show(window, review) {
    // Capture the exact main-owned description before displaying the dialog.
    const captured = structuredClone(review);
    const key = permissionKey(captured.remember);
    const epoch = this.epoch;
    if (this.pending >= 16) return Promise.resolve({ response: captured.cancelId ?? 0, checkboxChecked: false });
    this.pending++;
    return this.present(window, captured, key, epoch).finally(() => { this.pending--; });
  }

  async present(window, review, key, epoch) {
    const { summary, remember, ...options } = review;
    const cancelled = { response: options.cancelId ?? 0, checkboxChecked: false };
    if (epoch !== this.epoch || window?.isDestroyed?.()) return cancelled;
    if (key && (options.cancelId !== 0 || options.defaultId !== 0 || options.buttons?.length !== 2)) {
      throw new Error('Remembered confirmations must cancel by default.');
    }
    if (key && this.grants.has(key)) return { response: 1, checkboxChecked: true };
    const expandable = typeof summary === 'string' && summary !== options.detail;
    let expanded = false, checked = false;
    while (true) {
      const result = await this.showMessageBox(window, {
        ...options, title: options.title || 'FrostByte', noLink: true, textWidth: 440,
        detail: expandable && !expanded ? summary : options.detail,
        buttons: expandable ? [...options.buttons, expanded ? 'Back' : 'Details…'] : options.buttons,
        ...(key ? { checkboxLabel: remember.label, checkboxChecked: checked } : {}),
      });
      if (epoch !== this.epoch || window?.isDestroyed?.()) return cancelled;
      checked = result.checkboxChecked === true;
      if (expandable && result.response === options.buttons.length) { expanded = !expanded; continue; }
      if (result.response === 1 && key && checked) {
        const grants = new Set(this.grants);
        if (grants.size >= MAX_GRANTS) grants.delete(grants.values().next().value);
        grants.add(key);
        this.save(grants);
      }
      // Unexpected native responses fail closed just like Escape/Cancel.
      return result.response >= 0 && result.response < options.buttons.length ? result : cancelled;
    }
  }
}
