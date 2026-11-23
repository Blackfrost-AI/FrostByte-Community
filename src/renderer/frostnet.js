// FrostNet recipe search + publish panel (P2 share loop).
//
// Recipes are signed, NON-EXECUTABLE serving manifests shared by the community
// (platform/functions recipe plane, schema `frostbyte.recipe` v2). Search is
// token-based: quant tokens match EXACT CASE (Q4_K_M never matches q4_k_m —
// decision D12); format matches the file extension; q is a case-insensitive
// substring over title/description/repoId/paths. Publishing signs with the
// session-unlocked publisher identity in the MAIN process — the renderer never
// sees key material or a signature. Nothing here executes a recipe.
//
// Wire shapes (verified against platform/functions/src/recipes.js + hub-client):
//   hubSearch  -> { ok, data: { items: [head], nextCursor } }
//   hubRecipe  -> { ok, data: { head:{id,currentVersion}, digest, manifest,
//                               signature, status, provenance:{publisher,handle,...} } }
//   head       = { id, digest, publisher, title, kind, description, license,
//                  currentVersion, publishedAt, updatedAt, withdrawnAt, ... }
//   manifest   = { schema:'frostbyte.recipe', version:2, id, title, kind,
//                  publisher, files:[{path,size,sha256}], license:{id,statement},
//                  createdAt, modelRef?:{repoId,revision,variant},
//                  session?, argv?, container?, image?, ... }

const RECIPE_ID_RE = /^[a-z0-9-]{1,64}$/;
const KIND_LABEL = { tmux: 'tmux session', docker: 'Docker', compose: 'Compose', native: 'Native' };

