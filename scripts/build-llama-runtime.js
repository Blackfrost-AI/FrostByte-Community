/** Stage the pinned llama.cpp release. Never executes an unverified download.
 *  Only the reviewed top-level files are extracted; symlinks are pinned by
 *  target and everything is hash-verified before any receipt is written. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'build/llama-runtime.json')));
const target = process.argv[2] || `${process.platform}-${process.arch}`;
const entry = manifest.platforms[target];
if (!entry) throw new Error('Unsupported llama.cpp runtime target.');
const out = path.join(root, 'build/llama-runtime', target);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const names = Object.keys(entry.files);
if (names.length > 512 || names.some(name => !/^[A-Za-z0-9._-]+$/.test(name))) throw new Error('Invalid llama.cpp file inventory.');
let ready = false;
try {
  const saved = JSON.parse(await fs.readFile(path.join(out, 'runtime.json')));
  ready = saved.archiveSha256 === entry.archiveSha256 && saved.tag === manifest.tag;
  if (ready) {
    // Mirror the runtime verifier: exact inventory, pinned symlinks, hashes.
    const links = entry.links || {};
    const present = (await fs.readdir(out)).sort();
    const expected = [...names, ...Object.keys(links), 'runtime.json'].sort();
    if (present.length !== expected.length || present.some((name, index) => name !== expected[index])) ready = false;
  }
  if (ready) {
    for (const name of names) {
      const stat = await fs.lstat(path.join(out, name));
      if (!stat.isFile() || digest(await fs.readFile(path.join(out, name))) !== entry.files[name]) { ready = false; break; }
    }
  }
  if (ready) {
    for (const [name, targetName] of Object.entries(entry.links || {})) {
      const stat = await fs.lstat(path.join(out, name));
      if (!stat.isSymbolicLink() || await fs.readlink(path.join(out, name)) !== targetName) { ready = false; break; }
    }
  }
} catch { /* first build */ }
if (ready) { process.stdout.write(`llama.cpp ${manifest.tag} for ${target} already verified.\n`); }
else {
  // Reuse a checksum-verified cached archive when present; otherwise download it.
  let bytes = null;
  const cached = path.join(root, 'build/cache', entry.archive);
  try { const candidate = await fs.readFile(cached); if (digest(candidate) === entry.archiveSha256) bytes = candidate; } catch { /* no cache */ }
  if (!bytes) {
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok) throw new Error(`llama.cpp download failed: HTTP ${response.status}`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 512 * 1024 * 1024) throw new Error('llama.cpp archive exceeds the reviewed size limit.');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
    if (digest(bytes) !== entry.archiveSha256) throw new Error('llama.cpp archive checksum mismatch.');
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'frostbyte-llama-build-'));
  try {
    const archive = path.join(temp, entry.archive);
    await fs.writeFile(archive, bytes, { flag: 'wx' });
    // Inspect the archive before extracting: only flat, reviewed member names.
    const { stdout: listing } = await run('tar', ['-tzf', archive]);
    const prefix = `llama-${manifest.tag}/`;
    const members = listing.split('\n').filter(Boolean);
    if (members.length > 512) throw new Error('llama.cpp archive has too many members.');
    for (const member of members) {
      if (member === manifest.tag || member === prefix) continue; // top-level directory entry
      if (!member.startsWith(prefix)) throw new Error(`Unexpected archive member: ${member}`);
      const name = member.slice(prefix.length);
      if (name === '') continue;
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Unsafe archive member: ${member}`);
    }
    const extract = path.join(temp, 'extract');
    await fs.mkdir(extract);
    await run('tar', ['-xzf', archive, '-C', extract]);
    const source = path.join(extract, `llama-${manifest.tag}`);
    await fs.mkdir(out, { recursive: true });
    // Regular files: exact byte copies with reviewed hashes.
    for (const name of names) {
      const stat = await fs.lstat(path.join(source, name));
      if (!stat.isFile()) throw new Error(`Reviewed file is not a regular file: ${name}`);
      const file = await fs.readFile(path.join(source, name));
      if (digest(file) !== entry.files[name]) throw new Error(`llama.cpp file checksum mismatch: ${name}`);
      await fs.writeFile(path.join(out, name), file, { mode: name === entry.server || !name.includes('.') ? 0o755 : 0o644 });
    }
    // Symlinks: only within-directory alias chains to reviewed regular files.
    const links = entry.links || {};
    for (const [name, targetName] of Object.entries(links)) {
      if (!/^[A-Za-z0-9._-]+$/.test(name) || !/^[A-Za-z0-9._-]+$/.test(targetName)) throw new Error('Invalid symlink entry.');
      const stat = await fs.lstat(path.join(source, name));
      if (!stat.isSymbolicLink() || await fs.readlink(path.join(source, name)) !== targetName) throw new Error(`Symlink mismatch: ${name}`);
      await fs.rm(path.join(out, name), { force: true });
      await fs.symlink(targetName, path.join(out, name));
    }
    await fs.writeFile(path.join(out, 'runtime.json'), JSON.stringify({ schemaVersion: 1, tag: manifest.tag, archiveSha256: entry.archiveSha256 }, null, 2) + '\n');
    process.stdout.write(`Verified llama.cpp ${manifest.tag} staged for ${target}.\n`);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
