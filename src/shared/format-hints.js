/** Filename-only format classification shared by the main-process analyzer
 * and the renderer's pre-download review. This is a *hint* for review UI —
 * the authoritative verdict always comes from the structural analyzer after
 * download. Unknown extensions are never presented as safe. */
export const PICKLE_EXTENSIONS = Object.freeze(['.bin', '.pt', '.pth', '.pkl', '.pickle', '.ckpt', '.joblib', '.dill', '.npy', '.npz']);

export function classifyFilename(name) {
  const match = /\.[a-z0-9]+$/i.exec(String(name ?? ''));
  const ext = match ? match[0].toLowerCase() : '';
  if (ext === '.safetensors') return { ext, format: 'safetensors', hint: 'expected data-only' };
  if (ext === '.gguf') return { ext, format: 'gguf', hint: 'expected data-only' };
  if (PICKLE_EXTENSIONS.includes(ext)) return { ext, format: 'pickle', hint: 'can run code' };
  return { ext, format: 'unknown', hint: 'unclassified' };
}
