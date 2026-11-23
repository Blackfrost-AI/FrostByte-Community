// Stock serve recipes for the model page: is this checkpoint servable by vLLM / SGLang / llama.cpp / Ollama / MLX, and with what command?
// Pure and offline: support comes from the bundled registry snapshot (scripts/build-serve-registry.py), never a runtime lookup.
// Commands are shown for the user to copy; nothing here executes them.
import REGISTRY from './serve-registry.js';
import { detectHfFormats } from './hf-formats.js';

// Container images. Spark (DGX Spark, arm64 + Blackwell) images follow NVIDIA's dgx-spark-playbooks
// (commit 3088315, nvidia/vllm/README.md and nvidia/sglang/README.md). Generic images are the projects' official ones.
export const SERVE_IMAGES = Object.freeze({
  vllm: { spark: 'nvcr.io/nvidia/vllm:26.05.post1-py3', generic: 'vllm/vllm-openai:latest' },
  sglang: { spark: 'lmsysorg/sglang:latest-cu130', generic: 'lmsysorg/sglang:latest' },
  llamacpp: { spark: 'ghcr.io/ggml-org/llama.cpp:server-cuda', generic: 'ghcr.io/ggml-org/llama.cpp:server' },
});
export const SERVE_PORTS = Object.freeze({ vllm: 8000, sglang: 30000, llamacpp: 8080, ollama: 11434, mlx: 8080 });
export const SERVE_REGISTRY_SOURCES = REGISTRY.sources;

const ENGINE_LABEL = {
  vllm: 'vLLM',
  sglang: 'SGLang',
  llamacpp: 'llama.cpp',
  ollama: 'Ollama',
  mlx: 'MLX LM Server',
};
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
// Formats these engines do not load from a Hugging Face checkpoint.
const UNSERVABLE = {
  exl3: 'EXL3 quants are served by ExLlamaV3 / REXL3, not vLLM or SGLang.',
  exl2: 'EXL2 quants are served by ExLlamaV2 / TabbyAPI, not vLLM or SGLang.',
  mlx: 'MLX weights run on Apple Silicon with MLX, not vLLM or SGLang.',
};

/** POSIX single-quote a value for display in a copyable shell command. */
export function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function supportFor(engine, architectures) {
  for (const arch of architectures) {
    if (engine === 'vllm' && Object.hasOwn(REGISTRY.vllm, arch)) return { arch, task: REGISTRY.vllm[arch] };
    if (engine === 'sglang' && REGISTRY.sglang.includes(arch)) return { arch, task: 'generate' };
  }
  return null;
}

function buildAlternativeRecipes(model, { target = 'local', localPath = '', formats = [], files = [], architectures = [] } = {}) {
  const repo = typeof model?.id === 'string' && REPO_RE.test(model.id) ? model.id : '';
  if (!repo) return [];
  const spark = target === 'spark';
  const archLabel = architectures[0] || 'Transformer';
  const ggufFiles = files.filter(file => /\.gguf$/i.test(file?.path || '') && !/(?:^|\/|[-_.])mmproj/i.test(file?.path || ''));
  const hasMlx = formats.includes('mlx');
  const alt = [];

  if (ggufFiles.length) {
    const chosenGguf = ggufFiles.find(file => /Q4_K_M/i.test(file.path)) || ggufFiles[0];
    const ggufName = chosenGguf.path;
    const port = SERVE_PORTS.llamacpp;
    const localModelFile = localPath ? `${localPath.replace(/\/+$/, '')}/${ggufName}` : '';
    const llamaCmd = localModelFile
      ? `llama-server -m ${shellQuote(localModelFile)} --host 0.0.0.0 --port ${port} -ngl 99`
      : `llama-server -hf ${shellQuote(repo)} -hff ${shellQuote(ggufName)} --host 0.0.0.0 --port ${port} -ngl 99`;
    alt.push({
      id: 'llamacpp',
      label: ENGINE_LABEL.llamacpp,
      architecture: archLabel,
      task: 'generate',
      image: 'llama-server (CLI)',
      port,
      container: '',
      pull: spark ? 'brew install llama.cpp  # or build llama.cpp with -DGGML_CUDA=ON' : 'brew install llama.cpp',
      run: llamaCmd,
      endpoint: `http://<host>:${port}/v1`,
      notes: [
        `Serves GGUF file ${ggufName} with OpenAI-compatible /v1/chat/completions.`,
        ...(model.gated && !localPath ? ['Gated model: export HF_TOKEN on the host first.'] : []),
      ],
    });
    alt.push({
      id: 'ollama',
      label: ENGINE_LABEL.ollama,
      architecture: archLabel,
      task: 'generate',
      image: 'ollama (CLI)',
      port: SERVE_PORTS.ollama,
      container: '',
      pull: `ollama pull hf.co/${repo}`,
      run: `ollama run hf.co/${repo}`,
      endpoint: `http://<host>:${SERVE_PORTS.ollama}/v1`,
      notes: ['Runs directly via Ollama’s Hugging Face GGUF integration and exposes an OpenAI-compatible endpoint on port 11434.'],
    });
  }

  if (hasMlx) {
    const port = SERVE_PORTS.mlx;
    const modelArg = localPath || repo;
    alt.push({
      id: 'mlx',
      label: ENGINE_LABEL.mlx,
      architecture: archLabel,
      task: 'generate',
      image: 'mlx-lm (Apple Silicon)',
      port,
      container: '',
      pull: 'pip install mlx-lm',
      run: `mlx_lm.server --model ${shellQuote(modelArg)} --host 0.0.0.0 --port ${port}`,
      endpoint: `http://<host>:${port}/v1`,
      notes: ['Runs natively on Apple Silicon Macs via MLX and exposes an OpenAI-compatible /v1/chat/completions API.'],
    });
  }

  return alt;
}

