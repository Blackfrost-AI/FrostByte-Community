import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');

test('assistant drawer is isolated from the FrostNet tab and advertises Beta Testing', async () => {
  const html = await fs.readFile(path.join(root, 'src/renderer/index.html'), 'utf8');
  assert.match(html, /id="assistant-toggle"[^>]+title="AI assistant"/);
  assert.match(html, /id="assistant-panel"/);
  assert.match(html, /Beta Testing/);
  assert.match(html, /id="assistant-model-select"/);
  assert.match(html, /id="assistant-history"/);
  assert.match(html, /id="assistant-send"/);
  assert.match(html, /id="assistant-stop"/);
  assert.match(html, /id="assistant-clear"/);
  const app = await fs.readFile(path.join(root, 'src/renderer/app.js'), 'utf8');
  assert.match(app, /import \{ initAssistant \} from '\.\/assistant\.js'/);
  assert.match(app, /initAssistant\(\);/);
  assert.doesNotMatch(html, /id="tab-frostnet"[^>]*assistant/);
});

test('assistant output uses text nodes and the bridge has unsubscribe and no generic IPC', async () => {
  const module = await fs.readFile(path.join(root, 'src/renderer/assistant.js'), 'utf8');
  assert.match(module, /textContent|createTextNode/);
  assert.doesNotMatch(module, /innerHTML\s*=/);
  assert.match(module, /unsubscribe|removeListener/);
  assert.doesNotMatch(module, /eval\(|new Function/);
  const preload = await fs.readFile(path.join(root, 'src/preload/index.cjs'), 'utf8');
  assert.doesNotMatch(preload, /invoke:\s*\(/);
  assert.match(preload, /onRuntimeEvent/);
});
