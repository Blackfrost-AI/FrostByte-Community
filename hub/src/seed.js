// Seed data for the local Hub. These are REAL, schema-valid recipe manifests signed with
// a deterministic development publisher key, published through the same verified path as
// user content. They exist so a fresh local hub has browsable content; they are clearly
// labeled as development seeds and are not production recipes.
import { generateKeypair, signRecipePublish } from './crypto.js';
import { validateRecipe } from '../../src/shared/recipe-manifest.js';
import { FROSTNET_TERMS } from '../../src/shared/release-manifest.js';

// A fixed dev publisher key is supplied by the caller (the app persists one) so seed
// digests are stable across restarts. These are local-development seeds, not production.

function seedManifest({ id, title, kind, description, engine, modelRef, publisher, extra = {} }) {
  const file = {
    path: `${id}.json`,
    size: 128,
    sha256: 'b'.repeat(64),
  };
  return {
    schema: 'frostbyte.recipe',
    version: 2,
    id,
    title,
    kind,
    publisher,
    files: [file],
    description,
    ...(engine ? { engine } : {}),
    ...(modelRef ? { modelRef } : {}),
    license: { id: 'Apache-2.0', statement: 'Development seed recipe. Apache-2.0.' },
    createdAt: '2026-10-10T00:00:00.000Z',
    ...extra,
  };
}

const SEED_DEFS = [
  {
    id: 'vllm-openai-server', title: 'vLLM OpenAI-compatible server', kind: 'tmux',
    description: 'Serve an open model with vLLM behind an OpenAI-compatible API. Development seed.',
    engine: { name: 'vllm', version: '0.6.0', channel: 'stable' },
    modelRef: { repoId: 'Qwen/Qwen2.5-7B-Instruct' },
    extra: { session: 'vllm', argv: ['python', '-m', 'vllm.entrypoints.openai.api_server', '--model', 'Qwen/Qwen2.5-7B-Instruct', '--port', '8000'], healthPort: 8000 },
  },
  {
    id: 'sglang-router', title: 'SGLang router', kind: 'tmux',
    description: 'SGLang serving with a router front-end. Development seed.',
    engine: { name: 'sglang', version: '0.4.0', channel: 'stable' },
    modelRef: { repoId: 'meta-llama/Llama-3.1-8B-Instruct' },
    extra: { session: 'sglang', argv: ['python', '-m', 'sglang.launch_server', '--model-path', 'meta-llama/Llama-3.1-8B-Instruct', '--port', '30000'], healthPort: 30000 },
  },
  {
    id: 'llamacpp-server', title: 'llama.cpp HTTP server', kind: 'native',
    description: 'Lightweight CPU/GPU inference with llama.cpp. Development seed.',
    engine: { name: 'llama.cpp', version: 'b4000', channel: 'stable' },
    modelRef: { repoId: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF' },
  },
  {
    id: 'ollama-docker', title: 'Ollama in Docker', kind: 'docker',
    description: 'Ollama packaged as a container. Development seed.',
    engine: { name: 'ollama', version: '0.5.0', channel: 'stable' },
    extra: { container: 'ollama', image: 'ollama/ollama:latest' },
  },
];

// Build signed seed records. The caller supplies a stable dev keypair (privateKeyHex) so
// digests are deterministic; if omitted, a fresh key is generated (still valid, just not
// stable across restarts).
export function buildSeeds({ privateKeyHex, publicKeyHex } = {}) {
  const key = privateKeyHex && publicKeyHex
    ? { privateKeyHex, publicKeyHex }
    : generateKeypair();
  const records = [];
  for (const def of SEED_DEFS) {
    const manifest = validateRecipe(seedManifest({ ...def, publisher: key.publicKeyHex }));
    const signature = signRecipePublish(manifest, key.privateKeyHex);
    records.push({ manifest, signature, terms: FROSTNET_TERMS });
  }
  return { records, publisher: key.publicKeyHex };
}

// Publish seeds into a store through the real verified publish path.
export function seedStore(store, keypair) {
  const { records } = buildSeeds(keypair);
  for (const record of records) store.publish(record);
  return records.length;
}