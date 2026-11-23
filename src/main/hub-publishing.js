/**
 * Hub publishing — generalizes src/main/publishing-service.js for Hub's v1 API.
 * Uses release-manifest + recipe-manifest digests; supports publish + withdraw.
 * Pure: inject store + providers; mirrors PublicationQueue semantics.
 */
import { createHash } from 'node:crypto';
import { canonicalJson as canonicalReleaseJson, validateRelease } from '../shared/release-manifest.js';
import { canonicalJson as canonicalRecipeJson, validateRecipe, RECIPE_ID_RE } from '../shared/recipe-manifest.js';
import { FROSTNET_TERMS } from '../shared/release-manifest.js';

export const HUB_PUBLISH_TERMS = FROSTNET_TERMS; // single terms anchor; rotate via ADR 004

function canonicalFor(record) {
  // record may be release v1 or recipe v2; validate first to normalize
  try { validateRecipe(record); return canonicalRecipeJson(record); } catch {}
  validateRelease(record);
  return canonicalReleaseJson(record);
}

export function hubManifestDigest(manifest) {
  return createHash('sha256').update(canonicalFor(manifest)).digest('hex');
}

export function hubPublishId({ digest, destination, accountId, operation }) {
  if (!/^[a-f0-9]{64}$/.test(digest || '')) throw new Error('Invalid publish digest.');
  if (!destination || typeof destination !== 'string') throw new Error('Destination required.');
  return createHash('sha256').update([digest, destination, accountId || '', operation, HUB_PUBLISH_TERMS].join('\0')).digest('hex');
}

export function validateHubPublishPayload({ manifest, digest, terms, signature }) {
  if (terms !== HUB_PUBLISH_TERMS) throw new Error('Publishing terms changed. Review and re-accept.');
  // validate manifest shape and digest binding
  const canonical = canonicalFor(manifest);
  const computed = createHash('sha256').update(canonical).digest('hex');
  if (digest && digest !== computed) throw new Error('Digest does not match manifest.');
  if (manifest.id && !RECIPE_ID_RE.test(manifest.id)) throw new Error('Invalid recipe id.');
  if (signature != null && typeof signature !== 'string') throw new Error('Invalid signature.');
  return { computedDigest: computed, canonical };
}
