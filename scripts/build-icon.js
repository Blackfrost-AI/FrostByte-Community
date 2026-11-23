import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { convertIcon } from 'app-builder-lib/out/util/iconConverter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'assets/brand/app-icon-master.png');
const iconset = path.join(root, 'build/icon.iconset');

// iconutil in current macOS releases can reject a complete legacy iconset.
// Modern ICNS representations are PNG payloads with an eight-byte container
// header, so write the documented representation types deterministically.
function writeIcns(directory, output) {
  const representations = [
    ['icp4', 'icon_16x16.png'], ['ic11', 'icon_16x16@2x.png'],
    ['icp5', 'icon_32x32.png'], ['ic12', 'icon_32x32@2x.png'],
    ['ic07', 'icon_128x128.png'], ['ic13', 'icon_128x128@2x.png'],
    ['ic08', 'icon_256x256.png'], ['ic14', 'icon_256x256@2x.png'],
    ['ic09', 'icon_512x512.png'], ['ic10', 'icon_512x512@2x.png'],
  ];
  const chunks = representations.map(([type, file]) => {
    const png = fs.readFileSync(path.join(directory, file));
    if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error(`Invalid icon PNG: ${file}`);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(header.length + png.length, 4);
    return Buffer.concat([header, png]);
  });
  const size = 8 + chunks.reduce((total, chunk) => total + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(size, 4);
  fs.writeFileSync(output, Buffer.concat([header, ...chunks], size));
}

if (process.platform === 'darwin') {
  fs.mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      execFileSync('sips', ['-z', String(size * scale), String(size * scale), source,
        '--out', path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
    }
  }
  writeIcns(iconset, path.join(root, 'build/icon.icns'));
  execFileSync('sips', ['-z', '1024', '1024', source, '--out', path.join(root, 'assets/brand/app-icon.png')], { stdio: 'ignore' });
}
// Use the locked builder's platform-native converter, retaining the same artwork.
// Non-Mac builders use the committed ICNS/PNG assets and regenerate only the ICO.
const { icons } = await convertIcon({ sources: [source], fallbackSources: [], roots: [root], format: 'ico', outDir: path.join(root, 'build') });
if (!icons.some(icon => icon.size >= 256) || !fs.existsSync(path.join(root, 'build/icon.ico'))) throw new Error('Windows icon conversion did not produce a 256px ICO.');
console.log(`Built build/icon.ico${process.platform === 'darwin' ? ', build/icon.icns, and assets/brand/app-icon.png' : ''} from the original artwork.`);
