export const THEME_IDS = Object.freeze(['frost', 'abyss', 'malachite', 'aeon', 'u1tra_instinct', 'blackfrost', 'jensen']);
// Retain validation of saved v1 preferences for rollback compatibility only.
// Scene/snow settings no longer control the renderer or expose promotional art.
export const LEGACY_BLACKFROST_SCENE_IDS = Object.freeze(['glacier', 'blizzard']);
export const normalizeTheme = value => THEME_IDS.includes(value) ? value : 'frost';
