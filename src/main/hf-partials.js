import fs from 'node:fs';
import path from 'node:path';
import { normalizeHfTransferRecord } from './hf.js';

const snapshot = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function parents(root, target) {
  if (fs.realpathSync(root) !== root) throw new Error('The partial download root is linked.');
  let current = root;
  const components = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean);
  for (const component of ['', ...components]) {
    current = component ? path.join(current, component) : current;
    let stat; try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('A partial download parent changed. Files were preserved.');
  }
}
function file(target) {
  let stat; try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('A partial download is linked or not a regular file.');
  return snapshot(stat);
}
export function planHfPartials(records) {
  return records.filter(row => row.status !== 'done').map(raw => {
    const row = normalizeHfTransferRecord(raw);
    if (['active', 'queued'].includes(row.status)) throw new Error('Pause this download before cleaning its partial files.');
    const part = row.dest + '.frostpart', sidecar = row.dest + '.frostpart.json';
    parents(row.baseDir, part);
    const partIdentity = file(part), sidecarIdentity = file(sidecar);
    if (partIdentity && !sidecarIdentity) throw new Error('A partial has no ownership sidecar. It was preserved for manual recovery.');
    if (sidecarIdentity) {
      if (sidecarIdentity[2] > 65536) throw new Error('The resume sidecar is invalid.');
      const data = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      if (data.repoId !== row.repoId || data.revision !== row.revision || data.filePath !== row.filePath || !equal(file(sidecar), sidecarIdentity)) throw new Error('A partial belongs to another download. It was preserved.');
    }
    return { root: row.baseDir, part, sidecar, partIdentity, sidecarIdentity };
  });
}
export function deleteHfPartials(plans) {
  const validate = row => {
    parents(row.root, row.part);
    if (!equal(file(row.part), row.partIdentity) || !equal(file(row.sidecar), row.sidecarIdentity)) throw new Error('Partial files changed during review. Review cleanup again.');
  };
  for (const row of plans) validate(row);
  for (const row of plans) {
    validate(row);
    if (row.partIdentity) fs.unlinkSync(row.part);
    if (row.sidecarIdentity) fs.unlinkSync(row.sidecar);
  }
}
