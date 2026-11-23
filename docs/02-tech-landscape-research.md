# Technology Landscape Research Dossier

*What already exists in the LLM-P2P space, what works, what quietly died, and what we should therefore build on.*

---

## 1. Prior Art — Who Has Tried This

### The graveyard
| Project | Approach | Status / lesson |
|---|---|---|
| **Petals** (BigScience) | Shards model *layers* across volunteer GPUs, BitTorrent-inspired swarm over a DHT. Llama 3.1 up to 405B, Mixtral 8x22B. Drop-in HF API (`AutoDistributedModelForCausalLM`). ~10.5k stars. | **Stagnant.** Last commit ~Sept 2024. Public swarm described as effectively empty — users report slow speeds and no updates in ~2 years. **Lesson: no incentive layer = no network, no matter how clever the protocol.** Also a privacy problem: prompts and activations traverse strangers' machines. |
| **Exo** | Shards a model across multiple Apple Silicon devices, pooling unified memory. Zero-config LAN discovery. | **Alive but narrow:** LAN-only, Apple-Silicon-only, inference-only (no agents/tools), no NVIDIA. **Lesson: hardware lock-in caps the network.** |
| **cratetorrent** | Pure-Rust BitTorrent v1 on tokio. | Docs call it a **"toy program."** Linux-only (`preadv`), no DHT, no magnets, no UDP trackers, unmaintained ~3 years. **Do not build on it.** |

### The live experiments (closest neighbours)
| Project | Stack | What it gets right |
|---|---|---|
| **llama.garden** | Builds `.torrent`s from cached model files → publishes listings to **Nostr relays** (kind 30099) → fans out seeding across a "pump fleet" of Transmission instances. Self-contained HTML catalog that verifies **Schnorr signatures client-side** and hash-verifies the `.torrent` before handing it to your client. | The single most instructive project. Combines **BitTorrent + HuggingFace webseeds + a redirector**. Their speed test: **~77.1 MB/s using pumps + webseeds vs. slow plain-UDP BitTorrent.** Two lessons: (1) **hybrid webseed + swarm is non-negotiable** for day-one usability, (2) **signed manifests distributed over Nostr** is a proven pattern for a decentralized catalog. |
| **zest** | "One line of Python, faster pulls, BitTorrent under the hood" for HuggingFace. zig-xet, DHT `get_peers`, BT trackers, BEP 10 extensions, **BLAKE3** hashing. `zest serve`, `zest seed`, `--peer` for direct transfer. Existing `from_pretrained()` calls "just work." | **The DX bar.** A P2P layer that requires changing your code loses. Drop-in shims win. |
| **ossllms** (PyPI) | HF-cache-compatible download shim pulling from the "ossllms torrent network." | Same lesson: compatibility beats purity. |
| **from-hf-to-torrent** (premAI-io) | Scripts to self-host weights via torrent on a Hetzner box with Transmission, webseeds, mirrors. | The self-hosting playbook for a "pump fleet." |
| **LlamaTor / aitorrent / Hugging Bay** | Torrent files for model distribution. Hugging Bay (huggingbay.xyz, ~July 2026) indexes **~146,289 artifacts (~92% imported from HF)** with magnets, torrents, mirrors, SHA-256 hashes, license metadata, and reputation scores. | Hugging Bay proves demand — and proves the **branding trap**: "The Pirate Bay for AI models" invites the wrong legal and cultural read even though it indexes *open* models. **We do not use that framing.** |

### Real magnet links already in the wild
```
Safe-LLaMA-HF-v2 (4-04-23)  (Neko-Institute-of-Science)
magnet:?xt=urn:btih:8d634925911a03f787d9f68ac075a9b24281573a
  &dn=Safe-LLaMA-HF-v2+(4-04-23)
  &tr=http://bt2.archive.org:6969/announce
  &tr=http://bt1.archive.org:6969/announce

Grok-1  (xai-org, official)
magnet:?xt=urn:btih:5f96d43576e3d386c9ba65b883210a393b68210e
  &tr=https://academictorrents.com/announce.php
  &tr=udp://tracker.coppersurfer.tk:6969
  &tr=udp://tracker.opentrackr.org:1337/announce
```
Note `xai-org` publishing an **official** magnet for Grok-1 on its model card. Labs already accept this distribution channel for open weights. That legitimizes our core motion.

