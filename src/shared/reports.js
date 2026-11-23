// Legal versions must match legal.json. The legacy validators are retained for
// historical report compatibility; the v1 desktop has no report transport.
export const TERMS_VERSION = 'frostbyte-terms-2026-10-13-v1';
export const PRIVACY_VERSION = 'frostbyte-privacy-2026-10-12-v1';
export const DIAGNOSTICS_VERSION = 'frostbyte-diagnostics-v1';
export const COUNTERS = Object.freeze([
  'app_start', 'unexpected_error', 'renderer_unresponsive', 'renderer_exit',
  'hf_ok', 'hf_error', 'hf_under_1s', 'hf_1_to_5s', 'hf_over_5s',
  'spark_ok', 'spark_error', 'spark_under_1s', 'spark_1_to_5s', 'spark_over_5s',
  'torrent_ready', 'torrent_done', 'torrent_no_peers', 'torrent_error',
  'resume_ok', 'resume_error', 'hf_download_done', 'hf_download_error',
  'timeout', 'unreachable', 'storage_full', 'storage_permission', 'storage_unavailable',
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function reject() { throw new Error('Invalid report. Review the fields and try again.'); }
function object(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) reject();
}
export function validateDiagnostics(value) {
  object(value, ['app', 'counters']);
  object(value.app, ['version', 'platform', 'arch', 'osMajor']);
  const a = value.app;
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-beta\.\d{1,4})?$/.test(a.version) || !['darwin', 'win32', 'linux'].includes(a.platform) || !['arm64', 'x64'].includes(a.arch) || !Number.isInteger(a.osMajor) || a.osMajor < 1 || a.osMajor > 999) reject();
  object(value.counters, COUNTERS, []);
  for (const count of Object.values(value.counters)) if (!Number.isInteger(count) || count < 1 || count > 10000) reject();
  return structuredClone(value);
}
export function validateReport(value) {
  if (value?.kind === 'diagnostics') {
    object(value, ['kind', 'schemaVersion', 'reportId', 'consentVersion', 'diagnostics']);
    if (value.consentVersion !== DIAGNOSTICS_VERSION) reject();
    validateDiagnostics(value.diagnostics);
  } else if (value?.kind === 'feedback') {
    object(value, ['kind', 'schemaVersion', 'reportId', 'privacyVersion', 'category', 'message', 'expected', 'email', 'diagnostics'], ['kind', 'schemaVersion', 'reportId', 'privacyVersion', 'category', 'message', 'expected']);
    if (value.privacyVersion !== PRIVACY_VERSION || !['bug', 'suggestion', 'confusing'].includes(value.category)) reject();
    if (typeof value.message !== 'string' || value.message.trim().length < 5 || value.message.length > 4000 || typeof value.expected !== 'string' || value.expected.length > 2000) reject();
    if (value.email !== undefined && (typeof value.email !== 'string' || value.email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.email))) reject();
    if (value.diagnostics !== undefined) validateDiagnostics(value.diagnostics);
  } else reject();
  if (value.schemaVersion !== 1 || typeof value.reportId !== 'string' || !uuid.test(value.reportId)) reject();
  return structuredClone(value);
}
