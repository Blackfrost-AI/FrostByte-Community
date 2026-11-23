/** Adapt the existing single-companion IPC doubles to the saved Devices contract.
 * These tests still exercise their existing companion responses/actions. Multi-
 * device isolation and the real registry are covered separately.
 */
export async function exposeCompanionDevice(app) {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const handlers = ipcMain._invokeHandlers;
    const originalState = handlers.get('app:state');
    for (const win of BrowserWindow.getAllWindows()) {
      const wc = win.webContents;
      if (wc && !wc.__companionDeviceWrapped) {
        const origSend = wc.send.bind(wc);
        wc.send = (channel, ...args) => {
          if (channel === 'devices:changed') return;
          return origSend(channel, ...args);
        };
        wc.__companionDeviceWrapped = true;
      }
    }
    let cached, connected = false, error = '', pairedHost = '', patch = {};
    const cancelled = new Set();
    const state = async event => {
      const result = await originalState(event);
      if (!result.ok) return result;
      const value = result.data, host = pairedHost || value.settings.sparkHost;
      if (!cached && value.sparkInventory) cached = structuredClone(value.sparkInventory);
      const devices = host ? [{ id: 'spark', host, name: patch.name || 'DGX Spark', connected, error, managed: patch.managed === true,
        defaultDir: patch.defaultDir || (value.settings.sparkDownloadHost === host ? value.settings.sparkDownloadDir : '') || cached?.downloadDir || '',
        artwork: patch.artwork || '', status: cached || {} }] : [];
      return { ok: true, data: { ...value, settings: { ...value.settings, sparkHost: host,
        ...(patch.defaultDir ? { sparkDownloadHost: host, sparkDownloadDir: patch.defaultDir } : {}) }, devices, selectedDeviceId: host ? 'spark' : '' } };
    };
    globalThis.setCompanionManaged = (value, directLabel) => {
      patch.managed = value === true;
      if (typeof directLabel === 'string' && directLabel) pairedHost = directLabel;
    };
    const update = result => {
      if (result.ok) {
        if (result.data.status) cached = { ...cached, ...structuredClone(result.data.status) };
        connected = result.data.connected === true; error = result.data.error || '';
      } else { connected = false; error = result.error; }
    };
    globalThis.updateCompanionFixture = update;
    for (const name of ['app:state', 'devices:status', 'devices:select', 'devices:configure', 'spark:device-telemetry', 'spark:device-recipes']) ipcMain.removeHandler(name);
    ipcMain.handle('app:state', state);
    ipcMain.handle('spark:device-telemetry', async () => ({
      ok: true,
      data: {
        schema: 1,
        memory: cached?.memoryBytes ? { totalBytes: cached.memoryBytes, availableBytes: cached.freeBytes ?? null } : null,
        docker: { available: false, containers: [] },
      },
    }));
    ipcMain.handle('spark:device-recipes', async () => ({ ok: true, data: [] }));
    ipcMain.handle('devices:status', async (event, force) => {
      update(await handlers.get('spark:status')(event, force));
      return { ok: true, data: (await state(event)).data.devices };
    });
    ipcMain.handle('devices:select', state);
    ipcMain.handle('devices:configure', async (event, _id, changes) => {
      patch = { ...patch, ...changes };
      if (changes.defaultDir) {
        const current = await state(event);
        await handlers.get('settings:set')(event, { sparkDownloadHost: current.data.settings.sparkHost, sparkDownloadDir: changes.defaultDir });
      }
      return state(event);
    });
    for (const name of ['spark:setup-probe', 'spark:setup-cancel', 'spark:setup-install', 'spark:setup-connect', 'spark:connect', 'spark:storage-add', 'item:sharing', 'item:kind']) {
      const original = handlers.get(name);
      if (!original) continue;
      ipcMain.removeHandler(name);
      ipcMain.handle(name, async (event, ...args) => {
        if (name === 'spark:setup-cancel') cancelled.add(args[0]);
        const result = await original(event, ...args);
        if (result.ok) {
          if (name === 'spark:setup-probe') { cancelled.delete(result.data.sessionId); return result; }
          if (name.startsWith('spark:setup-') && cancelled.has(args[0]?.sessionId)) return result;
          if (name === 'spark:connect') { pairedHost = args[0]; cached = structuredClone(result.data); connected = true; }
          else if (result.data?.status) {
            cached = structuredClone(result.data.status); connected = true;
            pairedHost = result.data.host || pairedHost;
            result.data.deviceId = 'spark';
          }
          if (result.data?.state) result.data.state = (await state(event)).data;
        }
        return result;
      });
    }
  });
}
