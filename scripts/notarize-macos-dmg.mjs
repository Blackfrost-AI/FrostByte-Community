// electron-builder notarizes/staples the app before ZIP/DMG creation. Submit the
// final DMG separately so its ticket can be checked offline by Gatekeeper too.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expectedInstallerName } from './release-artifacts.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const config = require('../build/signing-macos.cjs')();
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
const output = path.join(root, config.directories.output);
const installer = path.join(output, expectedInstallerName('darwin', version));
const run = promisify(execFile);
await run('codesign', ['--verify', '--strict', installer]);
const credentials = ['--keychain-profile', process.env.APPLE_KEYCHAIN_PROFILE];
if (process.env.APPLE_KEYCHAIN) credentials.push('--keychain', process.env.APPLE_KEYCHAIN);
console.log('Submitting the signed DMG to Apple for notarization…');
const result = await run('xcrun', ['notarytool', 'submit', installer, ...credentials, '--wait', '--output-format', 'json'], {
  timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024,
});
const receipt = JSON.parse(result.stdout);
await fs.writeFile(path.join(output, 'notarization-dmg.json'), JSON.stringify(receipt, null, 2) + '\n');
if (receipt.status !== 'Accepted') throw new Error(`Apple DMG notarization status: ${receipt.status}; submission ${receipt.id}`);
for (const action of ['staple', 'validate']) {
  const checked = await run('xcrun', ['stapler', action, installer]);
  console.log(checked.stdout.trim());
}
console.log(`DMG notarization accepted: ${receipt.id}`);
