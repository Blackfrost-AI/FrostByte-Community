import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_TEST_MARKER_RELATIVE = 'tests/.frostbyte-agent-test-workspace';
export const AGENT_TEST_MARKER_CONTENT = 'FROSTBYTE_AGENT_SOURCE_TEST_WORKSPACE_V1\n';

/**
 * Permit the companion's private-peer fixtures only from this source test tree.
 * The marker lives under tests/ and is deliberately absent from every companion
 * archive, so an environment variable alone cannot weaken an installed agent.
 */
export function sourceAgentTestModeEnabled({ env = process.env, sourceRoot } = {}) {
  if (env?.FROSTBYTE_AGENT_TEST !== '1') return false;
  const root = path.resolve(sourceRoot || fileURLToPath(new URL('../..', import.meta.url)));
  const marker = path.join(root, ...AGENT_TEST_MARKER_RELATIVE.split('/'));
  let descriptor;
  try {
    const expectedBytes = Buffer.from(AGENT_TEST_MARKER_CONTENT, 'ascii');
    const before = fs.lstatSync(marker);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== expectedBytes.length) return false;
    descriptor = fs.openSync(marker, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const held = fs.fstatSync(descriptor), current = fs.lstatSync(marker);
    if (!held.isFile() || held.nlink !== 1 || held.size !== expectedBytes.length
      || held.dev !== before.dev || held.ino !== before.ino || held.dev !== current.dev || held.ino !== current.ino) return false;
    const bytes = Buffer.alloc(expectedBytes.length);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) return false;
      offset += count;
    }
    return bytes.equals(expectedBytes);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
