import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('shutdown attempts router cleanup and engine destruction after final persistence fails', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-shutdown-errors-')));
  const downloads = path.join(home, 'downloads');
  const evidence = path.join(home, 'shutdown-events.log');
  fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
    downloadDir: downloads, upnpEnabled: false, dhtEnabled: false,
    confirmExitSeeding: false, confirmBigPull: false,
  }));

  let frostApp;
  try {
    frostApp = await electron.launch({
      executablePath: process.env.FROSTBYTE_EXECUTABLE,
      args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.', '--dev'],
      env: { ...process.env, FROSTBYTE_HOME: home },
      timeout: 30_000,
    });
    const page = await frostApp.firstWindow();
    await acceptBetaTerms(page, frostApp);
    await page.waitForFunction(() => window.frostbyte && document.querySelector('#nav .nav.on'));

    await frostApp.evaluate(async ({ app }, { fixturePath, loaderPath }) => {
      const fs = process.getBuiltinModule('fs');
      const path = process.getBuiltinModule('path');
      const appPath = app.getAppPath();
      const load = file => process.getBuiltinModule('module').createRequire(file)(file);
      const storePath = path.join(appPath, 'src/main/store.js');
      const managersPath = path.join(appPath, 'src/main/managers.js');
      const mainPath = path.join(appPath, 'src/main/index.js');
      const { Store } = load(storePath);
      const { UpnpManager } = load(managersPath);
      const require = process.getBuiltinModule('module').createRequire(mainPath);
      const main = await require(loaderPath)(mainPath);
      const originalFlush = Store.prototype._flush;
      const originalDestroy = main.engine.destroy.bind(main.engine);
      const record = event => fs.appendFileSync(fixturePath, `${event}\n`, { encoding: 'utf8', mode: 0o600 });

      globalThis.__shutdownFailureFixtureArmed = false;
      Store.prototype._flush = function (...args) {
        if (!globalThis.__shutdownFailureFixtureArmed) return originalFlush.apply(this, args);
        record('persist:failed');
        throw new Error('Fixture final persistence failure');
      };
      UpnpManager.prototype.disable = async function () {
        record('upnp:failed');
        throw new Error('Fixture router unmap failure');
      };
      main.engine.destroy = async function (...args) {
        record('engine:destroy');
        return originalDestroy(...args);
      };
    }, { fixturePath: evidence, loaderPath: path.resolve('tests/e2e/load-main.cjs') });

    const child = frostApp.process();
    const exited = new Promise(resolve => {
      if (child.exitCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
      else child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    await frostApp.evaluate(({ app }) => {
      globalThis.__shutdownFailureFixtureArmed = true;
      app.quit();
    }).catch(() => {});
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture app did not exit')), 20_000)),
    ]);
    expect(result).toEqual({ code: 1, signal: null });

    const events = fs.readFileSync(evidence, 'utf8').trim().split('\n');
    expect(events.filter(event => event === 'persist:failed').length).toBeGreaterThanOrEqual(2);
    expect(events.filter(event => event === 'upnp:failed')).toHaveLength(2);
    expect(events.filter(event => event === 'engine:destroy')).toHaveLength(1);
    expect(events.indexOf('engine:destroy')).toBeGreaterThan(events.lastIndexOf('upnp:failed'));
    frostApp = undefined;
  } finally {
    await frostApp?.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});