export function createFrostnet({ api, getState, esc, toast, fmtBytes, askModal, goTab }) {
  const $ = (value) => document.querySelector(value);
  let results = [];
  let cursor = null;
  let busy = false;
  let selected = null;
  let publishBusy = false;
  let seq = 0;

  function setStatus(text, isBusy = false) {
    const el = $('#fn-status');
    if (el) { el.textContent = text; el.classList.toggle('busy', isBusy); }
  }

  function filters() {
    return {
      q: $('#hf-q')?.value.trim() || '',
      quant: $('#fn-quant')?.value.trim() || '',
      format: $('#fn-format')?.value || '',
      kind: $('#fn-kind')?.value || '',
    };
  }

  async function search(nextCursor = null) {
    if (busy) return;
    busy = true;
    const mySeq = ++seq;
    setStatus(nextCursor ? 'Loading more…' : 'Searching FrostNet…', true);
    try {
      const res = await api.hubSearch({ ...filters(), cursor: nextCursor });
      if (mySeq !== seq) return; // a newer search superseded this one
      if (!res.ok) {
        if (!nextCursor) { results = []; cursor = null; render(); }
        setStatus(res.code === 'hub_not_configured'
          ? 'FrostNet is not configured on this device.'
          : res.code === 'hub_unavailable'
            ? 'FrostNet is unreachable. Check your connection (Settings → FrostNet account).'
            : `Search failed: ${res.error ?? res.code}`);
        return;
      }
      const rows = Array.isArray(res.data?.items) ? res.data.items : [];
      results = nextCursor ? [...results, ...rows] : rows;
      cursor = res.data?.nextCursor ?? null;
      render();
      setStatus(results.length
        ? `${results.length} recipe${results.length === 1 ? '' : 's'}${cursor ? ' · more available' : ''}`
        : 'No recipes matched. Try a name, a quant (exact case), or a format.');
    } finally {
      busy = false;
    }
  }

  function render() {
    const tbody = $('#grid-fn tbody');
    if (!tbody) return;
    tbody.innerHTML = results.map((row) => `<tr tabindex="0" data-fn-id="${esc(row.id)}" aria-selected="${selected === row.id}">
      <td><div class="repo">${esc(row.title || row.id)}</div><div class="repo-sub">${esc(row.description || '')}</div></td>
      <td>${esc(KIND_LABEL[row.kind] || row.kind || '—')}</td>
      <td>${esc(row.license || '—')}</td>
      <td class="mono" title="${esc(row.publisher || '')}">${esc(String(row.publisher || '').slice(0, 12))}…</td>
      <td>${esc(row.updatedAt ? new Date(row.updatedAt).toLocaleDateString() : '—')}</td>
    </tr>`).join('');
    const empty = $('#empty-fn'); if (empty) empty.hidden = results.length > 0;
    const grid = $('#grid-fn'); if (grid) grid.hidden = results.length === 0;
    const pag = $('#fn-pagination'); if (pag) pag.hidden = !cursor;
    if (selected && !results.some((r) => r.id === selected)) closeDetail();
  }

  async function openDetail(id) {
    selected = id;
    render();
    const panel = $('#fn-detail');
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = '<p class="hint">Loading recipe…</p>';
    const res = await api.hubRecipe({ id });
    if (selected !== id) return; // user moved on
    if (!res.ok) {
      panel.innerHTML = `<div class="hf-head"><div class="hf-detail-title"><h3>${esc(id)}</h3><button class="btn sm hf-detail-close" data-fn-close aria-label="Close">✕</button></div></div>
        <div class="hf-detail-body fn-body"><p class="hint">${res.code === 'hub_withdrawn'
          ? 'This recipe was withdrawn by its publisher. Files already downloaded remain verifiable against their digests.'
          : `Could not load recipe: ${esc(res.error ?? res.code)}`}</p></div>`;
      return;
    }
    const data = res.data || {};
    const m = data.manifest || {};
    const prov = data.provenance || {};
    const files = (m.files || []).map((f) =>
      `<li class="mono">${esc(f.path)} · ${esc(fmtBytes(f.size))}</li>`).join('');
    const serve = serveSummary(m);
    const mine = isMine(m);
    panel.innerHTML = `
      <div class="hf-head">
        <div class="hf-detail-title"><h3>${esc(m.title || id)}</h3><button class="btn sm hf-detail-close" data-fn-close aria-label="Close">✕</button></div>
        <div class="hf-meta"><span class="mono">${esc(id)}</span><span>v${esc(data.head?.currentVersion ?? 1)}</span></div>
      </div>
      <div class="hf-detail-body fn-body">
        ${m.description ? `<p class="hint">${esc(m.description)}</p>` : ''}
        <div class="fn-kv">
          <div class="kv"><span class="k">Kind</span><span class="v">${esc(KIND_LABEL[m.kind] || m.kind || '—')}</span></div>
          <div class="kv"><span class="k">Model</span><span class="v">${esc(m.modelRef?.repoId || '—')}${m.modelRef?.variant ? ` · ${esc(m.modelRef.variant)}` : ''}</span></div>
          <div class="kv"><span class="k">License</span><span class="v">${esc(m.license?.id || 'unspecified')}</span></div>
          <div class="kv"><span class="k">Publisher</span><span class="v" title="${esc(m.publisher || '')}">${esc(prov.handle ? '@' + prov.handle + ' · ' : '')}${esc(String(m.publisher || '').slice(0, 16))}…</span></div>
          <div class="kv"><span class="k">Digest</span><span class="v fn-digest">${esc(data.digest || '')}</span></div>
        </div>
        ${serve ? `<h4>How it serves</h4><pre class="fn-serve mono">${esc(serve)}</pre>` : ''}
        <h4>Files (${(m.files || []).length})</h4><ul class="fn-files">${files || '<li>—</li>'}</ul>
        <div class="fn-actions">
          <button class="btn sm primary" id="btn-fn-download">Download model files</button>
          <button class="btn sm" id="btn-fn-copy">Copy recipe JSON</button>
          ${mine ? '<button class="btn sm danger" id="btn-fn-withdraw">Withdraw</button>' : ''}
        </div>
        <p class="hint">Recipes are instructions, not code — FrostByte never auto-executes them. Review before using. Model files download from their original Hugging Face repos through the normal pipeline.</p>
      </div>`;
    $('#btn-fn-download')?.addEventListener('click', () => downloadFiles(m));
    $('#btn-fn-copy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(m, null, 2)); toast('Recipe JSON copied.'); }
      catch { toast('Clipboard unavailable.', 'warn'); }
    });
    $('#btn-fn-withdraw')?.addEventListener('click', () => withdraw(id, m.title || id));
  }

  function serveSummary(m) {
    if (m.kind === 'tmux' && Array.isArray(m.argv)) {
      return `${m.session ? `tmux session: ${m.session}\n` : ''}${m.argv.join(' ')}`;
    }
    if ((m.kind === 'docker' || m.kind === 'compose') && m.container) {
      return `container: ${m.container}${m.image ? `\nimage: ${m.image}` : ''}${m.composeFile ? `\ncompose: ${m.composeFile}` : ''}`;
    }
    return '';
  }

  function closeDetail() {
    selected = null;
    const panel = $('#fn-detail');
    if (panel) { panel.hidden = true; panel.innerHTML = ''; }
    render();
  }

  function isMine(manifest) {
    const pub = getState().publisher ?? {};
    return !!pub.pubKey && manifest?.publisher === pub.pubKey;
  }

  async function downloadFiles(manifest) {
    const repoId = manifest?.modelRef?.repoId;
    const revision = manifest?.modelRef?.revision;
    const recipeFiles = manifest?.files || [];
    const paths = new Set(recipeFiles.map((f) => f.path));
    if (!repoId || !paths.size) { toast('This recipe has no downloadable model files.', 'warn'); return; }
    if (!revision || !/^[a-f0-9]{40}$/.test(revision)) { toast('This recipe does not pin a valid model revision, so its files cannot be downloaded safely.', 'warn'); return; }
    // Fetch pinned file metadata (size + LFS sha256) from the Hub, then queue
    // only the files the recipe lists. The normal download review gate applies.
    const info = await api.hfModel(repoId, revision);
    if (!info.ok) { toast(`Could not read model metadata: ${info.error ?? info.code}`, 'warn'); return; }
    if (info.data?.cancelled) return;
    const sel = (info.data?.files || []).filter((f) => paths.has(f.path));
    if (!sel.length) { toast('None of the recipe files were found in the model repo.', 'warn'); return; }
    // Integrity cross-check: the recipe pins a SHA-256 per file (grounded to
    // the publisher's local bytes at publish time). The Hub serves the original
    // repo bytes. If both hashes exist and differ, the recipe describes bytes
    // that are NOT what the Hub will deliver — warn rather than silently
    // downloading something the recipe's digest cannot verify.
    const recipeHash = new Map(recipeFiles.map((f) => [f.path, f.sha256]));
    const mismatched = sel.filter((f) => {
      const rh = recipeHash.get(f.path);
      return rh && f.sha256 && rh !== f.sha256;
    });
    if (mismatched.length) {
      const ok = await askModal('Recipe hash mismatch',
        `${mismatched.length} file${mismatched.length === 1 ? '' : 's'} in this recipe ${mismatched.length === 1 ? 'has a SHA-256 that differs' : 'have SHA-256s that differ'} from the current Hugging Face repo. The recipe may describe modified files. Download the original repo bytes anyway?`,
        { yes: 'Download anyway' });
      if (!ok) return;
    }
    const res = await api.hfDownload({ repoId, revision, files: sel, source: 'hf' });
    if (res.ok && !res.data?.cancelled) {
      toast(`Queued ${sel.length} file${sel.length === 1 ? '' : 's'} from the recipe.`);
      goTab?.('transfers');
    } else if (!res.ok) toast(`Download failed: ${res.error ?? res.code}`, 'warn');
  }

  async function withdraw(id, title) {
    const ok = await askModal(`Withdraw "${title}"?`,
      'It becomes unavailable to everyone (tombstoned). Files already downloaded stay verifiable. This cannot be undone.',
      { yes: 'Withdraw recipe' });
    if (!ok) return;
    const res = await api.hubWithdraw(id);
    if (res.ok) { toast('Recipe withdrawn.'); closeDetail(); search(); }
    else toast(`Withdraw failed: ${res.error ?? res.code}`, 'warn');
  }

  // ---- Publish flow -------------------------------------------------------
  // Draft a recipe from a completed download. The user picks kind + serve
  // details; the MAIN process validates + signs (hub:publish). The normalized
  // draft is shown for review before anything is signed or sent.
  function publishGate() {
    const s = getState();
    const pub = s.publisher ?? {};
    const acct = s.hubAccount ?? {};
    if (!pub.present) return 'Create a publisher identity first (Settings → Publisher).';
    if (pub.invalid) return 'The saved publisher identity cannot be read. Restore it under Settings → Publisher.';
    if (!pub.unlocked) return 'Unlock your publisher identity first (Settings → Publisher).';
    if (!acct.signedIn) return 'Sign in to your FrostByte account first (top-right account chip).';
    const bound = Array.isArray(acct.publisherKeys) ? acct.publisherKeys.filter((k) => k && !k.unboundAt) : [];
    if (!bound.some((k) => k.pubKey === pub.pubKey)) return 'Bind this device’s publisher key to your account first (Settings → FrostNet account).';
    return '';
  }

  function completedDownloads() {
    return (getState().downloads ?? []).filter((d) => d.status === 'done' && d.repoId && d.filePath);
  }

  function openPublish() {
    const gate = publishGate();
    if (gate) { toast(gate, 'warn'); return; }
    const panel = $('#fn-publish');
    if (!panel) return;
    closeDetail();
    const downloads = completedDownloads();
    // Group completed files by repo so one recipe can cover a whole model.
    const byRepo = new Map();
    for (const d of downloads) {
      if (!byRepo.has(d.repoId)) byRepo.set(d.repoId, { repoId: d.repoId, revision: d.revision, files: [] });
      byRepo.get(d.repoId).files.push(d);
    }
    const repos = [...byRepo.values()];
    const options = repos.map((r) => `<option value="${esc(r.repoId)}">${esc(r.repoId)} · ${r.files.length} file${r.files.length === 1 ? '' : 's'}</option>`).join('');
    const pub = getState().publisher ?? {};
    panel.innerHTML = `
      <div class="hf-head">
        <div class="hf-detail-title"><h3>Publish a serving recipe</h3><button class="btn sm hf-detail-close" id="btn-fn-pub-cancel" aria-label="Close">✕</button></div>
      </div>
      <div class="hf-detail-body fn-body fn-pub-body">
        <p class="hint">Share how you serve a model you've downloaded. Signed with your publisher key (${esc(pub.fingerprint || '')}). A recipe is a manifest — never executable code.</p>
        <label>Downloaded model<select id="fn-pub-repo">${options || '<option value="">No completed downloads</option>'}</select></label>
        <label>Recipe id<input id="fn-pub-id" placeholder="qwen3-8b-q4-k-m-llamacpp" maxlength="64" spellcheck="false" /><span class="hint">Lowercase letters, numbers, hyphens. Permanent.</span></label>
        <label>Title<input id="fn-pub-title" placeholder="Qwen3-8B Q4_K_M · llama.cpp tmux" maxlength="120" /></label>
        <label>Description<textarea id="fn-pub-desc" rows="3" maxlength="4000" placeholder="How you run it: engine, flags, context, hardware notes…"></textarea></label>
        <label>Kind<select id="fn-pub-kind">
          <option value="tmux">tmux session</option>
          <option value="docker">Docker container</option>
          <option value="compose">Compose</option>
          <option value="native">Native</option>
        </select></label>
        <div id="fn-pub-kindfields"></div>
        <label>License id<input id="fn-pub-license" placeholder="apache-2.0 (must match the model's license)" maxlength="100" /></label>
        <label class="fn-terms"><input type="checkbox" id="fn-pub-terms" /> I have the right to share this recipe, it contains no secrets or private data, and I accept the FrostNet publishing terms.</label>
        <div class="fn-actions">
          <button class="btn sm primary" id="btn-fn-pub-review">Review &amp; sign</button>
        </div>
        <div id="fn-pub-preview" hidden></div>
      </div>`;
    panel.hidden = false;
    renderKindFields();
    $('#fn-pub-kind')?.addEventListener('change', renderKindFields);
    $('#fn-pub-repo')?.addEventListener('change', prefillFromRepo);
    $('#btn-fn-pub-cancel')?.addEventListener('click', closePublish);
    $('#btn-fn-pub-review')?.addEventListener('click', reviewAndSign);
    prefillFromRepo();
  }

  function renderKindFields() {
    const kind = $('#fn-pub-kind')?.value || 'tmux';
    const box = $('#fn-pub-kindfields');
    if (!box) return;
    if (kind === 'tmux') {
      box.innerHTML = `
        <label>tmux session name<input id="fn-pub-session" placeholder="qwen3-serve" maxlength="64" /></label>
        <label>Command (argv)<textarea id="fn-pub-argv" rows="3" placeholder="llama-server -m /models/qwen3-q4_k_m.gguf --host 0.0.0.0 --port 8080 -ngl 99"></textarea><span class="hint">The serve command, split into arguments. Never executed by FrostByte.</span></label>`;
    } else if (kind === 'docker' || kind === 'compose') {
      box.innerHTML = `
        <label>Container name<input id="fn-pub-container" placeholder="frostbyte-vllm-qwen3" maxlength="64" /></label>
        <label>Image<input id="fn-pub-image" placeholder="vllm/vllm-openai:latest" maxlength="512" /></label>
        ${kind === 'compose' ? '<label>Compose file<input id="fn-pub-compose" placeholder="compose.yaml" maxlength="256" /></label>' : ''}`;
    } else {
      box.innerHTML = '<p class="hint">Native recipes carry the file list and model reference; add run notes in the description.</p>';
    }
  }

  function prefillFromRepo() {
    const repoId = $('#fn-pub-repo')?.value;
    if (!repoId) return;
    const downloads = completedDownloads().filter((d) => d.repoId === repoId);
    const slug = repoId.split('/')[1]?.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'model';
    const idEl = $('#fn-pub-id'); if (idEl && !idEl.value) idEl.value = `${slug}-recipe`.slice(0, 64);
    const titleEl = $('#fn-pub-title'); if (titleEl && !titleEl.value) titleEl.value = repoId;
    // Suggest a serve command from the bundled registry (offline, copy-only).
    const gguf = downloads.find((d) => /\.gguf$/i.test(d.filePath));
    const argvEl = $('#fn-pub-argv');
    if (argvEl && !argvEl.value && gguf) {
      argvEl.value = `llama-server -m ${gguf.filePath} --host 0.0.0.0 --port 8080 -ngl 99`;
      const sess = $('#fn-pub-session'); if (sess && !sess.value) sess.value = `${slug}-serve`.slice(0, 64);
    }
  }

  function closePublish() {
    const panel = $('#fn-publish');
    if (panel) { panel.hidden = true; panel.innerHTML = ''; }
    publishBusy = false;
  }

  function buildDraft() {
    const s = getState();
    const repoId = $('#fn-pub-repo')?.value;
    if (!repoId) throw new Error('Pick a downloaded model.');
    const downloads = completedDownloads().filter((d) => d.repoId === repoId);
    if (!downloads.length) throw new Error('No completed files for that model.');
    const revision = downloads[0].revision;
    if (!revision || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('These downloads do not pin a Hugging Face revision.');
    const id = $('#fn-pub-id')?.value.trim();
    if (!RECIPE_ID_RE.test(id || '')) throw new Error('Recipe id must be lowercase letters, numbers, or hyphens (1–64).');
    const title = $('#fn-pub-title')?.value.trim();
    if (!title) throw new Error('Give the recipe a title.');
    const kind = $('#fn-pub-kind')?.value || 'tmux';
    const licenseId = $('#fn-pub-license')?.value.trim();
    if (!licenseId) throw new Error('A license id is required (e.g. apache-2.0).');
    // Files: path + size from the verified download records. SHA-256 is
    // recomputed from the actual local bytes by the MAIN process at publish
    // time (the renderer's hash claims are never trusted), so we send a
    // placeholder here and let main ground it. Non-LFS files and restored
    // records may have no Hub SHA-256 — main handles that by hashing disk.
    const files = downloads.map((d) => {
      if (!Number.isSafeInteger(d.total) || d.total < 0) throw new Error(`Missing size for ${d.filePath}.`);
      return { path: d.filePath, size: d.total, sha256: d.sha256 || '0'.repeat(64) };
    });
    const draft = {
      schema: 'frostbyte.recipe',
      version: 2,
      id,
      title,
      kind,
      publisher: s.publisher.pubKey,
      files,
      license: { id: licenseId },
      modelRef: { repoId, revision },
      createdAt: new Date().toISOString(),
    };
    const description = $('#fn-pub-desc')?.value.trim();
    if (description) draft.description = description;
    if (kind === 'tmux') {
      const session = $('#fn-pub-session')?.value.trim();
      if (!session || !/^[A-Za-z0-9._-]{1,64}$/.test(session)) throw new Error('A valid tmux session name is required.');
      const argv = ($('#fn-pub-argv')?.value || '').split(/\s+/).map((x) => x.trim()).filter(Boolean);
      if (!argv.length || argv.length > 64) throw new Error('Provide the serve command (1–64 arguments).');
      draft.session = session;
      draft.argv = argv;
    } else if (kind === 'docker' || kind === 'compose') {
      const container = $('#fn-pub-container')?.value.trim();
      if (!container || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(container)) throw new Error('A valid container name is required.');
      draft.container = container;
      const image = $('#fn-pub-image')?.value.trim();
      if (image) draft.image = image;
      if (kind === 'compose') {
        const composeFile = $('#fn-pub-compose')?.value.trim();
        if (composeFile) draft.composeFile = composeFile;
      }
    }
    return draft;
  }

  async function reviewAndSign() {
    if (publishBusy) return;
    if (!$('#fn-pub-terms')?.checked) { toast('Accept the publishing terms first.', 'warn'); return; }
    let draft;
    try { draft = buildDraft(); }
    catch (err) { toast(String(err.message ?? err), 'warn'); return; }
    publishBusy = true;
    const preview = $('#fn-pub-preview');
    // The preview shows the draft as the user entered it. SHA-256 values are
    // recomputed from the actual local files by the main process at sign time,
    // so the placeholder zeros here are NOT what gets signed or published.
    const previewDraft = { ...draft, files: draft.files.map((f) => ({ ...f, sha256: '(recomputed from your local file at sign time)' })) };
    preview.innerHTML = `<h4>Review before signing</h4>
      <p class="hint">This manifest will be signed with your publisher key and published. FrostByte re-reads each file from disk to confirm its size and SHA-256 before signing. Check the files, command, and license.</p>
      <pre class="fn-preview mono">${esc(JSON.stringify(previewDraft, null, 2))}</pre>
      <div class="fn-actions"><button class="btn sm primary" id="btn-fn-pub-confirm">Sign &amp; publish</button></div>`;
    preview.hidden = false;
    $('#btn-fn-pub-confirm')?.addEventListener('click', async () => {
      const res = await api.hubPublish(draft);
      publishBusy = false;
      if (res.ok) {
        toast(`Published "${draft.title}".`);
        closePublish();
        search();
      } else {
        toast(`Publish failed: ${res.error ?? res.code}`, 'warn');
      }
    }, { once: true });
  }

  function wire() {
    $('#fn-apply')?.addEventListener('click', () => search());
    $('#fn-more')?.addEventListener('click', () => cursor && search(cursor));
    $('#btn-fn-publish')?.addEventListener('click', openPublish);
    $('#fn-quant')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    $('#grid-fn tbody')?.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-fn-id]');
      if (tr) openDetail(tr.dataset.fnId);
    });
    $('#grid-fn tbody')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tr = e.target.closest('tr[data-fn-id]');
      if (tr) { e.preventDefault(); openDetail(tr.dataset.fnId); }
    });
    $('#fn-detail')?.addEventListener('click', (e) => {
      if (e.target.closest('[data-fn-close]')) closeDetail();
    });
  }

  return { wire, search, openPublish, closePublish, closeDetail, render };
}