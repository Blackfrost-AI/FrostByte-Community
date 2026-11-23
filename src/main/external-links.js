import { AEON_X } from '../shared/aeon.js';
import { COMMUNITY_LINKS } from '../shared/community.js';
import { THEME_CREDIT_URLS } from '../shared/theme-credits.js';
import { DOWNLOAD_URL } from './updates.js';

const PRE_ACCEPT_LINKS = new Set([
  'https://blackfrostai.com/frostbyte/terms',
  'https://blackfrostai.com/frostbyte/privacy',
  ...Object.values(COMMUNITY_LINKS),
]);
const EXACT_LINKS = new Set([
  ...PRE_ACCEPT_LINKS,
  DOWNLOAD_URL,
  AEON_X,
  ...THEME_CREDIT_URLS,
  // Canonical frostbyte.si handoffs (spec §5.7) — exact URLs, post-acceptance
  // only. Query strings, hashes, ports, and credentials are all rejected by the
  // exact-match check below.
  'https://frostbyte.si/admin',
  'https://frostbyte.si/dashboard',
  'https://frostbyte.si/account',
  'https://frostbyte.si/frostnet',
  'https://frostbyte.si/pricing',
]);

export function classifyExternalUrl(value, { accepted = true } = {}) {
  let parsed;
  try { parsed = new URL(String(value)); }
  catch { throw new Error('That external link is invalid.'); }
  const huggingFacePath = parsed.pathname.split('/');
  const huggingFace = parsed.protocol === 'https:' && parsed.hostname === 'huggingface.co'
    && !parsed.port && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    && huggingFacePath.length === 3 && huggingFacePath[0] === ''
    && huggingFacePath.slice(1).every(part => /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..'].includes(part));
  const exact = EXACT_LINKS.has(parsed.href);
  if (!exact && !huggingFace) throw new Error('Only official FrostByte, community, and HuggingFace links can be opened.');
  if (!accepted && !PRE_ACCEPT_LINKS.has(parsed.href)) throw new Error('Only the terms, privacy notice, and official community or support links can be opened before acceptance.');
  return { url: parsed.href, requiresNativeReview: !exact && huggingFace };
}

export function approvedExternalUrl(value, options) {
  return classifyExternalUrl(value, options).url;
}
