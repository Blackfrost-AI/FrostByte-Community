/** Short integrity text for a library card, mirroring originSummary's shape.
 * `tone` is ok, neutral or warn. Unknown is never presented as safe: an
 * unclassifiable file keeps the neutral tone and says so plainly. */
export function integritySummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.status === 'failed') return { tone: 'warn', label: 'Integrity scan failed', detail: typeof raw.error === 'string' && raw.error ? raw.error : 'The scan could not read these files.' };
  if (raw.status !== 'done') return null;
  const parts = [];
  let tone = 'neutral', label = 'Integrity: unclassified';
  if (raw.format === 'risky-format') {
    tone = 'warn'; label = 'Integrity: risky files';
    parts.push(`${raw.risky?.length || 0} file${raw.risky?.length === 1 ? '' : 's'} can run code when loaded — sharing blocked`);
  } else if (raw.format === 'safe-format') {
    tone = 'ok'; label = 'Integrity: safe formats';
    parts.push('No code-executing formats found');
  } else {
    parts.push(`${raw.unknown?.length || 0} file${raw.unknown?.length === 1 ? '' : 's'} could not be classified`);
  }
  if (raw.upstream?.verdict === 'matches-upstream') {
    const repo = typeof raw.upstream.repoId === 'string' && raw.upstream.repoId ? ` (${raw.upstream.repoId})` : '';
    const missing = Number.isSafeInteger(raw.upstream.missing) && raw.upstream.missing > 0 ? ` · ${raw.upstream.missing} file${raw.upstream.missing === 1 ? '' : 's'} without an upstream hash` : '';
    parts.push(`matches Hugging Face${repo} — ${raw.upstream.compared} file${raw.upstream.compared === 1 ? '' : 's'} checked${missing}`);
    // Green only when the formats themselves were validated. An upstream
    // match on unclassifiable files stays neutral — unknown is never safe.
    if (raw.format === 'safe-format') { tone = 'ok'; label = 'Integrity: matches upstream'; }
  } else if (raw.upstream?.verdict === 'differs') {
    tone = 'warn';
    parts.push(`differs from Hugging Face (${raw.upstream.mismatches?.length || 0} mismatch${raw.upstream.mismatches?.length === 1 ? '' : 'es'})`);
  }
  return { tone, label, detail: parts.join(' · ') };
}
