import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.copyFileSync(path.join(root, 'src/shared/release-manifest.js'), path.join(root, 'frostnet/functions/release-manifest.js'));
console.log('Frostnet shared release schema synchronized. Existing blackfrostai.com hosting configuration is unchanged.');
