/** Preserve installed dependency notices without relabeling their copyright. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
const noticeRoot = path.join(root, 'licenses');
const rows = [];
// These packages are compiled into the shipped Studio renderer. They remain
// devDependencies so electron-builder and the Spark companion do not carry
// their source trees, but their upstream notices still belong in the app.
const bundledRendererPackages = new Set([
  'node_modules/@xterm/addon-fit',
  'node_modules/@xterm/xterm',
  'node_modules/monaco-editor',
  'node_modules/react',
  'node_modules/react-dom',
  'node_modules/scheduler',
  'node_modules/zustand',
]);
const licensePattern = /^(licen[sc]e|copying|notice|copyright)([._-]|$)/i;
function notices(directory, relative = '', depth = 0) {
  if (depth > 5) return [];
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isFile() && licensePattern.test(entry.name)) return [child];
    if (entry.isDirectory() && !['node_modules', '.git', 'build', 'prebuilds', 'test', 'tests'].includes(entry.name)) return notices(directory, child, depth + 1);
    return [];
  });
}
fs.rmSync(path.join(noticeRoot, 'npm'), { recursive: true, force: true });
for (const [location, record] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!location || record.dev && !bundledRendererPackages.has(location)) continue;
  const directory = path.join(root, location);
  if (!fs.existsSync(directory)) {
    if (record.optional) continue;
    throw new Error(`Install the locked dependency before packaging: ${location}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  const name = `${pkg.name}@${pkg.version}`;
  const output = path.join(noticeRoot, 'npm', name.replaceAll('/', '__'));
  const files = notices(directory);
  const readme = fs.readdirSync(directory).find(file => /^readme(?:\.|$)/i.test(file));
  const label = pkg.license || pkg.licenses?.map(item => item.type).join(' OR ') || record.license || 'See included upstream license';
  const metadata = { name: pkg.name, version: pkg.version, license: label, author: pkg.author, contributors: pkg.contributors, repository: pkg.repository, homepage: pkg.homepage };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'upstream-package.json'), JSON.stringify(metadata, null, 2) + '\n');
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true });
    fs.copyFileSync(path.join(directory, file), path.join(output, file));
  }
  // Some published packages express their license only in package metadata or README.
  // Keep those original statements intact; do not invent a copyright holder or year.
  if (!files.length && readme) fs.copyFileSync(path.join(directory, readme), path.join(output, readme));
  rows.push({ name, license: label, notices: path.relative(root, output).split(path.sep).join('/'), originalNoticeFiles: files.length });
}
const electronDir = path.join(noticeRoot, 'electron');
fs.mkdirSync(electronDir, { recursive: true });
for (const file of ['LICENSE', 'LICENSES.chromium.html']) fs.copyFileSync(path.join(root, 'node_modules/electron/dist', file), path.join(electronDir, file));
fs.writeFileSync(path.join(noticeRoot, 'npm-inventory.json'), JSON.stringify(rows, null, 2) + '\n');
const intro = `# FrostByte third-party notices\n\nThe FrostByte license applies to original FrostByte materials only. The\ncomponents below retain their own licenses and all rights granted by them.\nTheir copyright notices, license texts, and published attribution metadata are\npreserved in the linked directories. Optional dependencies are listed when\npresent in this packaging environment. No third-party source files have been\nmodified by FrostByte.\n\n## Electron and Chromium\n\nElectron ${JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'))).version} is distributed with its [license](licenses/electron/LICENSE) and\n[Chromium third-party notices](licenses/electron/LICENSES.chromium.html).\nThese remain separate from the original FrostByte license. Electron source is\navailable at https://github.com/electron/electron and its Chromium dependency\nversions are identified by that release.\n\n## Native networking components and source\n\nThe unchanged node-datachannel 0.32.3 component and its MPL-covered source remain\navailable under MPL-2.0, including the libdatachannel and libjuice components.\nRecipients may obtain the corresponding source from the fixed upstream versions\nlisted in [native component notices](licenses/native/README.md). MPL rights to\nthat source, including modification and redistribution, are not restricted by\nthe FrostByte license. Retained upstream license texts are included there.\n\n## Published package notice variations\n\nA few upstream npm packages provide an SPDX identifier or a README license\nstatement rather than a standalone license file. Their original package\nattribution and README are retained. In particular, compact2string 1.4.1 declares\n\"BSD\" in package metadata and \"MIT Licence\" in its README; both upstream\nstatements are preserved without silently replacing either one.\n\n## Runtime dependency inventory\n\n| Component | Upstream license declaration | Preserved notices |\n| --- | --- | --- |\n`;
const ipfsNotice = '\n## IPFS runtime\n\nKubo 0.43.0 is bundled from its official release with its upstream MIT/Apache notices.\nIts [license notice](licenses/ipfs/LICENSE), [MIT license](licenses/ipfs/LICENSE-MIT),\nand [Apache license](licenses/ipfs/LICENSE-APACHE) are preserved. Source: https://github.com/ipfs/kubo/tree/v0.43.0.\nThe upstream license notice describes the scope of the license transition.\nFrostByte pins each runtime archive checksum in build/ipfs-runtime.json.\nIts embedded Go module inventory and original dependency notices are included in\n[the IPFS notices directory](licenses/ipfs/README.md). The Go runtime license is preserved there too.\n\n';
const photography = '\n## Device product photography\n\nBundled desktop stock product images retain the copyrights of Apple, ASUSTeK Computer,\nDell, and NVIDIA/PNY. Source pages, original asset URLs and hashes are recorded\nin `assets/devices/sources.json`, with display scope in `assets/devices/README.md`.\nThey are used for hardware identification and do not imply endorsement. These\nphotographs are separate from FrostByte’s original SVG placeholders and brand art.\n';
const keysFont = '\n## u1tra_instinct font\n\nDeparture Mono 1.500 by Helena Zhang is bundled unchanged under the SIL Open Font License 1.1.\nThe complete copyright and license notice is preserved in [Departure Mono](licenses/fonts/departure-mono/OFL.txt).\nSource and checksum records are in `assets/fonts/sources.json`.\n';
const jensenNotice = '\n## Founders Leather (Jensen tribute) font and photography\n\nSpace Grotesk 2.0.0 by Florian Karsten is bundled unchanged under the SIL Open Font License 1.1.\nThe complete copyright and license notice is preserved in [Space Grotesk](licenses/fonts/space-grotesk/OFL.txt),\nwith source and checksum records in `assets/fonts/sources.json`.\n\nCommemorative photographs and signature of Jensen Huang in `assets/brand/jensen/` are bundled unchanged\n(checksums recorded in `assets/brand/jensen/sources.json`):\n\n- **Jensen Huang at SC18 holding NVIDIA GPU accelerator** (`jensen-stage-gpu.jpg`) — Photograph by Raysonho @ Open Grid Scheduler / Grid Engine, dedicated to the Public Domain under CC0 1.0 Universal (`https://creativecommons.org/publicdomain/zero/1.0/deed.en`), unmodified. Source: `https://commons.wikimedia.org/wiki/File:JensenHuangSC18.jpg`.\n- **Jensen Huang speaking in black leather jacket (2023)** (`jensen-leather-jacket.jpg`) — Photograph by Office of the President, Republic of China (Taiwan), licensed under CC BY 2.0 (`https://creativecommons.org/licenses/by/2.0/`), unmodified. Source: `https://commons.wikimedia.org/wiki/File:Jensen_Huang_20231109_(cropped2).jpg`.\n- **Jensen Huang portrait in black leather jacket (2024)** (`jensen-portrait-2024.jpg`) — Photograph by Peter Dasilva / European Union, 2024, licensed under CC BY 4.0 (`https://creativecommons.org/licenses/by/4.0/`), unmodified. Source: `https://commons.wikimedia.org/wiki/File:Jensen_Huang_(cropped)_(2024).jpg`.\n- **Jensen Huang vector signature** (`jensen-signature.svg`) — Author: Jen-Hsun Huang (vectorized on Wikimedia Commons), Public Domain (ineligible for copyright; simple signature). Source: `https://commons.wikimedia.org/wiki/File:Jensen_Huang_signature.svg`.\n- **NVIDIA logo (eye + wordmark)** (`nvidia-logo.svg`) — NVIDIA Corporation, vectorized by Althair on Wikimedia Commons. Public domain (below the threshold of originality; simple geometric shapes and text), bundled unchanged and rendered with a CSS brightness filter for the dark theme. Source: `https://commons.wikimedia.org/wiki/File:NVIDIA_logo.svg`. The NVIDIA name, eye device and logo are trademarks of NVIDIA Corporation; they are shown for identification and homage only, no rights are claimed, and no affiliation or endorsement is implied.\n\nFrostByte is an independent open-source project and is not affiliated with or endorsed by NVIDIA Corporation. The Founders Leather theme is a community creation; FrostByte and its contributors do not own the NVIDIA name, logo, or trademarks.\n';
const fonts = '\n## Blackfrost and AEON Orbit fonts\n\nManrope, Orbitron and Share Tech Mono retain their SIL Open Font License 1.1 terms.\nThe complete upstream copyright and license notices ship with the desktop app:\n[Manrope](licenses/fonts/manrope/OFL.txt),\n[Orbitron](licenses/fonts/orbitron/OFL.txt) and\n[Share Tech Mono](licenses/fonts/sharetechmono/OFL.txt).\nThe original font files are unchanged; source and checksum records are in `assets/fonts/sources.json`.\n';
const llamaNotice = '\n## llama.cpp assistant runtime\n\nllama.cpp (release b12584) is bundled from its official macOS arm64 release under the MIT license.\nIts [upstream license](licenses/llama/LICENSE) is preserved unchanged. Source: https://github.com/ggml-org/llama.cpp/tree/b12584.\nFrostByte pins the release archive checksum and every extracted file hash in build/llama-runtime.json;\nthe runtime is only started by FrostByte on a loopback port with a per-session credential, and it\nloads only models the user has saved in their library. The bundled binaries are unmodified upstream builds.\n\n';
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), intro + rows.map(row => `| ${row.name} | ${String(row.license).replaceAll('|', '\\|')} | [Files](${row.notices}) |`).join('\n') + '\n' + ipfsNotice + llamaNotice + photography + fonts + keysFont + jensenNotice);
function allFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? allFiles(file) : entry.isFile() ? [file] : [];
  });
}
const noticePath = file => path.relative(noticeRoot, file).split(path.sep).join('/');
const combined = [path.join(noticeRoot, 'ipfs'), path.join(noticeRoot, 'native'), path.join(noticeRoot, 'npm')].flatMap(allFiles)
  .sort((a, b) => noticePath(a) < noticePath(b) ? -1 : noticePath(a) > noticePath(b) ? 1 : 0);
fs.writeFileSync(path.join(root, 'LICENSES.third-party.txt'), 'FrostByte Spark companion third-party notices\n\nOriginal FrostByte terms do not replace the component licenses below.\nSource locations for MPL components are included in native/README.md below.\n\n' + combined.map(file => `\n===== ${noticePath(file)} =====\n\n${fs.readFileSync(file, 'utf8')}\n`).join(''));
console.log(`Preserved ${rows.length} runtime dependency notice sets and Electron/Chromium notices.`);