/**
 * @param model  hfModelInfo result: { id, architectures, tags, files, gated }
 * @param opts   { target: 'spark' | 'local', localPath?: string, includeAlternatives?: boolean } — localPath is a saved copy on that device.
 * @returns { status: 'supported' | 'unsupported' | 'unknown', reason, engines: [...], alternatives: [...] }
 */
export function serveOptions(model, { target = 'local', localPath = '', includeAlternatives = false } = {}) {
  const repo = typeof model?.id === 'string' && REPO_RE.test(model.id) ? model.id : '';
  const architectures = Array.isArray(model?.architectures) ? model.architectures.filter(a => typeof a === 'string') : [];
  const files = Array.isArray(model?.files) ? model.files : [];
  const formats = repo ? detectHfFormats(model).map(format => format.id) : [];
  const alternatives = repo ? buildAlternativeRecipes(model, { target, localPath, formats, files, architectures }) : [];
  const none = (status, reason) => (
    includeAlternatives && alternatives.length
      ? { status: 'supported', reason, architectures, engines: alternatives, alternatives }
      : { status, reason, architectures, engines: [], alternatives }
  );
  if (!repo) return none('unknown', 'Unknown repository.');
  const blocked = formats.find(id => UNSERVABLE[id]);
  if (blocked) return none('unsupported', UNSERVABLE[blocked]);
  const hasSafetensors = files.some(file => /\.safetensors$/i.test(file?.path || ''));
  if (!hasSafetensors) {
    return none('unsupported', files.some(file => /\.gguf$/i.test(file?.path || ''))
      ? 'GGUF files run best with llama.cpp, Ollama or LM Studio. vLLM and SGLang serve safetensors checkpoints.'
      : 'No safetensors weights in this repository.');
  }
  if (!architectures.length) return none('unknown', 'This repository has no config.json architecture, so serving support can\u2019t be checked.');

  const spark = target === 'spark';
  const name = repo.split('/')[1].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'model';
  const mount = localPath ? `${shellQuote(`${localPath}:/model:ro`)}` : `${spark ? '$HOME' : '~'}/.cache/huggingface:/root/.cache/huggingface`;
  const modelArg = localPath ? '/model' : repo;
  const engines = [];
  for (const engine of ['vllm', 'sglang']) {
    const hit = supportFor(engine, architectures);
    if (!hit) continue;
    const image = SERVE_IMAGES[engine][spark ? 'spark' : 'generic'];
    const port = SERVE_PORTS[engine];
    const container = `frostbyte-${engine}-${name}`.slice(0, 63);
    const run = [
      'docker run -d', `--name ${container}`, '--gpus all', '--ipc=host', `-p ${port}:${port}`, `-v ${mount}`,
      ...(model.gated && !localPath ? ['-e HF_TOKEN'] : []),
      image,
      ...(engine === 'vllm'
        ? [`vllm serve ${shellQuote(modelArg)}`, ...(localPath ? [`--served-model-name ${shellQuote(repo)}`] : []), `--host 0.0.0.0 --port ${port}`]
        : [`python3 -m sglang.launch_server --model-path ${shellQuote(modelArg)}`, ...(localPath ? [`--served-model-name ${shellQuote(repo)}`] : []), `--host 0.0.0.0 --port ${port}`]),
    ];
    engines.push({
      id: engine, label: ENGINE_LABEL[engine], architecture: hit.arch, task: hit.task, image, port, container,
      pull: `docker pull ${image}`,
      run: run.join(' \\\n  '),
      endpoint: `http://<host>:${port}/v1`,
      notes: [
        ...(hit.task === 'pooling' ? ['Embedding / scoring model: serves pooling endpoints, not chat.'] : []),
        ...(formats.includes('nvfp4') ? ['NVFP4 needs a Blackwell GPU (DGX Spark, RTX 50, B200).'] : []),
        ...(model.gated && !localPath ? ['Gated model: export HF_TOKEN on the host first. FrostByte never puts your token in the command.'] : []),
        ...(!spark ? ['Needs a Linux host with an NVIDIA GPU and the NVIDIA Container Toolkit.'] : []),
      ],
    });
  }
  if (includeAlternatives && alternatives.length) engines.push(...alternatives);
  if (!engines.length) return none('unsupported', `${architectures[0]} isn\u2019t in the bundled vLLM or SGLang support list.`);
  return { status: 'supported', reason: '', architectures, engines, alternatives };
}
