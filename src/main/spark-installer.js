/** Installer contract: schemaVersion 1 manifest + source.tar.gz + onboard.py, built from package.json's version.
 * execute runs this fixed command on an already authenticated host. Arguments, folder names and archive
 * bytes travel only as JSON stdin. During activation/finalization execute must not supply a default abort signal.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const SPARK_INSTALL_COMMAND = `python3 -c 'import base64,json,sys; payload=json.load(sys.stdin); exec(compile(base64.b64decode(payload["installer"]), "frostbyte-onboard.py", "exec"))'`;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const abortError = () => new DOMException('Device setup cancelled. Your previous companion is unchanged.', 'AbortError');
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

export function validateSparkDownloadDir(downloadDir, runtime = 'docker') {
  if (typeof downloadDir !== 'string' || downloadDir.length > 4096 || !path.posix.isAbsolute(downloadDir)
    || path.posix.normalize(downloadDir) !== downloadDir || /[\x00-\x1f\x7f]/.test(downloadDir)) {
    throw new Error('Choose an absolute download folder on the device.');
  }
  if (runtime === 'docker') {
    if (downloadDir === '/') throw new Error('Choose a download folder outside the companion runtime folders.');
    for (const reserved of ['/app', '/state', '/tmp']) {
      if (downloadDir === reserved || downloadDir.startsWith(reserved + '/') || reserved.startsWith(downloadDir + '/')) {
        throw new Error('Choose a download folder outside the companion runtime folders.');
      }
    }
  }
  return downloadDir;
}

export async function installSparkCompanion({ execute, bundleDir, downloadDir, sessionId = crypto.randomUUID(), signal, onProgress = () => {}, addStorage = false, runtime = 'docker', adoptLegacyContainerId }) {
  if (typeof execute !== 'function') throw new Error('An authenticated device connection is required.');
  if (!/^[-a-zA-Z0-9_]{8,64}$/.test(sessionId)) throw new Error('Invalid device installation session.');
  validateSparkDownloadDir(downloadDir, runtime);
  // Maintenance-only adoption after inspecting/backing up one legacy container.
  // No renderer/setup request can supply this option; ordinary updates stay closed.
  if (adoptLegacyContainerId !== undefined && !/^[a-f0-9]{64}$/.test(adoptLegacyContainerId)) throw new Error('Review the exact legacy container ID before migration.');
  checkAbort(signal);
  const manifest = JSON.parse(await fs.readFile(path.join(bundleDir, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.archive !== 'source.tar.gz' || manifest.installer !== 'onboard.py' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error('The bundled device companion is invalid. Reinstall FrostByte.');
  if (!['docker', 'mac-native'].includes(runtime)) throw new Error('Unsupported companion runtime.');
  const mac = runtime === 'mac-native';
  if (mac && manifest.macInstaller !== 'mac-onboard.py') throw new Error('Reinstall FrostByte to restore its Mac companion.');
  const [archive, installer] = await Promise.all([fs.readFile(path.join(bundleDir, manifest.archive)), fs.readFile(path.join(bundleDir, mac ? manifest.macInstaller : manifest.installer))]);
  if (archive.length !== manifest.bytes || archive.length > 8 * 1024 ** 2 || digest(archive) !== manifest.sha256 || digest(installer) !== (mac ? manifest.macInstallerSha256 : manifest.installerSha256)) throw new Error('The bundled companion failed its integrity check. Reinstall FrostByte.');
  const common = { manifest, sessionId, downloadDir, addStorage: addStorage === true, installer: installer.toString('base64'),
    ...(adoptLegacyContainerId ? { adoptLegacyContainerId } : {}) };
  let staged = false, activated = false;
  async function run(action, options = {}) {
    const result = await execute(SPARK_INSTALL_COMMAND, { input: JSON.stringify({ ...common, action, ...options.payload }) + '\n', ...(options.cancellable ? { signal } : {}) });
    const lines = String(result.stdout || '').trim().split('\n');
    let response;
    try { response = JSON.parse(lines.at(-1)); } catch {}
    if (result.code !== 0 || !response?.ok) throw new Error(response?.error || String(result.stderr || '').trim().slice(-1000) || `Device setup failed during ${action}.`);
    return response.data;
  }
  try {
    onProgress({ stage: 'preparing', message: mac ? 'Checking this Mac and your download folder…' : 'Checking Docker and your download folder…' });
    // Set staged before the request so interrupted uploads still get a cleanup attempt.
    staged = true;
    await run('prepare', { cancellable: true, payload: { archive: archive.toString('base64') } });
    checkAbort(signal);
    onProgress({ stage: 'building', message: mac ? 'Preparing the Mac companion and its private Node runtime. First setup can take several minutes…' : 'Building the device companion. First setup can take several minutes…' });
    await run('build', { cancellable: true });
    checkAbort(signal);
    onProgress({ stage: 'activating', message: 'Starting and checking the companion. Existing downloads are preserved…' });
    // Do not abort the remote process while it owns the service swap: it must finish or restore the old service.
    const result = await run('activate');
    activated = true;
    checkAbort(signal);
    await run('finalize');
    activated = false;
    staged = false;
    onProgress({ stage: 'ready', message: 'Device is connected and ready to download.' });
    return { status: result.status };
  } catch (error) {
    if (activated) {
      onProgress({ stage: 'restoring', message: 'Restoring the previous companion…' });
      try { await run('rollback'); activated = false; }
      catch (restoreError) { throw new Error(`${error.message} The previous service could not be restored automatically: ${restoreError.message}`); }
    }
    throw signal?.aborted ? abortError() : error;
  } finally {
    if (staged && !activated) {
      try { await run('cleanup'); } catch { /* A disconnected Spark can remove its staging folder on the next setup. */ }
    }
  }
}

/** Add a mounted storage folder while retaining the existing primary folder, mounts and transfers. */
export function configureSparkStorage(options) {
  return installSparkCompanion({ ...options, addStorage: true });
}
