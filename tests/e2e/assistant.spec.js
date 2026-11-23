import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acceptBetaTerms } from './consent-helper.js';
import { createServer } from 'node:http';

const repo = path.resolve(import.meta.dirname, '../..');

test('automatic discovery, streaming, history, clear and sandbox isolation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-assistant-ui-'));
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'test-local:8b' }] })); return; }
    if (req.url === '/api/ps') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: [] })); return; }
    if (req.url === '/api/chat') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
      if (String(JSON.parse(body).messages.at(-1)?.content || '').includes('Stop this')) {
        // Hold the connection open until the desktop cancels it.
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.write(JSON.stringify({ message: { content: 'Working…' } }) + '\n');
        const drip = setInterval(() => { try { res.write(JSON.stringify({ message: { content: '.' } }) + '\n'); } catch { clearInterval(drip); } }, 500);
        res.on('close', () => clearInterval(drip));
        return;
      }
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.write(JSON.stringify({ message: { content: 'Hello from your device. ' } }) + '\n');
      setTimeout(() => res.end(JSON.stringify({ message: { content: '<img src=x onerror=window.__modelExecuted=true>Done.' }, done: true }) + '\n'), 100);
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(11434, '127.0.0.1', resolve); });
  const app = await electron.launch({ args: [repo, '--dev'], env: { ...process.env, HOME: home, FROSTBYTE_HOME: home } });
  const window = await app.firstWindow();
  window.on('console', message => console.error('[renderer]', message.text()));
  window.on('pageerror', error => console.error('[pageerror]', error.message));
  try {
    await acceptBetaTerms(window, app);
    await window.locator('#assistant-toggle').click();
    await expect(window.locator('#assistant-panel')).toBeVisible();
    await expect(window.locator('.assistant-beta')).toHaveText('Beta Testing');
    await expect(window.locator('#assistant-model-select option')).toContainText('test-local:8b', { timeout: 15000 }).catch(async error => { throw new Error(JSON.stringify(await window.evaluate(async () => ({ catalog: await window.frostbyte.runtimeModels(true), state: document.getElementById('assistant-model-state').textContent, error: document.getElementById('assistant-error').textContent, options: document.getElementById('assistant-model-select').outerHTML }))) + ': ' + error.message); });
    await expect(window.locator('#assistant-model-select option')).toHaveCount(1);
    await window.locator('#assistant-input').fill('Hello');
    await window.locator('#assistant-send').click();
    await expect(window.locator('.assistant-message.assistant .assistant-message-content')).toHaveText('Hello from your device. <img src=x onerror=window.__modelExecuted=true>Done.', { timeout: 15000 });
    expect(await window.evaluate(() => window.__modelExecuted)).not.toBe(true);
    expect(await window.evaluate(() => ({ require: typeof require, process: typeof process }))).toEqual({ require: 'undefined', process: 'undefined' });
    await window.locator('#assistant-close').click();
    await window.reload();
    await window.locator('#assistant-toggle').click();
    await expect(window.locator('.assistant-message.user .assistant-message-content')).toHaveText('Hello');
    await expect(window.locator('.assistant-message.assistant .assistant-message-content')).toContainText('Hello from your device.');
    await window.locator('#assistant-input').fill('Stop this');
    await window.locator('#assistant-send').click();
    await expect(window.locator('#assistant-stop')).toBeVisible();
    await window.locator('#assistant-stop').click();
    await expect(window.locator('#assistant-send')).toBeVisible();
    window.once('dialog', dialog => dialog.accept());
    await window.locator('#assistant-clear').click();
    // Clear wipes stored conversations and opens one fresh empty conversation.
    await expect(window.locator('#assistant-history .assistant-history-item')).toHaveCount(1, { timeout: 15000 });
    await expect(window.locator('#assistant-history .assistant-history-item')).toHaveText(/New conversation/);
    await expect(window.locator('.assistant-message')).toHaveCount(0);
    const stored = await window.evaluate(() => window.frostbyte.runtimeConversations());
    expect(stored).toHaveLength(1);
  } finally { await app.close(); await new Promise(resolve => server.close(resolve)); }
});
