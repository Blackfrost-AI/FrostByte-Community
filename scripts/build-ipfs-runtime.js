/** Stage a reviewed Kubo binary. Never executes an unverified download. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'build/ipfs-runtime.json')));
const target = process.argv[2] || `${process.platform}-${process.arch}`;
const entry = manifest.targets[target];
if (!entry) throw new Error('Unsupported IPFS runtime target.');
const out = path.join(root, 'build/ipfs-runtime', target);
const name = target.startsWith('win32-') ? 'ipfs.exe' : 'ipfs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let ready = false;
try {
  const saved = JSON.parse(await fs.readFile(path.join(out, 'runtime.json')));
  ready = saved.archiveSha256 === entry.sha256 && saved.binarySha256 === digest(await fs.readFile(path.join(out, name)));
} catch { /* first build */ }
if (ready) { process.stdout.write(`Kubo ${manifest.version} for ${target} already verified.\n`); }
else {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'frostbyte-kubo-build-'));
  try {
    const url = `https://github.com/ipfs/kubo/releases/download/v${manifest.version}/${entry.archive}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Kubo download failed: HTTP ${response.status}`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 100 * 1024 * 1024) throw new Error('Kubo archive exceeds the reviewed size limit.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (digest(bytes) !== entry.sha256) throw new Error('Kubo archive checksum mismatch.');
    const archive = path.join(temp, entry.archive);
    await fs.writeFile(archive, bytes, { flag: 'wx' });
    // The archive is checksum-pinned before any extraction. Only its binary is
    // selected; upstream install scripts are never run.
    const extract = path.join(temp, 'extract'); await fs.mkdir(extract);
    if (entry.archive.endsWith('.zip') && process.platform !== 'win32') {
      await run('unzip', ['-q', archive, `kubo/${name}`, '-d', extract]);
    } else await run('tar', ['-xf', archive, '-C', extract, `kubo/${name}`]);
    const binary = await fs.readFile(path.join(extract, 'kubo', name));
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, name), binary, { mode: 0o755 });
    await fs.writeFile(path.join(out, 'runtime.json'), JSON.stringify({ version: manifest.version, archiveSha256: entry.sha256, binarySha256: digest(binary) }, null, 2) + '\n');
    process.stdout.write(`Verified Kubo ${manifest.version} staged for ${target}.\n`);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
