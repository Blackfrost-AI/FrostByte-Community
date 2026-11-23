import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

// Generates a credential artifact, never writes it to source or terminal output.
// Re-running with the same directory reuses the token, not an implicit rotation.
const root = process.argv[2];
if (!root || !path.isAbsolute(root) || fs.realpathSync(root) !== root) throw new Error('Pass an existing, canonical private delivery directory.');
const directory = path.join(root, 'credentials');
try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
const stat = fs.lstatSync(directory);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Credential directory must be private (0700).');
const target = path.join(directory, 'frostnet-owner-token.txt');
if (!fs.existsSync(target)) fs.writeFileSync(target, 'fn_' + randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
const file = fs.lstatSync(target);
if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o077)) throw new Error('Credential file must be private (0600).');
const token = fs.readFileSync(target, 'utf8').trim();
if (!/^fn_[a-f0-9]{64}$/.test(token)) throw new Error('Unexpected token artifact; no changes made.');
console.log(JSON.stringify({ credentialFile: target, sha256: createHash('sha256').update(token).digest('hex') }));
