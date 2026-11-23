const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { personalizeMacBundle } = require('./macos-identity.cjs');
const { writeLinuxAppRun } = require('./linux-apprun.cjs');

// Kept as data so release tests can audit the entire policy without modifying a
// binary. The build hook maps these names through the pinned @electron/fuses API.
const FUSE_POLICY = Object.freeze({
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  // Electron's stock archives ship the shared snapshot, not the optional
  // browser-specific snapshot this fuse would require at startup.
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
  WasmTrapHandlers: true,
});

async function hardenElectron(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const platform = context.electronPlatformName;
  const product = context.packager.appInfo.productFilename;
  const suffix = platform === 'darwin' ? '.app' : platform === 'win32' ? '.exe' : '';
  const executable = path.join(context.appOutDir, platform === 'linux' ? context.packager.executableName : product + suffix);
  const config = { version: FuseVersion.V1, strictlyRequireAllFuses: true };

  for (const [name, value] of Object.entries(FUSE_POLICY)) {
    const index = FuseV1Options[name];
    if (!Number.isInteger(index)) throw new Error(`Pinned @electron/fuses does not recognize ${name}.`);
    config[index] = value;
  }
  await flipFuses(executable, config);
  if (platform === 'linux') await writeLinuxAppRun(context.appOutDir, context.packager.executableName);
  if (platform === 'darwin') {
    personalizeMacBundle(executable, context.packager.appInfo.id, context.packager.appInfo.version);
    // Sign the nested helper before sealing its receipt and the outer app.
    // Builder's signIgnore below prevents a second signature from changing
    // the bytes after the runtime checksum has been recorded.
    const directory = path.join(executable, 'Contents/Resources/ipfs-runtime');
    const helper = path.join(directory, 'ipfs');
    const options = context.packager.platformSpecificBuildOptions;
    const identity = options.identity || process.env.CSC_NAME;
    if (!identity) throw new Error('An explicit Mac signing identity is required for the IPFS helper.');
    await promisify(execFile)('/usr/bin/codesign', ['--force', '--sign', identity, ...(identity === '-' ? ['--timestamp=none'] : ['--timestamp', '--options', 'runtime']), helper]);
    const receipt = JSON.parse(await fs.readFile(path.join(directory, 'runtime.json')));
    receipt.binarySha256 = createHash('sha256').update(await fs.readFile(helper)).digest('hex');
    await fs.writeFile(path.join(directory, 'runtime.json'), JSON.stringify(receipt, null, 2) + '\n');
    // Same contract for the managed llama.cpp fallback: sign every Mach-O
    // member (server + dylibs), then pin the final bytes in the receipt. The
    // runtime verifier accepts these post-sign hashes and nothing else.
    const llamaDir = path.join(executable, 'Contents/Resources/llama-runtime');
    const llamaManifest = JSON.parse(await fs.readFile(path.join(executable, 'Contents/Resources/llama-runtime.json')));
    const llamaPlatform = `darwin-${context.arch === 1 ? 'x64' : 'arm64'}`;
    const llamaEntry = llamaManifest.platforms[llamaPlatform];
    if (!llamaEntry) throw new Error(`The llama.cpp manifest is missing the ${llamaPlatform} platform.`);
    const llamaReceipt = JSON.parse(await fs.readFile(path.join(llamaDir, 'runtime.json')));
    if (llamaReceipt.archiveSha256 !== llamaEntry.archiveSha256 || llamaReceipt.tag !== llamaManifest.tag) throw new Error('Staged llama.cpp runtime does not match the reviewed manifest.');
    const finalHashes = {};
    for (const name of Object.keys(llamaEntry.files)) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid llama.cpp member name.');
      const file = path.join(llamaDir, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile()) throw new Error(`llama.cpp member is not a regular file: ${name}`);
      const bytes = await fs.readFile(file);
      if (createHash('sha256').update(bytes).digest('hex') !== llamaEntry.files[name]) throw new Error(`Staged llama.cpp member drifted: ${name}`);
      const magic = bytes.length >= 4 ? bytes.readUInt32BE(0) : 0;
      const macho = magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe || magic === 0xcafebabe || magic === 0xbebafeca;
      if (macho) {
        await promisify(execFile)('/usr/bin/codesign', ['--force', '--sign', identity, ...(identity === '-' ? ['--timestamp=none'] : ['--timestamp', '--options', 'runtime']), file]);
        // Only re-signed executables get an override; everything else stays
        // pinned to the reviewed archive hash at verification time.
        finalHashes[name] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
      }
    }
    llamaReceipt.finalFileSha256 = finalHashes;
    await fs.writeFile(path.join(llamaDir, 'runtime.json'), JSON.stringify(llamaReceipt, null, 2) + '\n');
  }
}

module.exports = hardenElectron;
module.exports.FUSE_POLICY = FUSE_POLICY;
