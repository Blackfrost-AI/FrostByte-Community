/** Stage only the reviewed companion payload and image contract. Not a disk image. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'build/spark-companion');
const output = path.join(root, 'build/aeon-image-kit');
const hash = value => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(await fs.readFile(path.join(from, 'manifest.json')));
const archive = await fs.readFile(path.join(from, 'source.tar.gz'));
const installer = await fs.readFile(path.join(from, 'onboard.py'));
if (archive.length !== manifest.bytes || hash(archive) !== manifest.sha256 || hash(installer) !== manifest.installerSha256) throw new Error('Rebuild the companion payload before staging the AEON image kit.');
await fs.mkdir(output, { recursive: true });
for (const name of ['manifest.json', 'source.tar.gz', 'onboard.py']) await fs.copyFile(path.join(from, name), path.join(output, name));
await fs.copyFile(path.join(root, 'docs/AEON-IMAGE.md'), path.join(output, 'README.md'));
await fs.writeFile(path.join(output, 'frostbyte-integration.example.json'), JSON.stringify({ schema: 1, image: 'aeon-magick-orb', version: '{{REVIEWED_AEON_IMAGE_VERSION}}', port: 443, tools: ['models', 'devices', 'view'] }, null, 2) + '\n');
await fs.writeFile(path.join(output, 'kit.json'), JSON.stringify({ schema: 1, kind: 'image-integration-kit', frostbyteVersion: manifest.version, companionSha256: manifest.sha256, flashable: false, baseImage: null, physicalPiVerified: false }, null, 2) + '\n');
console.log(`AEON image integration kit staged at ${output}. A reviewed base image and physical Pi validation are still required.`);
