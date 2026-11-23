import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptBetaTerms } from './consent-helper.js';

test('anonymous HF reads need accepted terms but no per-request prompt; saved credentials stay reviewed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hf-outbound-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
    downloadDir: path.join(home, 'downloads'), dhtEnabled: false, upnpEnabled: false,
    confirmExitSeeding: false, autoCheckUpdates: false,
  }));
  let app;
  try {
    app = await electron.launch({
      executablePath: process.env.FROSTBYTE_EXECUTABLE,
      args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'],
      env: { ...process.env, FROSTBYTE_HOME: home },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.frostbyte);
    await app.evaluate(() => {
      globalThis.hfOutboundFetches = [];
      globalThis.fetch = async (input) => { globalThis.hfOutboundFetches.push(String(input)); throw new Error('fetch before terms'); };
    });
    // Before the first-launch terms are accepted, no HF channel reaches the network.
    for (const call of [
      () => window.frostbyte.hfSearch('owner model', { limit: 40 }),
      () => window.frostbyte.hfModel('owner/model', 'main'),
      () => window.frostbyte.hfRefs('owner/model'),
    ]) {
      const result = await page.evaluate(call);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Accept the FrostByte/);
    }
    expect(await app.evaluate(() => globalThis.hfOutboundFetches)).toEqual([]);

    await acceptBetaTerms(page, app);
    await app.evaluate(({ dialog }) => {
      globalThis.hfOutboundFetches = [];
      globalThis.hfOutboundReviews = [];
      dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
        globalThis.hfOutboundReviews.push(structuredClone(options));
        return { response: 0 };
      };
      globalThis.fetch = async (input, options = {}) => {
        const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
        const headers = new Headers(options.headers || {});
        globalThis.hfOutboundFetches.push({ url: url.href, authorization: headers.get('authorization') });
        if (url.hostname !== 'huggingface.co') throw new Error(`Unexpected host: ${url.href}`);
        if (url.pathname === '/api/models') return new Response(JSON.stringify([{ id: 'owner/model', tags: [] }]), { status: 200 });
        if (url.pathname === '/api/models/owner/model/refs') return new Response(JSON.stringify({
          branches: [{ name: 'main' }], tags: [{ name: 'v1' }],
        }), { status: 200 });
        if (url.pathname.startsWith('/api/models/owner/model')) return new Response(JSON.stringify({
          id: 'owner/model', sha: 'a'.repeat(40), siblings: [{ rfilename: 'config.json', size: 12 }], tags: [],
        }), { status: 200 });
        if (url.pathname === '/api/whoami-v2') return new Response(JSON.stringify({
          name: 'fixture-user', auth: { accessToken: { role: 'read' } },
        }), { status: 200 });
        throw new Error(`Unexpected HF fixture URL: ${url.href}`);
      };
    });
    // After acceptance: anonymous search, model details and refs run without a native prompt,
    // carry no credential, and only ever reach huggingface.co.
    const search = await page.evaluate(() => window.frostbyte.hfSearch('owner model', { limit: 40 }));
    expect(search.ok, search.error).toBe(true);
    expect(search.data.models.map(row => row.id)).toEqual(['owner/model']);
    const model = await page.evaluate(() => window.frostbyte.hfModel('owner/model', 'v1'));
    expect(model.ok, model.error).toBe(true);
    const refs = await page.evaluate(() => window.frostbyte.hfRefs('owner/model'));
    expect(refs.ok, refs.error).toBe(true);
    expect(await app.evaluate(() => globalThis.hfOutboundReviews)).toEqual([]);
    const anonymous = await app.evaluate(() => globalThis.hfOutboundFetches);
    expect(anonymous.length).toBeGreaterThanOrEqual(3);
    for (const fetch of anonymous) expect(fetch.authorization).toBeNull();
    // Renderer-supplied repo ids are still validated in main before any request.
    const before = anonymous.length;
    const hostile = await page.evaluate(() => window.frostbyte.hfModel('../etc/passwd', 'main'));
    expect(hostile.ok).toBe(false);
    expect((await app.evaluate(() => globalThis.hfOutboundFetches)).length).toBe(before);

    // Repository capabilities never imply permission to attach a saved bearer
    // credential. Authenticated model and refs calls still need native review.
    await app.evaluate(({ dialog, safeStorage }) => {
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.getSelectedStorageBackend = () => 'test-keychain';
      safeStorage.encryptString = value => Buffer.from(value, 'utf8');
      safeStorage.decryptString = value => Buffer.from(value).toString('utf8');
      dialog.showMessageBox = async () => ({ response: 1 });
    });
    const token = await page.evaluate(() => window.frostbyte.hfSetToken('hf_boundary_saved'));
    expect(token.ok, token.error).toBe(true);
    await app.evaluate(({ dialog }) => {
      globalThis.hfOutboundReviews = [];
      globalThis.hfOutboundFetches = [];
      dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
        globalThis.hfOutboundReviews.push(structuredClone(options));
        return { response: 0 };
      };
    });
    const authenticatedModel = await page.evaluate(() => window.frostbyte.hfModel('owner/model', 'main'));
    const authenticatedRefs = await page.evaluate(() => window.frostbyte.hfRefs('owner/model'));
    expect(authenticatedModel).toEqual({ ok: true, data: { cancelled: true } });
    expect(authenticatedRefs).toEqual({ ok: true, data: { cancelled: true } });
    expect(await app.evaluate(() => globalThis.hfOutboundFetches)).toEqual([]);
    const authenticatedReviews = await app.evaluate(() => globalThis.hfOutboundReviews);
    expect(authenticatedReviews).toHaveLength(2);
    for (const review of authenticatedReviews) expect(review.detail).toMatch(/Credential generation: "sha256:[a-f0-9]{64}"/);
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
