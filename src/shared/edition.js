import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EDITIONS, EDITION_IDS, DEFAULT_EDITION_ID, manifestFor } = require('./edition-manifest.cjs');

let packageEdition = '';
try {
  packageEdition = require('../../package.json').frostbyteEdition ?? '';
} catch { /* a source-only consumer can still select an edition by environment */ }

/**
 * Permissive selector. An unrecognized value degrades to the default edition
 * rather than throwing, so a stray environment variable cannot stop the app
 * from starting. Build tooling uses the strict `manifestFor` instead — there a
 * typo must fail the build loudly rather than ship a mislabeled artifact.
 */
export function resolveEdition({ environment = process.env.FROSTBYTE_EDITION, packaged = packageEdition } = {}) {
  const value = String(environment || packaged || DEFAULT_EDITION_ID).trim().toLowerCase();
  return EDITIONS[value] ? value : DEFAULT_EDITION_ID;
}

/**
 * Resolve the edition this process is running as.
 *
 * Resolution order:
 *   1. `FROSTBYTE_EDITION`, honoured only for a plain source checkout
 *      (`process.defaultApp`). This lets tests and `electron .` switch identity.
 *   2. The edition the installed executable was *built* as.
 *
 * An installed executable must never read its identity from a user-writable
 * environment variable, so a packaged build always reports what it was built as.
 *
 * The identity table lives in `./edition-manifest.cjs`, which is also what the
 * electron-builder config and release tooling read, so a shipped artifact and
 * this runtime can never disagree about names, paths or channels.
 */
export function resolveRuntimeEdition({
  environment = process.env.FROSTBYTE_EDITION,
  packaged = packageEdition,
  defaultApp = process.defaultApp,
} = {}) {
  return resolveEdition({ environment: defaultApp === true ? environment : '', packaged });
}

export const APP_EDITION = resolveRuntimeEdition();

/**
 * The narrow runtime contract. Build-time fields (appId, artifactPrefix,
 * outputDirectory, tagPrefix, notesFile, …) are intentionally excluded:
 * `EDITION_INFO` is forwarded to the renderer over IPC, and the renderer needs
 * identity and display strings, not packaging internals.
 */
const manifest = EDITIONS[APP_EDITION];
export const EDITION_INFO = Object.freeze({
  id: manifest.id,
  name: manifest.name,
  profile: manifest.profile,
  channel: manifest.channel,
  displayName: manifest.displayName,
  appSetName: manifest.appSetName,
  desktopId: manifest.desktopId,
});

export { EDITIONS, EDITION_IDS, DEFAULT_EDITION_ID, manifestFor };