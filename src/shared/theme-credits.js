// Contributor credit shown under Settings → Interface → Appearance. The credit belongs to the theme, not the app:
// a theme authored by a contributor names that contributor; the stock themes name nobody.
// Links are absolute https X profiles and are also allowlisted for openExternal (src/main/external-links.js).
export const THEME_CREDITS = Object.freeze({
  aeon: Object.freeze({ name: 'AEON Forge', handle: '@SpaceTimeViking', url: 'https://x.com/SpaceTimeViking' }),
  u1tra_instinct: Object.freeze({ name: 'keys 🧪', handle: '@u1tra_instinct', url: 'https://x.com/u1tra_instinct' }),
  blackfrost: Object.freeze({ name: 'Blackfrost AI', handle: '@blackfrost_ai', url: 'https://x.com/blackfrost_ai' }),
});

/** Credit for a theme id, or null when the theme has no named contributor. */
export function themeCredit(theme) {
  return Object.hasOwn(THEME_CREDITS, theme) ? THEME_CREDITS[theme] : null;
}

/** Every credit URL, for the external-link allowlist. */
export const THEME_CREDIT_URLS = Object.freeze(Object.values(THEME_CREDITS).map(credit => credit.url));