**The gap nobody has filled:** technical distribution (Petals, Exo, llama.garden) and incentive design exist **separately**. No working protocol unifies **discovery + routing + trust + incentive + provenance**. That integration — plus a preservation mandate — is Frost/Byte's actual product thesis.

---

## 2. Protocol Layer — What To Build On

| Layer / protocol | Role | 2026 status |
|---|---|---|
| **BitTorrent v1/v2** | High-volume file swarming | Still dominant by traffic. **v2 (BEP 52) adoption remains slow and immature** — defer unless per-file dedup / SHA-256 becomes a requirement. |
| **libp2p** | Modular P2P networking stack | Began as IPFS's networking layer, now an **independent de facto standard** — Ethereum 2.0, Polkadot, Filecoin, Iroh all use it. Transports: TCP, QUIC, WebSocket, WebTransport, WebRTC. Security: Noise, TLS 1.3. Pubsub: GossipSub. |
| **IPFS** | Content-addressed storage/retrieval | Mature; implementations now modular — **Kubo/Boxo** (Go), **Helia** (JS, for browsers/mobile/Electron/Tauri), **Iroh** (Rust, lighter/mobile-friendly). Persistence still depends on pinning. |
| **Mainline DHT (BEP 5)** | Peer discovery | One of the largest DHTs in operation. Optimized for churn and temporary peer records. |
| **Magnet + PEX + trackers** | Layered discovery | Still the most battle-tested combo for public file distribution. |

**Decision: BitTorrent for bytes, DHT + trackers + PEX + magnets for discovery, libp2p as the optional futurering for gossip/pubsub between clients.** This is the conservative, highest-proven-correctness choice. We are not building a new transport protocol; we are building a catalog, a trust layer, and an experience on top of a transport that already moves most of the internet's bulk bytes.

### BitTorrent tuning specifics we inherit
- **Piece vs. block are different things.** Piece = hashed unit in the `pieces` string. Block = sub-piece request tuple, conventionally **16 KiB**.
- **BEP 52 constraints:** piece size must be a power of two and a multiple of 16 KiB; **Merkle leaf block size is fixed at 16 KiB** (chosen because 16 KiB was already the de-facto messaging block size); the last 16 KiB block may be truncated, but the last *piece* is padded with blocks of imaginary zeros.
- **Why v2's Merkle trees matter to us:** with v1, a failed hash means re-downloading the entire piece. v2 validates at **block granularity**, so only 16 KiB is re-fetched and **the offending peer is identified with certainty** (v1 could only make a heuristic "smart-ban"). For 100 GB+ models over flaky consumer links, this is exactly the failure mode we care about.
- **Piece size guidance.** Transmission's `bestPieceSize` heuristic starts at **1024–2048 pieces**, min 64 KiB, max 16 MiB. Enormous single-file torrents get *halved* piece sizes. Community practice: **256 KiB – 1 MiB**, scaling to **~1 MiB around 8 GiB total**. Piece size is per-torrent, not per-file. Identical files always produce the same Merkle root, enabling cross-swarm dedup for free.

**Our defaults:** target ~1,500–2,000 pieces; 1 MiB pieces for a 10–50 GB model, 2–4 MiB above 100 GB; emit **hybrid v1+v2 torrents** so we get v2 block-level verification and dedup without stranding v1-only clients.

---

## 3. The Torrent Engine Decision

| Option | Verdict |
|---|---|
| **librqbit** (rqbit) | ✅ **Our choice.** Pure Rust, actively maintained, cross-platform (Win/macOS/Linux). DHT, magnets, **BitTorrent v2/BEP 52 with SHA-256**, streaming with seeking, UPnP port forwarding, HTTP REST API, pause/resume, fastresume, selective download. Ships a `Session` entry point plus an **`Api` facade "useful when building the rqbit desktop app"** — and rqbit already **ships a Tauri desktop app** as a thin wrapper over its web UI. Low memory (tens of MB). |
| **cratetorrent** | ❌ Linux-only, no DHT/magnets, unmaintained, self-described toy. |
| **C++ libtorrent via FFI** | Viable and most battle-tested, but adds C++ build complexity to every CI target. Keep as a **pluggable backend behind a trait** — don't start here. |
| **gosh-dl / ztorrent-core / mtorrent / torro** | Watch list. `ztorrent-core` is notable: built on librqbit as its peer-wire layer, one `Engine::invoke` surface, builds as rlib for native Rust/Tauri *and* staticlib/cdylib for C ABI. Good candidate if we later need a non-Tauri host. |

