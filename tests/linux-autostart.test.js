import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linuxAutostartEntry, linuxAutostartPath, setLinuxAutostart, setOpenAtLogin } from '../src/main/linux-autostart.js';

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frostbyte-autostart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const desktopId = 'ai.blackfrost.frostbyte.desktop';

test('Linux autostart uses the isolated profile, then XDG_CONFIG_HOME, then the home fallback', t => {
  const root = temporaryRoot(t);
  assert.equal(linuxAutostartPath({ environment: { FROSTBYTE_HOME: path.join(root, 'profile'), XDG_CONFIG_HOME: path.join(root, 'xdg') }, home: root, desktopId }),
    path.join(root, 'profile', 'xdg-config', 'autostart', desktopId));
  assert.equal(linuxAutostartPath({ environment: { XDG_CONFIG_HOME: path.join(root, 'xdg') }, home: root, desktopId }),
    path.join(root, 'xdg', 'autostart', desktopId));
  assert.equal(linuxAutostartPath({ environment: { XDG_CONFIG_HOME: 'relative-is-invalid' }, home: root, desktopId }),
    path.join(root, '.config', 'autostart', desktopId));
  assert.throws(() => linuxAutostartPath({ environment: {}, home: '', desktopId: '../other.desktop' }), /identity/i);
});

test('Linux autostart writes an atomic private desktop entry and prefers the durable AppImage path', t => {
  const root = temporaryRoot(t);
  const profile = path.join(root, 'profile');
  const appImage = path.join(root, 'FrostByte.AppImage');
  const app = { getPath: name => name === 'exe' ? path.join(root, 'temporary-mount', 'frostbyte') : '' };
  const options = { app, openAtLogin: true, environment: { FROSTBYTE_HOME: profile, APPIMAGE: appImage }, home: root, desktopId, name: 'Frost/Byte' };
  const target = setLinuxAutostart(options);
  const value = fs.readFileSync(target, 'utf8');
  assert.equal(target, path.join(profile, 'xdg-config', 'autostart', desktopId));
  assert.match(value, /^\[Desktop Entry\]$/m);
  assert.match(value, /^Name=Frost\/Byte$/m);
  const quotedAppImage = appImage.replace(/[\\"`$]/g, character => `\\${character}`);
  assert.equal(value.split('\n').find(line => line.startsWith('Exec=')), `Exec="${quotedAppImage}"`);
  assert.match(value, /^X-FrostByte-Autostart=true$/m);
  // Windows can run the portable unit suite but does not implement POSIX mode
  // bits. The native Linux and Mac lanes still verify the private file mode.
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [desktopId]);

  setLinuxAutostart({ ...options, openAtLogin: false });
  assert.equal(fs.existsSync(target), false);
});

test('Linux autostart refuses foreign files, links, and invalid executable data', t => {
  const root = temporaryRoot(t);
  const environment = { XDG_CONFIG_HOME: path.join(root, 'xdg') };
  const target = linuxAutostartPath({ environment, home: root, desktopId });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '[Desktop Entry]\nName=Another app\n');
  const options = { app: { getPath: () => '/opt/frostbyte/frostbyte' }, environment, home: root, desktopId, name: 'Frost/Byte' };
  assert.throws(() => setLinuxAutostart({ ...options, openAtLogin: true }), /not owned/i);
  assert.throws(() => setLinuxAutostart({ ...options, openAtLogin: false }), /not owned/i);
  fs.unlinkSync(target);
  fs.symlinkSync(path.join(root, 'outside.desktop'), target);
  assert.throws(() => setLinuxAutostart({ ...options, openAtLogin: true }), /regular file/i);
  assert.throws(() => setLinuxAutostart({ ...options, openAtLogin: false }), /safe FrostByte file/i);
  assert.throws(() => linuxAutostartEntry({ app: { getPath: () => 'relative' }, environment: {}, name: 'Frost/Byte' }), /executable/i);
});

test('the platform wrapper keeps native login calls and adds XDG behavior only on Linux', t => {
  const root = temporaryRoot(t);
  const calls = [];
  const app = { setLoginItemSettings: value => calls.push(value), getPath: () => '/opt/FrostByte/frostbyte' };
  assert.equal(setOpenAtLogin({ app, openAtLogin: true, platform: 'darwin' }), null);
  const target = setOpenAtLogin({ app, openAtLogin: true, platform: 'linux', environment: { XDG_CONFIG_HOME: root }, home: root, desktopId, name: 'Frost/Byte' });
  assert.deepEqual(calls, [{ openAtLogin: true }, { openAtLogin: true }]);
  assert.equal(fs.existsSync(target), true);
});
