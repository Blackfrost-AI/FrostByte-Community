import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Load the *resolved* electron-builder config for one edition.
 *
 * `electron-builder.cjs` reads FROSTBYTE_EDITION at require time and
 * electron-builder's own `getConfig` memoizes by file path, so two editions
 * cannot be loaded in a single process. Running the config in a child process
 * per edition keeps each load independent and tests the file the way the
 * builder actually consumes it.
 */
export function builderConfigFor(editionId) {
  // The config is exported as a factory (see electron-builder.cjs header), so
  // call it to get a fresh object for this edition.
  const script = `const m = require(${JSON.stringify(path.join(projectRoot, 'electron-builder.cjs'))}); console.log(JSON.stringify(typeof m === 'function' ? m() : m));`;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, FROSTBYTE_EDITION: editionId },
  });
  return JSON.parse(out);
}