**Architecture implication:** define a `TorrentEngine` Rust trait with `librqbit` as the first implementation. If librqbit hits a wall (weird tracker, exotic encryption, perf ceiling), we swap in libtorrent-FFI behind the same trait without touching the app.

---

## 4. Desktop Shell

| | **Tauri 2** | **Electron** |
|---|---|---|
| Engine | OS-native webview (WebView2 / WKWebView / WebKitGTK) | Bundled Chromium |
| Backend | Rust | Node.js |
| Bundle | **2–15 MB** | 80–250 MB |
| Idle RAM | **~30–80 MB** | ~120–400 MB |
| Startup | Sub-second | 1–2 s |
| Mobile | ✅ iOS + Android | ❌ |
| Rendering | ⚠️ Varies by platform webview | ✅ Pixel-identical everywhere |
| Ecosystem | Thinner, ~55% YoY repo growth, on 2.11 | Vast, 10+ yrs, growth plateaued |

**Decision: Electron.** Reasons, in order:

1. **The audience inverts the bundle-size argument.** Tauri's headline advantage is 2–15 MB vs. 80–250 MB. But Frost/Byte's users are people moving 60–800 GB model files between rigs. **A 150 MB installer is noise to them.** The usual tradeoff simply doesn't apply here, which makes Electron's advantages close to free.
2. **Pixel-identical rendering everywhere.** One Chromium, one canvas. The design thesis — "the specific LimeWire failure we're correcting is inconsistent rendering across platforms" — is satisfied *by construction* rather than by a test suite chasing three engines.
3. **An entire bug class deleted.** Tauri v2 requires **WebKitGTK 4.1** on Linux, which carries documented real failures: **all-white windows** on Ubuntu 24.04 + NVIDIA (workaround `WEBKIT_DISABLE_DMABUF_RENDERER=1`), **input fields freezing the page** on webkit2gtk 2.46.1 (which would break the search box — the app's most important control), and **title bars that can't be dragged** (which would break our custom chrome). On Windows, Tauri needs **WebView2**, which is *frequently absent in practice on Windows 10* and causes crashes on launch. **All of it disappears with Electron.**
4. **Node in the main process** gives direct access to local model runtimes, filesystem, and LAN discovery — most of what the agent's supervisor does.
5. **Frameless windows on Linux now have rounded corners by default** (Electron 43), which our custom chrome depends on.

**Accepted costs, stated plainly:**
- **~150 MB installers, ~120–400 MB idle RAM.** Irrelevant for this audience, as argued above — but this reasoning does *not* carry over to a future thin/mobile client.
- **The Chromium release treadmill, which for us is a security obligation.** Electron ships **no LTS**, supports only the **latest three majors**, and releases a new major **every 8 weeks** (Electron 40 → EOL Jun 30 2026, 41 → Aug 25 2026, 42 → Oct 20 2026, 43 → Jan 5 2027). For a network application that parses untrusted input and holds long-lived connections to strangers, **shipping an EOL Chromium is not acceptable.** An 8-week release train with auto-update is mandatory infrastructure from Phase 1.
- **No mobile path.** Electron has no iOS/Android, so a phone must be a **separate client** (React Native, or the browser UI against a remote agent). That's fine — the agent's local HTTP API already makes it a client-side job rather than a rewrite.

---

## 5. Identity, Trust & Sybil Resistance

The research on Nostr's identity work is directly applicable and already battle-tested:

- **NIP-XX: Agent Reputation Attestations (kind 30085)** — cryptographically signed reputation attestations with **commitment classes** ranging from `self_assertion` up to `economic_settlement`, **context namespaces** for domain-specific trust, and **temporal decay** with configurable half-life.
- **NIP-91: Agent Trust Attestations** — NIP-32 label vocabulary in the `ai.wot` namespace; **zap-weighted scoring** (NIP-57), recursive trust, temporal decay, and **diversity scoring for Sybil resistance**.
- **NIP-14 Reputation Scheme** — rating events with category scores plus a web-of-trust propagation example.
- **P2Pesa** (Kenya, Bitcoin/mobile-money agents) — **zap-backed reviews**: you *pay* to vouch, so fake reputation is "too expensive for scammers to buy."
- **@powforge** — "depth-of-identity" (DoI) scoring: a story endorsed by 3 long-tenured humans outranks one flooded by 500 fresh bot accounts.

**Synthesis for Frost/Byte:**
- **Identity = an Ed25519 keypair.** No account, no email, no signup. Optionally interoperable with a Nostr key for social features.
- **Trust = a web-of-trust score** over signed attestations, with **temporal decay** and **diversity weighting**, recomputed **locally** by each client — never by a server. Ship the algorithm, not the score.
- **Sybil resistance through cost and age, not gatekeeping.** New identities carry zero trust; trust accrues through tenure + verified seeding + attested outcomes. Weight attestations from long-lived, diverse, mutually-independent keys higher.
- **The honest limits** to design around: cold-start (new good peers look identical to new bad peers) and echo chambers / follow-back gaming. Both get explicit UX treatment — see `03-product-vision.md` §Trust UX.
- **Deliberately NOT in v1: a tradeable crypto token.** See §7.

---

## 6. Provenance & Security — The Part Everyone Skips

### 6.1 Deserialization RCE (the sharpest edge)
Python's `pickle` is a stack-based VM. Opcodes (`GLOBAL`, `STACK_GLOBAL`, `REDUCE`, `BUILD`) let a serialized file **import and invoke arbitrary callables at load time** — so `torch.load()` on a `.pt`/`.bin`/`.pkl` can execute a reverse shell or credential stealer **before it returns**, i.e. code execution *on deserialization*, not at inference. This is **CWE-502** and it's the root of the 2023–2024 malicious-model discoveries on HuggingFace.

- **`safetensors` fixes this by design.** 8-byte header length + JSON metadata (names, dtype, shape, offsets) + contiguous binary. **Zero code execution on load**, zero-copy `mmap`, lazy loading, sharding. It is now the **default checkpoint format on HF Hub** and joined the PyTorch Foundation (April 2026).
- **`picklescan` / `modelscan` are interim tools only.** The **NullifAI** campaign (Feb 2025) bypassed HuggingFace's Picklescan using deliberately "broken" pickle formatting. Scanners are incomplete by construction.
- **PyTorch `weights_only=True`** is a partial fallback — but the **PickleBall** paper found ~15.4% of sampled pickle repos (79.6M monthly downloads) contain models that *can't* use it, forcing users back onto weak scanners.
- **GGUF's residual executable surface:** GGUF weights are safe, but a GGUF can carry a **Jinja2 chat template that executes arbitrary Python expressions.** Chat templates must be treated as **code requiring sandboxing/review**, not as config.

### 6.2 Weight poisoning (orthogonal, and unfixable by hashing)
A backdoored model can carry a **perfectly valid signature**. Signing proves **who published**, never **what went into training**. Research cited: as few as **250 malicious training examples** can backdoor a model. Detection requires provenance, behavioral evaluation against trigger patterns, and data-source controls — not output inspection.

### 6.3 The layered defense we ship
1. **Format policy, enforced:** `safetensors` preferred; **pickle rejected by default** (explicit override buried behind a scary dialog); GGUF allowed with **sandboxed template evaluation**.
2. **Pin + hash:** download by exact revision, record `sha256sum` manifests, verify in every pipeline stage.
3. **OpenSSF Model Signing v1.0** (April 2025; OpenSSF + Sigstore + NVIDIA + HiddenLayer) via the **`model-transparency`** project (`model_signing` CLI + Python library). It signs a **manifest hashing every file** — weights/shards, tokenizer, config, model card, example code — so **swapping the tokenizer fails verification even if weights are untouched.** That's the right granularity.
4. **Keyless signing** via Fulcio (short-lived OIDC-bound cert) + **Rekor** transparency log, verified against a pinned signer identity.
5. **Reproduce it in-app:** the `model_signing verify --identity <publisher OIDC workflow>` pattern is exactly what Frost/Byte should surface as a single "Verified" badge with a details disclosure.
6. **Encryption at rest and in transit** (AES-256), strict access control, audit logging — per the NSA/CISA May 2025 joint advisory.
7. **Bootstrapping adoption:** NVIDIA began signing all NGC models in **March 2025** (first major hub to do so), with TensorRT-LLM and Triton verifying at load time. Google integrated model signing into Kaggle. **The upstream is already doing this — we consume it, we don't invent it.**

---

## 7. Incentives — The Problem That Killed Petals

Petals died of an empty swarm. The research on why is unambiguous.

**Tit-for-tat (BitTorrent's native incentive)** matches your upload rate to peers who upload to you. It works among *leechers* and **fails at the thing we need**: it gives no reason to **keep seeding after your download completes**. Documented "Hit and Run" behavior; the **BitThief** client downloads without uploading anything at all by exploiting *optimistic unchoking*.

**Private trackers' answer** is credit systems + **Share Ratio Enforcement**. It works, but the documented costs are real:
- Communities stay **small** (far smaller than public trackers).
- "**Uploading starvation**" — users who can't upload can't participate.
- **Systemic risk (IEEE TPDS 2013):** credit and ratio policies can cause system-wide **crunches** — the system seizes from too little *or* too much credit. Oversupply (excessively high seeder-to-leecher ratios) causes long seeding times, **low upload capacity utilization**, and unfairness to late entrants. The paper's fix is an **adaptive** credit system that auto-adjusts for sustainability.

**Other mechanisms worth knowing:**
| Mechanism | Idea |
|---|---|
| **Super-seeding** (BitTornado) | Force newcomers to upload received blocks before receiving more |
| **Encrypt-and-forward** (PropShare) | Unchoker encrypts blocks until a newcomer proves cooperation |
| **k-tit-for-tat** | Eliminate optimistic unchoking entirely |
| **LeechLock** (UMD) | Judge clients by **contribution**, not protocol adherence |
| **IPFS BitSwap** | Ledger-based barter credit for block exchange |
| **Tribler "Credit Mining"** (TU Delft) | Private-tracker-like incentive while staying open |

### Our design: **Frost Credits** — non-transferable, adaptive, honest
1. **Non-transferable reputation credits.** Earned by seeding; spent on **queue priority** and **swarm priority** — *never* on access to content. Nothing on the network is paywalled. This is the line that keeps us out of the token/securities swamp and keeps the mission intact.
2. **Adaptive, not fixed.** We implement the IEEE TPDS-style **adaptive** policy: target a healthy seeder-to-leecher band and adjust credit *earn rates* rather than punishing users. Fixed ratios are what cause crunches.
3. **Contribution, not just raw bytes** (the LeechLock lesson): credit for **rare pieces**, for staying online, for long-tail models nobody else seeds, and for verified benchmark results. This is how we specifically reward *preservation* rather than just *popularity*.
4. **Anti-starvation from day one:** asymmetric links, CGNAT, and metered connections must not become second-class. **Webseed fallback** (proven by llama.garden's 77 MB/s) means a user with no upload capacity can still fully participate. Upload *capability* is never a prerequisite for membership.
5. **Deliberately NOT in v1: a tradeable token.** Tribler's own framing is a "blockchain-based token economy," and that framing brings securities questions, scam surface, and the perception problem that poisons public-good projects. **Ship credits as local, non-transferable, protocol-level fairness — revisit only with a legal opinion and real demand.**
6. **The freeloader cut-off stays user-facing** (inherited from LimeWire) — a fairness dial in settings the user controls, default on.

---

## 8. Preservation — The Mission Has Real Precedent Now

This is the emotional and moral core of the product, and it is not hypothetical:

- **Internet Archive Switzerland / Gen AI Archive** — a nonprofit launched **May 5, 2026** in Sankt Gallen to systematically preserve AI models. Reported to have **rescued 2,500 models in its first three months**, using cold storage, **blockchain hashing for integrity**, Docker container snapshots, and **torrents/mirrors for resilience**. Justifying stats it cites: **85% of failed AI startups permanently lose their models** (CB Insights) and **15,000+ sub-7B LLMs lost to storage costs** (EleutherAI audit).
- **HuggingFace Hub deprecation mechanics:** the Hub **does not auto-redirect or auto-deprecate** old repos — topic-prefixed repos "remain discoverable indefinitely." Archived subdirectories **don't free storage quota**, so the recommended path is **separate Hub organizations** for deprecated suites. Practically, deprecation shows up as commit-level notices like *"ARCHIVED / LEGACY MODEL NOTICE"* with quantization variants "permanently removed to manage storage quotas."
- **The irreversibility argument (the Open-Weights Archiving Playbook, on HF Datasets):** archive the **master** (full-precision BF16/FP8), derive quants on demand, because **quantization is lossy and one-way** — "a Q4 can never be turned back into the true master (like RAW vs. JPEG)." Then a maintenance regime: **re-verify checksums** (bit rot), **3-2-1 redundancy** (3 copies, 2 media, 1 off-site), **distinguish replaceable from irreplaceable** (masters are irreplaceable, quants regenerate), keep a **plain-text index**, and **refresh media** every few years.
- **"Retiring a Model with Dignity"** (Part 5 of that series) — the rule that resolves the archive-vs-hoard tension: **you may retire a copy only when the model is safely abundant without you.** If a model is rare, contested, or quietly vanishing, keeping your copy is "a public good, not clutter."
- **Deletion at the source doesn't work anyway:** a 10a Labs arXiv paper (2609.05241) counted **3,471 original "uncensored" open-weight models** on HF between Jan 2024 and Mar 2026, with **8,164 repackaged/redistributed versions** averaging 2.4 repackages each. Once models are quantized and mirrored to other accounts, other formats, or third-party registries like **Ollama**, **upstream deletion cannot stop their circulation.**
- **Practical download constraints:** authenticated HF downloads (anonymous is **HTTP 429**-throttled); use the **Xet backend** and `snapshot_download` for **resumable, hash-verified** pulls.

**What this means for Frost/Byte:** the "Retiring with Dignity" rule is *policy we can implement as product logic*. The agent computes reachability locally — how many rigs offer a model, across how many distinct operators and **ASNs**, for how long — and surfaces **"well covered, safe to stop"** vs. **"single point of failure."** Preservation becomes uptime, not archiving, and it's a live badge rather than a vague virtue. **This is a genuine differentiator.**

**Ingest pipeline we inherit:** `snapshot_download` (Xet, resumable, hash-verified) → verify → build hybrid torrent → seed → announce to catalog. Authenticated token required for HF rate limits.

---

## 9. Making Models Actually Runnable (why download must lead to use)

A downloaded model that isn't runnable is a hoard. The integration surface is settled:

| Runtime | Port | API | Notes |
|---|---|---|---|
| **Ollama** | 11434 | OpenAI-compatible `/v1` | Embeds llama.cpp. MIT. Best API compatibility, lowest overhead, headless-friendly. **Recommended primary target.** |
| **llama.cpp** (`llama-server`) | 8080 | OpenAI-compatible `/v1` | The engine itself. Direct GGUF path: `./llama-server -m model.gguf -c 131072 --n-gpu-layers 35`. |
| **LM Studio** | 1234 | OpenAI-compatible `/v1` | Electron GUI, llama.cpp + MLX on Apple Silicon. |

**Known integration traps to handle:**
- **Ollama has no generic GGUF import.** There is no `ollama import --file model.gguf`; GitHub issue #13760 requested it and a maintainer **closed it** — GGUFs from llama.cpp/LM Studio often use different KV/tensor names than Ollama's model implementations expect, so it **must be handled case-by-case**. The reliable path is a **Modelfile**: `FROM ./model.Q4_K_M.gguf` + `PARAMETER temperature 0.2`, then `ollama create my-model -f Modelfile`.
- **LM Studio has no default model.** The served model ID is whichever GGUF is loaded — **probe with `list_models()` at runtime**, never hardcode.
- **Local runtimes reject shapes hosted APIs accept.** llama.cpp-backed servers return **HTTP 400** for a named `tool_choice` object or `response_format: {"type":"json_object"}`. Small quantized models frequently emit **malformed tool-call arguments**, or put tool calls in `content` instead of `tool_calls`. We need degradation/retry logic and argument normalization.
- **Prior art for the abstraction:** `llmfit` (Rust) implements a unified `ModelProvider` spanning Ollama (daemon API pull), llama.cpp (direct HF GGUF download + local cache), MLX, Docker Model Runner, and LM Studio, with **background-thread polling for progress events** — a good shape to copy. **OpenJet** demonstrates **build-time model provisioning** bundled into the app so nothing downloads at runtime (`airgapped: true` blocks non-loopback endpoints), which is exactly the pattern for our **private-swarm / enterprise** mode.

**Protocol rule:** standardize on **OpenAI-compatible `/v1`** for everything, discover model IDs at runtime, and treat every local runtime as unreliable-by-default.

---

## 10. Benchmarking — What We Would Be Complementing

| Platform | What it is | Our relationship |
|---|---|---|
| **LMArena** (lmarena.ai) | Elo from human pairwise votes, 1M+ votes. Strengths: real human preference on open-ended prompts. Weakness: **rewards style, formatting, and agreeableness** alongside correctness; **vulnerable to gaming**. | **Complement, don't clone.** Pairwise human voting is their moat. |
| **Artificial Analysis** | Daily independent benchmark + market data ("mystery shopper" — runs evals incognito to stop labs gaming private endpoints; **no one pays to be on the leaderboard**). | Model for **independence and anti-gaming**. Their funding model: enterprise subscriptions. |
| **HF Open LLM Leaderboard** | 6 academic benchmarks (IFEval, BBH, MATH, GPQA, MUSR, MMLU-Pro); **the largest auto-evaluation pipeline for open models** — anyone submits, HF runs the evals. Filters by license, param count, model type. | **Closest to what we want** for open models. |
| **LiveBench** | Refreshed monthly to resist contamination. | **The contamination answer** — adopt the refresh cadence. |
| **SWE-bench Verified** | Standard for agentic coding. | Cite, don't rebuild. |
| **HELM** (Stanford) | Academic rigor, fairness/bias, quarterly. | Cite. |
| **OpenRouter Rankings** | What people actually use/pay for. | The "revealed preference" signal — a great *community* counterweight. |

**Consensus guidance across sources:** triangulate rather than trust one leaderboard; **benchmark contamination is pervasive**; rankings compress meaningful differences; labs report selectively. Recommended practice: **build a small private eval set (20–50 examples) for final decisions.**

**That last sentence is our product.** The community hub should let any user run a **reproducible eval** on a model they're seeding, publish the **eval config + raw outputs + hardware spec + seed** as a signed attestation, and let others **re-run and confirm or dispute**. Nobody else in this space does *reproducible community-run* benchmarking tied to *the file you actually downloaded*. That's the differentiator: **not a ranking, a verification record.**

---

## 11. Ten Conclusions

1. **Prior art is fragmented.** Distribution, incentives, trust, and provenance exist separately and nobody has integrated them. Integration + preservation is the thesis.
2. **The empty-swarm problem is the #1 killer.** Any design without a real incentive layer dies. Petals is the cautionary tale.
3. **Hybrid webseed + swarm is mandatory.** llama.garden's 77 MB/s vs. slow UDP torrents settles it. Day-one usability comes from webseeds.
4. **BitTorrent for bytes, DHT/trackers/PEX/magnets for discovery, libp2p optional later.** Don't invent transport.
5. **Hybrid v1+v2 torrents** for block-level verification and dedup without stranding anyone.
6. **librqbit over cratetorrent**, behind a trait so libtorrent-FFI remains swappable.
7. **Electron over Tauri.** Renderer consistency across macOS/Windows/Linux matters more than bundle size for an audience that routinely moves 60–800 GB files.
8. **safetensors only by default; pickle rejected; GGUF templates sandboxed. Sign with OpenSSF Model Signing v1.0.** Signing proves publisher, not behavior — say so plainly in the UI.
9. **Non-transferable adaptive credits, no token in v1**, and never paywall content.
10. **Preservation has real precedent now** (Internet Archive Switzerland, 2,500 models rescued). The "safe to release / keep seeding" abundance badge is a feature nobody has shipped, and it's ours.

---

## Sources

**P2P landscape**
- [Decentralized & P2P Content Protocols in 2026 — ChaosAndOrder](https://www.youngju.dev/transcribe/culture/2026-05-16-decentralized-p2p-content-2026-ipfs-helia-libp2p-bittorrent-v2-webtorrent-hyperdrive-iroh-filecoin-arweave-storacha-deep-dive.en)
- [Peer-to-peer networking examples — Pilot Protocol Blog](https://pilotprotocol.network/blog/peer-to-peer-networking-examples-ai-engineers)
- [Magnet Links vs IPFS — comparison](https://tools.cmdragon.cn/nl/apps/magnet-parser/wiki/vs-ipfs)
- [seeder/RESEARCH.md — GitHub](https://github.com/zemse/seeder/blob/main/RESEARCH.md)
- [DHT协议如何成为去中心化网络基石 — CSDN](https://blog.csdn.net/weixin_32430941/article/details/161733164)

**BitTorrent internals**
- [libtorrent blog — "BitTorrent v2"](https://blog.libtorrent.org/2020/09/bittorrent-v2/)
- [BEP 52 — BitTorrent v2](https://bittorrent.org/beps/bep_0052.html) and `bep_0052_torrent_creator.py`
- [libtorrent repo — features.rst, Discussion #7604](https://github.com/arvidn/libtorrent)
- Transmission `makemeta.c` → `bestPieceSize()`
- Stack Overflow — "Is there a provably optimal block (piece) size for torrents?"

**Engines & shells**
- [librqbit / rqbit README](https://docs.rs/crate/rqbit/5.6.4/source/README.md) · [rqbit architecture — DeepWiki](https://deepwiki.com/ikatson/rqbit)
- [cratetorrent docs](https://docs.rs/cratetorrent/latest/cratetorrent/index.html) · [cratetorrent repo](https://github.com/vimpunk/cratetorrent)

**LLM-P2P prior art**
- [llama.garden — etemiz/llama.garden](https://github.com/etemiz/llama.garden)
- [zest — praveer13/zest](https://github.com/praveer13/zest)
- [from-hf-to-torrent — premAI-io](https://github.com/premAI-io/from-hf-to-torrent)
- [LlamaTor — Nondzu](https://github.com/Nondzu/LlamaTor) · Hugging Bay (huggingbay.xyz) · aitorrent (HF org)
- Grok-1 official magnet link (xai-org model card)

**Identity & trust**
- [NIP-XX: Agent Reputation Attestations — nostr-protocol/nips PR #2320](https://github.com/nostr-protocol/nips/pull/2320)
- [NIP-91: Agent Trust Attestations — PR #2206](https://github.com/nostr-protocol/nips/pull/2206)
- [NIP-14: Reputation Scheme](https://github.com/nostr-protocol/nostr/blob/994314b4cea6cbb1eef09b175c4b02bc7fab088e/nips/14.md)
- [P2Pesa — Devpost](https://devpost.com/software/p2pesa)

**Security & provenance**
- OpenSSF **Model Signing v1.0** (April 2025); [`sigstore/model-transparency`](https://github.com/sigstore/model-transparency)
- **PickleBall** paper (Semantic Scholar) · Cloud Security Alliance — model poisoning in self-hosted LLM deployments
- Safeguard.sh — "Model Weights as Supply Chain Artifacts" · Open CSAI Wiki — model file formats & malicious model files
- Google Project Zero / NullifAI reporting on Picklescan bypass

**Incentives**
- IEEE TPDS 2013 — "Systemic Risk and User-Level Performance in Private P2P Communities"
- IEEE 2010 — "Measurements, Analysis and Modeling of Private Trackers" · IEEE 2021 — "Share-Ratio-Based Incentive Mechanism"
- Tribler "Credit Mining" (TU Delft) · PropShare / LeechLock / BitThief literature

**Preservation**
- [Open-Weights Archiving Playbook](https://huggingface.co/datasets/AXOlotlvaNschmozelot/open-weights-archiving-playbook) (HF Datasets), incl. "Retiring a Model with Dignity"
- 10a Labs, arXiv 2609.05241 — uncensored open-weight ecosystem census
- Internet Archive Switzerland / Gen AI Archive (launched May 5, 2026, Sankt Gallen)
- CB Insights (85% of failed AI startups lose models); EleutherAI audit (15,000+ sub-7B LLMs lost)

**Benchmarking**
- [LMArena](https://lmarena.ai) · [Artificial Analysis](https://artificialanalysis.ai) · [HF Open LLM Leaderboard](https://huggingface.co/spaces/open-llm-leaderboard)
