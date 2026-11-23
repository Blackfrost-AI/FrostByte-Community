/**
 * Update plane — deterministic checker for engines/containers/configs/recipes.
 * Pure: takes installed snapshot + hub update feed; returns nudges.
 * No Electron, no fetch; caller supplies both sides.
 */

const SEVERITY_RANK = Object.freeze({ info: 0, recommended: 1, security: 2 });

function parseVersion(v) {
  // simple semver-ish compare without external dep; falls back to lexicographic
  const parts = String(v || '').split(/[^0-9A-Za-z]+/).filter(Boolean);
  return parts;
}

function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? '', bv = pb[i] ?? '';
    const an = Number(av), bn = Number(bv);
    const aNum = String(an) === av && Number.isFinite(an);
    const bNum = String(bn) === bv && Number.isFinite(bn);
    if (aNum && bNum) { if (an !== bn) return an - bn; }
    else { if (av !== bv) return av < bv ? -1 : 1; }
  }
  return 0;
}

export function checkUpdates({ installed, feed }) {
  // installed: { engines:[{name,version,digest?}], recipes:[{id,digest}], configs:[{repoId,revision}] }
  // feed: { engines:[{name,version,digest,severity,notes}], recipes:[{id,digest,notes}], configs:[{repoId,revision,notes}] }
  const nudges = [];
  const byEngine = new Map((installed?.engines || []).map(e => [String(e.name), e]));
  for (const next of (feed?.engines || [])) {
    const cur = byEngine.get(String(next.name));
    if (!cur) continue;
    // digest mismatch or version newer
    const sameDigest = next.digest && cur.digest && next.digest === cur.digest;
    const newer = compareVersions(next.version, cur.version) > 0;
    if (sameDigest && !newer) continue;
    // If feed has no version comparison and digest same, skip; else nudge
    if (!newer && !next.digest) continue;
    nudges.push({
      kind: 'engine',
      name: next.name,
      from: cur.version,
      to: next.version,
      severity: SEVERITY_RANK[next.severity] != null ? next.severity : (next.security ? 'security' : 'recommended'),
      notes: String(next.notes || '').slice(0, 1000),
      digest: next.digest || '',
    });
  }

  const byRecipe = new Map((installed?.recipes || []).map(r => [String(r.id), r]));
  for (const next of (feed?.recipes || [])) {
    const cur = byRecipe.get(String(next.id));
    if (!cur) continue;
    if (next.digest && cur.digest && next.digest === cur.digest) continue;
    nudges.push({ kind: 'recipe', id: next.id, from: cur.digest || '', to: next.digest || '', severity: next.severity || 'recommended', notes: String(next.notes || '').slice(0, 1000) });
  }

  // Config revisions (HF)
  const byConfig = new Map((installed?.configs || []).map(c => [String(c.repoId), c]));
  for (const next of (feed?.configs || [])) {
    const cur = byConfig.get(String(next.repoId));
    if (!cur) continue;
    if (next.revision && cur.revision && String(next.revision).toLowerCase() === String(cur.revision).toLowerCase()) continue;
    nudges.push({ kind: 'config', repoId: next.repoId, from: cur.revision || '', to: next.revision || '', severity: next.severity || 'info', notes: String(next.notes || '').slice(0, 1000) });
  }

  // Container image digests (OCI). A changed digest means a new image even when
  // the tag is unchanged, so compare on digest like the engine/recipe paths.
  const byContainer = new Map((installed?.containers || []).map(c => [String(c.name), c]));
  for (const next of (feed?.containers || [])) {
    const cur = byContainer.get(String(next.name));
    if (!cur) continue;
    if (next.digest && cur.digest && next.digest === cur.digest) continue;
    nudges.push({
      kind: 'container', name: next.name,
      from: cur.tag || cur.digest || '', to: next.tag || next.digest || '',
      severity: next.severity || 'info', notes: String(next.notes || '').slice(0, 1000), digest: next.digest || '',
    });
  }

  // Highest severity first
  nudges.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
  return nudges;
}

export { compareVersions, SEVERITY_RANK };
