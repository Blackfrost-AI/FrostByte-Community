import { createHfDownloadAuthorization } from './hf-authorizations.js';
import { validateHfDownloadSelection, validateHfRepoId } from './hf.js';

export function validateHfResumeIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 2000
    || ids.some(id => typeof id !== 'string' || !id || id.length > 8192 || /[\x00-\x1f\x7f]/.test(id))
    || new Set(ids).size !== ids.length) {
    throw new Error('Choose between 1 and 2,000 distinct HuggingFace files to resume.');
  }
  return [...ids];
}

/** Include progress and routing in the stale-work check, without retaining a
 * controller or returning credentials to the renderer. */
export function hfResumeRecordSnapshot(record) {
  return JSON.stringify([
    record.id, record.repoId, record.revision, record.filePath, record.baseDir,
    record.destination, record.dest, record.total, record.downloaded, record.status,
    record.source, record.peerDeviceId,
  ]);
}

/** A model-level approval can cover only one repository/revision/destination.
 * Records come from the main-owned queue or freshly validated companion state. */
export function prepareHfResume(records, generation, { remote = false } = {}) {
  if (!Array.isArray(records) || !records.length || records.length > 2000 || records.some(record => !record)) {
    throw new Error('This HuggingFace selection is no longer available. Refresh and try again.');
  }
  validateHfResumeIds(records.map(record => record.id));
  const first = records[0], rootKey = remote ? 'destination' : 'baseDir';
  const repoId = validateHfRepoId(first.repoId), revision = first.revision, root = first[rootKey];
  let downloadedBytes = 0;
  for (const record of records) {
    if (record.repoId !== repoId || record.revision !== revision || record[rootKey] !== root) {
      throw new Error('Resume one model version and destination at a time.');
    }
    if (!['paused', 'error'].includes(record.status)) {
      throw new Error('A selected HuggingFace file is no longer paused. Refresh and try again.');
    }
    if (!Number.isSafeInteger(record.downloaded) || record.downloaded < 0
      || record.total > 0 && record.downloaded > record.total) {
      throw new Error('A selected HuggingFace file has invalid saved progress.');
    }
    downloadedBytes += record.downloaded;
    if (!Number.isSafeInteger(downloadedBytes)) throw new Error('The HuggingFace selection is too large.');
  }
  validateHfDownloadSelection(repoId, records.map(record => record.filePath));
  const authorization = createHfDownloadAuthorization({
    repoId, revision, root, generation, rootStyle: remote ? 'posix' : 'local',
    files: records.map(record => ({ path: record.filePath, size: record.total })),
  });
  return {
    authorization, downloadedBytes,
    status: records.every(record => record.status === first.status) ? first.status : 'paused/error',
    snapshots: records.map(hfResumeRecordSnapshot),
  };
}
