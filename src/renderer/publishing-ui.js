const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function bindPublishing({ api, getState, refresh, openModal, closeModal, toast, fmtBytes }) {
  const $ = selector => document.querySelector(selector);
  const run = async task => { try { const result = await task(); if (!result.ok) throw new Error(result.error); await refresh(); return result.data; } catch (error) { toast(error.message, 'error'); return null; } };
  const release = row => {
    const { manifest, digest } = row;
    openModal({ title: manifest.name, sub: `${manifest.publisher} / ${manifest.release} / ${manifest.variant} · verified ${new Date(manifest.verified_at).toLocaleString()}`,
      body: `<p>${esc(manifest.description)}</p><p>License: ${esc(manifest.license.id)} · ${esc(manifest.origin)}</p><p>${esc(manifest.license.statement)}</p><p class="inventory-path">Manifest SHA-256: ${esc(digest)}</p>${manifest.cid ? `<p class="inventory-path">IPFS CID: ${esc(manifest.cid)}</p>` : ''}<p class="hint">Frostnet receives this metadata and ${manifest.cid ? 'its magnet and IPFS links' : 'magnet'} only. No weights are uploaded. Sharing and peer availability are separate.</p><div class="release-file-list">${manifest.files.map(file => `<article><strong>${esc(file.path)}</strong><span>${fmtBytes(file.size)}</span><code>${esc(file.sha256)}</code></article>`).join('')}</div>`,
      actions: [{ label: 'Back', kind: 'btn', onClick: dashboard }, { label: 'Export manifest', kind: 'btn', onClick: () => run(() => api.exportRelease(digest)) },
        { label: 'Publish to Frostnet…', kind: 'btn primary', onClick: async () => { const result = await run(() => api.submitRelease(digest)); if (result && !result.cancelled) dashboard(); } }] });
  };
  const connect = () => {
    openModal({ title: 'Connect Frostnet', sub: 'Use a Frostnet-scoped publishing token. Your Hugging Face token does not grant directory publishing access.',
      body: '<label class="field">Destination<select id="publish-origin"><option>https://frostnet-si.web.app</option><option>https://frostnet.si</option></select></label><label class="field">Frostnet publishing token<input type="password" id="publish-token" autocomplete="off" spellcheck="false" placeholder="fn_…" /></label><p class="hint">The token is protected by your OS credential store. Nothing is published just by connecting.</p>',
      actions: [{ label: 'Cancel', kind: 'btn' }, { label: 'Connect…', kind: 'btn primary', onClick: async () => {
        const token = $('#publish-token').value; $('#publish-token').value = '';
        const result = await run(() => api.connectFrostnet({ origin: $('#publish-origin').value, token })); if (result && !result.cancelled) dashboard();
      } }] });
  };
  function dashboard() {
    const state = getState(), publishing = state.publishing || {}, jobs = publishing.jobs || [], releases = publishing.releases || [];
    openModal({ title: 'Publishing & connections', sub: 'Manual publication only. Saving a credential or switching Sharing on does not publish a release.',
      body: `<div class="connection-summary"><p>Hugging Face: ${state.hfUser ? esc(state.hfUser) : 'optional download connection'} · downloads, not Frostnet publishing</p><p>Frostnet: ${publishing.connection ? esc(publishing.connection.account + ' · ' + publishing.connection.origin) : 'not connected'} <button class="btn sm" id="frostnet-connect">${publishing.connection ? 'Replace connection' : 'Connect…'}</button>${publishing.connection ? ' <button class="btn sm" id="frostnet-disconnect">Disconnect</button>' : ''}</p><p>Pirate Face: phase 5 · dedicated Community key required</p><p>Hugging Bay: phase 6 · separate publisher approval</p></div><h3>Release drafts</h3><div class="recovery-list">${releases.map((row, i) => `<article><strong>${esc(row.manifest.name)}</strong><p>${esc(row.manifest.release)} / ${esc(row.manifest.variant)}</p><button class="btn sm" data-release="${i}">Review manifest</button></article>`).join('') || '<p>Choose Options → Prepare release on a local model to start. Create its magnet link first.</p>'}</div><h3>Destination activity</h3><div class="recovery-list">${jobs.map((job, i) => `<article><strong>${esc(job.destination)} · ${esc(job.status)}</strong><p class="inventory-path">${esc(job.digest)}</p><p>${esc(job.error)}</p>${job.receipt?.url ? `<button class="btn sm" data-receipt="${i}">Open receipt</button>` : ''}${job.status === 'published' ? `<button class="btn sm" data-withdraw="${i}">Withdraw…</button>` : ['retryable error', 'needs connection'].includes(job.status) ? `<button class="btn sm" data-retry="${i}">Retry / reconcile</button>` : ''}</article>`).join('') || '<p>No submissions yet.</p>'}</div>`,
      actions: [{ label: 'Done', kind: 'btn', onClick: closeModal }, { label: 'Import manifest', kind: 'btn', onClick: async () => { const result = await run(() => api.importRelease()); if (result && !result.cancelled) dashboard(); } }, { label: 'Refresh', kind: 'btn', onClick: async () => { await refresh(); dashboard(); } }],
      onMount: () => {
        $('#frostnet-connect').onclick = connect;
        if ($('#frostnet-disconnect')) $('#frostnet-disconnect').onclick = async () => { if (await run(() => api.disconnectFrostnet())) dashboard(); };
        for (const button of document.querySelectorAll('[data-release]')) button.onclick = () => release(releases[Number(button.dataset.release)]);
        for (const button of document.querySelectorAll('[data-withdraw]')) button.onclick = async () => { if (await run(() => api.submitRelease(jobs[Number(button.dataset.withdraw)].digest, true))) dashboard(); };
        for (const button of document.querySelectorAll('[data-retry]')) button.onclick = async () => { if (await run(() => api.retryPublication(jobs[Number(button.dataset.retry)].id))) dashboard(); };
        for (const button of document.querySelectorAll('[data-receipt]')) button.onclick = () => api.openExternal(jobs[Number(button.dataset.receipt)].receipt.url);
      } });
  }
  const prepare = entry => {
    const account = getState().publishing?.connection?.account || 'blackfrost';
    openModal({ title: 'Prepare a release', sub: 'Hash and verify this exact local copy against its retained torrent. A changed file must become a new release.',
      body: `<p class="inventory-path">${esc(entry.path)}</p><label class="field">Public name<input id="release-name" value="${esc(entry.name)}" maxlength="200" /></label><label class="field">Publisher namespace<input id="release-publisher" value="${esc(account)}" maxlength="96" /></label><label class="field">Immutable release ID<input id="release-id" placeholder="blackfrost-model-v1" maxlength="96" /></label><label class="field">Variant ID<input id="release-variant" placeholder="gguf-q4-k-m" maxlength="96" /></label><label class="field">Description<textarea id="release-description" maxlength="4000"></textarea></label><label class="field">License ID<input id="release-license" placeholder="Apache-2.0" maxlength="100" /></label><label class="field">Public license evidence URL (optional for original work)<input id="release-evidence" type="url" placeholder="https://…" /></label><label class="field">Redistribution evidence / statement<textarea id="release-statement" maxlength="2000" placeholder="Explain the license or your authority to redistribute these exact files."></textarea></label><label><input id="release-rights" type="checkbox" /> These files are public, not gated or confidential, and I have permission to redistribute them.</label><p id="release-progress" role="status"></p><button class="btn sm" id="release-cancel" hidden>Cancel verification</button>`,
      actions: [{ label: 'Cancel', kind: 'btn' }, { label: 'Verify & preview', kind: 'btn primary', onClick: async () => {
        const button = $('#modal-acts .primary'); button.disabled = true; $('#release-progress').textContent = 'Verifying SHA-256 and torrent piece hashes…'; $('#release-cancel').hidden = false;
        const result = await run(() => api.previewRelease({ id: entry.id, name: $('#release-name').value, publisher: $('#release-publisher').value, release: $('#release-id').value, variant: $('#release-variant').value, description: $('#release-description').value,
          license: { id: $('#release-license').value, evidence_url: $('#release-evidence').value, statement: $('#release-statement').value }, redistribution_confirmed: $('#release-rights').checked }));
        if (result?.manifest) release(result); else if ($('#release-progress')) { button.disabled = false; $('#release-progress').textContent = 'Verification did not finish. Review the error and retry.'; $('#release-cancel').hidden = true; }
      } }], onMount: () => { $('#release-cancel').onclick = () => api.cancelReleasePreview(); }, onDismiss: () => api.cancelReleasePreview() });
  };
  const button = document.createElement('button'); button.className = 'btn sm'; button.textContent = 'Publishing & connections'; button.onclick = dashboard; $('#view-library .library-toolbar').append(button);
  return { prepare, dashboard };
}
