/** Opt-in real LaunchAgent installation in an isolated home, with an owned test label. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { installSparkCompanion } from '../src/main/spark-installer.js';
import { hfModelInfo } from '../src/main/hf.js';
import { TorrentEngine } from '../src/main/torrent.js';
const exec = promisify(execFile);

test('native Mac companion installs, reports real hardware, and keeps state through an update', { skip: process.platform !== 'darwin' || process.env.FROSTBYTE_TEST_MAC_INSTALLER !== '1', timeout: 25 * 60 * 1000 }, async () => {
  const home = await fs.mkdtemp('/tmp/fbn-'), bundleDir = path.join(home, 'bundle'), downloadDir = path.join(home, 'models');
  const label = 'ai.blackfrost.frostbyte.test.' + crypto.randomBytes(6).toString('hex');
  const domain = `gui/${process.getuid()}`, root = path.join(home, '.local/share/frostbyte-beta');
  let seed;
  try {
    await fs.cp('build/spark-companion', bundleDir, { recursive: true });
    const installer = (await fs.readFile(path.join(bundleDir, 'mac-onboard.py'), 'utf8')).replace("LABEL = 'ai.blackfrost.frostbyte.companion'", `LABEL = '${label}'`);
    await fs.writeFile(path.join(bundleDir, 'mac-onboard.py'), installer);
    const manifest = JSON.parse(await fs.readFile(path.join(bundleDir, 'manifest.json')));
    manifest.macInstallerSha256 = crypto.createHash('sha256').update(installer).digest('hex');
    await fs.writeFile(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest));
    const execute = (command, { input, signal } = {}) => new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home }, signal });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
    });
    const options = { execute, bundleDir, downloadDir, runtime: 'mac-native', onProgress: event => console.log(event.stage) };
    const first = await installSparkCompanion(options);
    assert.equal(first.status.hardware.platform, 'darwin'); assert.ok(first.status.hardware.modelIdentifier);
    assert.ok(first.status.hardware.memoryBytes > 0); assert.equal(first.status.capabilities.runtime, 'mac-native');
    assert.doesNotMatch(JSON.stringify(first.status.hardware), /serial|uuid/i);
    const request = data => new Promise((resolve, reject) => {
      const child = spawn(path.join(root, 'current/runtime/bin/node'), [path.join(root, 'current/src/agent/client.js')], { env: { ...process.env, FROSTBYTE_AGENT_HOME: path.join(root, 'state') } });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.on('error', reject);
      child.on('close', code => { try { const result = JSON.parse(output); if (code || !result.ok) throw new Error(result.error || 'Companion request failed'); resolve(result.data); } catch (error) { reject(error); } });
      child.stdin.end(JSON.stringify(data) + '\n');
    });
    const model = await hfModelInfo('Qwen/Qwen3-0.6B');
    await request({ action: 'hf:add', repoId: model.id, revision: model.sha, files: [model.files.find(file => file.path === 'config.json')], destination: first.status.downloadDir });
    const bytes = crypto.randomBytes(64 * 1024), source = path.join(home, 'native-test.gguf'); await fs.writeFile(source, bytes);
    seed = new TorrentEngine({ dht: false, tracker: false, lsd: false });
    const torrent = await seed.seed(source);
    await request({ action: 'torrent:add', source: torrent.magnetURI + `&x.pe=127.0.0.1:${seed.port}`, destination: first.status.downloadDir });
    let completed;
    for (let attempt = 0; attempt < 80; attempt++) {
      completed = await request({ action: 'status' });
      if (completed.downloads.some(job => job.status === 'done') && completed.torrents.some(job => job.infoHash === torrent.infoHash && job.done)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(completed.downloads[0].status, 'done'); assert.equal(completed.torrents.find(job => job.infoHash === torrent.infoHash)?.done, true);
    assert.deepEqual(await fs.readFile(path.join(downloadDir, 'native-test.gguf')), bytes);
    await fs.writeFile(path.join(downloadDir, 'keep-config.json'), '{"keep":true}');
    const before = JSON.parse(await fs.readFile(path.join(root, 'state/agent.json')));
    const updated = await installSparkCompanion(options);
    assert.equal(updated.status.hardware.modelIdentifier, first.status.hardware.modelIdentifier);
    assert.equal(updated.status.downloads[0].status, 'done');
    assert.ok(updated.status.inventory.some(item => item.repoId === model.id));
    assert.equal(await fs.readFile(path.join(downloadDir, 'keep-config.json'), 'utf8'), '{"keep":true}');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'state/agent.json'))).downloads, before.downloads);
    console.log(JSON.stringify({ installed: updated.status.version, hardware: updated.status.hardware.name, runtime: updated.status.capabilities.runtime }));
  } finally {
    try {
      const service = `${domain}/${label}`;
      const running = await exec('/bin/launchctl', ['print', service]).catch(() => null);
      const pid = Number(running?.stdout.match(/\bpid = ([0-9]+)/)?.[1]);
      if (running) await exec('/bin/launchctl', ['bootout', service]);
      // launchctl returns before the companion finishes saving its jobs. Never
      // remove its isolated home while that process can still write into it.
      let stopped = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        let alive = false;
        if (pid) { try { process.kill(pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') throw error; } }
        const registered = await exec('/bin/launchctl', ['print', service]).then(() => true, () => false);
        if (!alive && !registered) { stopped = true; break; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.ok(stopped, 'Owned test companion must stop before its files are removed');
      await fs.rm(home, { recursive: true, force: true });
    } finally { await seed?.destroy(); }
  }
});
