import { classifyFilename } from '../shared/format-hints.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const isIpfsInput = value => /^(?:ipfs:\/\/|\/ipfs\/|Qm[1-9A-HJ-NP-Za-km-z]{44}(?:\/|$)|bafy[a-z2-7]+(?:\/|$)|bafk[a-z2-7]+(?:\/|$))/i.test(String(value).trim());
export function ipfsRows(state) {
  return [
    ...(state.ipfs?.downloads || []).map(row => ({ ...row, device: 'local', deviceId: '', deviceName: 'This computer', nodeStats: state.ipfs?.stats })),
    ...(state.devices || []).flatMap(device => (device.status?.ipfs?.downloads || []).map(row => ({ ...row, device: 'spark', deviceId: device.id, deviceName: device.name || device.host, offline: !device.connected, nodeStats: device.status?.ipfs?.stats }))),
  ];
}
export function ipfsInventory(state) {
  return ipfsRows(state).filter(row => row.status === 'done' && !row.removed).map(row => ({ ...row, source: 'ipfs', ipfsSource: row.source,
    path: row.dest, relative: row.folder, browseRelative: row.folder, directory: true, available: row.available !== false, missingFiles: row.missingFiles || 0,
    files: row.files.map(f => ({ ...f, relative: row.folder + '/' + f.path })), fileCount: row.files.length, size: row.total }));
}

export function createIpfsUi({ api, getState, openModal, refresh, controlsChanged, toast, goTransfers, fmtBytes, fmtSpeed }) {
  const $ = value => document.querySelector(value);
  const busy = new Set();
  const changed = async result => {
    if (!result.ok) toast(result.error, 'error');
    if (!result.data?.cancelled) await refresh();
    return result.ok && !result.data?.cancelled;
  };
  const control = async (row, action) => {
    const key = row.deviceId + ':' + row.id;
    if (row.offline || busy.has(key)) return;
    busy.add(key);
    try { return await changed(await api.ipfsControl({ id: row.id, deviceId: row.deviceId || undefined, action })); }
    finally { busy.delete(key); controlsChanged(); }
  };
  const render = rows => {
    const wrap = $('#ipfs-transfers'); if (!wrap) return;
    const filtered = rows.filter(row => !row.cleared && !row.removed);
    const html = filtered.map(row => {
      const disabled = row.offline || busy.has(row.deviceId + ':' + row.id) ? 'disabled' : '';
      const pct = row.total ? Math.min(100, row.downloaded / row.total * 100) : row.status === 'done' ? 100 : 0;
      const actions = row.status === 'active' ? [['pause', 'Pause']] : row.status === 'done' ? [['clear', 'Clear transfer'], ['remove', 'Remove · keep files']] : [['resume', 'Resume'], ['remove', 'Remove · keep partials']];
      const statusWord = row.offline ? 'offline' : row.error ? 'error' : row.status === 'done' ? 'complete' : row.status;
      const icons = { pause: '⏸', resume: '▶', clear: '✓', remove: '✕', source: '⧉' };
      const actionButton = (action, label, off = disabled) => `<button class="btn sm" data-ipfs-action="${action}" aria-label="${label}" ${off}><span class="lab">${label}</span><span class="ico" aria-hidden="true">${icons[action] || '•'}</span></button>`;
      // .sheet-row/.sheet-detail are display:contents in card mode (original vertical
      // flow preserved); sheet mode lays the row out as a one-line grid. Markup is
      // mode-agnostic so the _html cache never strands a view mode.
      return `<article class="ipfs-transfer" data-ipfs-id="${esc(row.id)}" data-ipfs-device="${esc(row.deviceId)}"><div class="sheet-row"><div class="ipfs-transfer-head sheet-cell cell-name"><button class="row-expand" data-ipfs-action="expand" aria-expanded="false" aria-label="Show details for ${esc(row.name)}">▸</button><strong>${esc(row.name)}</strong><span class="chip card-status">IPFS · ${esc(row.offline ? 'Device offline' : row.status)}</span></div><span class="sheet-cell cell-dev"><span class="chip" title="${esc(row.deviceName)}">${esc(row.deviceName)}</span></span><span class="sheet-cell cell-size">${fmtBytes(row.total)}</span><span class="sheet-cell cell-progress"><progress max="100" value="${pct}" aria-label="${esc(row.name)} download progress"></progress><span class="tor-pct">${Math.round(pct)}%</span></span><span class="sheet-cell cell-status"><span class="chip inv-status ${row.offline || row.error ? 'inventory-warning' : ''}" title="IPFS · ${esc(row.offline ? 'Device offline' : row.status)}">${esc(statusWord)}</span></span><span class="sheet-cell cell-rate tor-rate">${row.status === 'active' && !row.offline ? `<span class="down">↓ ${fmtSpeed(row.speedBps)}</span>` : '—'}</span><div class="ipfs-transfer-actions sheet-cell cell-acts">${actions.map(([action, label]) => actionButton(action, label)).join('')}${actionButton('source', 'Copy source link', '')}</div></div><div class="sheet-detail"><p class="hf-help">${esc(row.deviceName)} · ${row.files.length} files · ${fmtBytes(row.downloaded)} / ${fmtBytes(row.total)}${row.status === 'active' && !row.offline ? ' · ' + fmtSpeed(row.speedBps) : ''}</p><p class="inventory-path">${esc(row.dest)}</p>${row.error ? `<p class="inventory-error" role="status">${esc(row.error)}</p>` : ''}</div></article>`;
    }).join('');
    if (wrap._html !== html) {
      const openKeys = new Set([...wrap.querySelectorAll('.ipfs-transfer.open')].map(card => card.dataset.ipfsDevice + ':' + card.dataset.ipfsId));
      wrap.innerHTML = html; wrap._html = html;
      for (const card of wrap.querySelectorAll('.ipfs-transfer')) {
        if (!openKeys.has(card.dataset.ipfsDevice + ':' + card.dataset.ipfsId)) continue;
        card.classList.add('open');
        card.querySelector('[data-ipfs-action="expand"]')?.setAttribute('aria-expanded', 'true');
      }
    }
    wrap.onclick = async event => {
      const button = event.target.closest('[data-ipfs-action]'); if (!button || button.disabled) return;
      const card = button.closest('[data-ipfs-id]');
      if (button.dataset.ipfsAction === 'expand') {
        const open = card.classList.toggle('open');
        button.setAttribute('aria-expanded', String(open));
        return;
      }
      const row = ipfsRows(getState()).find(row => row.id === card.dataset.ipfsId && row.deviceId === card.dataset.ipfsDevice); if (!row) return;
      try {
        if (button.dataset.ipfsAction === 'source') { if (await api.copyText(row.source)) toast('IPFS source copied.'); }
        else { button.disabled = true; await control(row, button.dataset.ipfsAction); }
      } catch (error) { toast(error.message, 'error'); }
      finally { button.disabled = false; }
    };
  };
  const open = (source = '', initialDeviceId = '', onDismiss) => {
    let preview, closed = false, generation = 0, selected = new Set();
    let localDestination = getState().settings.downloadDir;
    const devices = () => (getState().devices || []).filter(d => d.connected && d.status?.capabilities?.ipfs);
    const deviceId = () => $('#ipfs-device')?.value || '';
    const destination = () => deviceId() ? $('#ipfs-remote-folder').value : localDestination;
    const summary = () => {
      if (closed) return;
      const files = preview?.files.filter(f => selected.has(f.path)) || [];
      $('#ipfs-selection').textContent = preview ? `${files.length} selected · ${fmtBytes(files.reduce((n, f) => n + f.size, 0))}` : 'Preview a CID to choose its files.';
      // Pre-download format review: filename hints only — the structural scan
      // runs after download. Risky selections stay possible (the user decides)
      // but are named plainly, and such items will not be shareable.
      const risky = files.filter(f => classifyFilename(f.path).format === 'pickle');
      const warning = $('#ipfs-format-warning');
      warning.hidden = !risky.length;
      if (risky.length) warning.textContent = `⚠ ${risky.length} selected file${risky.length === 1 ? '' : 's'} use${risky.length === 1 ? 's' : ''} a format that can run code when loaded (${risky.slice(0, 3).map(f => f.path.split('/').pop()).join(', ')}${risky.length > 3 ? ', …' : ''}). They will be scanned after download and cannot be shared while risky.`;
      $('#modal-acts .primary').disabled = !preview || !files.length || !destination();
    };
    const renderFiles = () => {
      $('#ipfs-files').innerHTML = (preview?.files || []).map(f => {
        const hint = classifyFilename(f.path);
        const tone = hint.format === 'pickle' ? 'warn' : hint.format === 'unknown' ? 'neutral' : 'ok';
        return `<label><input type="checkbox" data-ipfs-file="${esc(f.path)}" ${selected.has(f.path) ? 'checked' : ''}/><span>${esc(f.path)}</span><em class="ipfs-format ${tone}" title="Filename hint only — files are structurally scanned after download">${esc(hint.format)} · ${esc(hint.hint)}</em><small>${fmtBytes(f.size)}</small></label>`;
      }).join('');
      $('#ipfs-files').onchange = event => { const file = event.target.dataset.ipfsFile; if (event.target.checked) selected.add(file); else selected.delete(file); summary(); };
      summary();
    };
    const reset = () => { generation++; preview = null; selected.clear(); renderFiles(); $('#ipfs-message').textContent = 'Preview this source on the selected device.'; };
    const pickDevice = () => {
      const device = devices().find(d => d.id === deviceId());
      $('#ipfs-local-folder').hidden = !!deviceId(); $('#ipfs-remote-destination').hidden = !deviceId();
      $('#ipfs-remote-folder').innerHTML = (device?.status?.storage || []).filter(s => s.available).map(s => `<option value="${esc(s.path)}" ${s.path === device.defaultDir ? 'selected' : ''}>${esc(s.path)}</option>`).join('');
      reset();
    };
    const inspect = async () => {
      const value = $('#ipfs-source').value.trim(); if (!value) return;
      reset(); const request = generation, onDevice = deviceId(); $('#ipfs-preview').disabled = true;
      $('#ipfs-message').textContent = 'Looking up files through IPFS…';
      try {
        const result = await api.ipfsInspect({ source: value, deviceId: onDevice || undefined });
        if (closed || request !== generation) return;
        if (!result.ok || result.data?.cancelled) { $('#ipfs-message').textContent = result.error || 'Preview cancelled.'; return; }
        preview = result.data; selected = new Set(preview.files.map(f => f.path));
        if (!$('#ipfs-name').value.trim()) $('#ipfs-name').value = preview.name;
        $('#ipfs-message').textContent = 'Choose the files you want to keep.'; renderFiles();
      } catch (error) { if (!closed && request === generation) $('#ipfs-message').textContent = error.message; }
      finally { if (!closed) { $('#ipfs-preview').disabled = false; summary(); } }
    };
    openModal({ title: 'Download from IPFS', sub: 'Keep a file or collection on the device and drive you choose.',
      body: `<div class="field"><label for="ipfs-source">IPFS link or CID</label><input id="ipfs-source" value="${esc(source)}" placeholder="ipfs://…" spellcheck="false" /></div><label class="download-target">Download on <select id="ipfs-device"><option value="">This computer</option>${devices().map(d => `<option value="${esc(d.id)}" ${d.id === initialDeviceId ? 'selected' : ''}>${esc(d.name || d.host)}</option>`).join('')}</select></label><div id="ipfs-local-folder" class="hf-destination"><span>Save to</span><span id="ipfs-folder-label">${esc(localDestination)}</span><button class="hf-link" id="ipfs-pick-folder">Change</button></div><label id="ipfs-remote-destination" class="download-target" hidden>Folder <select id="ipfs-remote-folder"></select></label><div class="dl-source-tools"><button class="btn sm" id="ipfs-preview">Preview files</button><button class="btn sm" id="ipfs-all">Select all</button><button class="btn sm" id="ipfs-none">Clear selection</button></div><p id="ipfs-message" class="hf-help" role="status"></p><div id="ipfs-files" class="ipfs-file-list"></div><p id="ipfs-format-warning" class="ipfs-format-warning" role="alert" hidden></p><div class="field"><label for="ipfs-name">Collection name</label><input id="ipfs-name" maxlength="120" placeholder="Name this download" /></div><label class="download-target">Keep in <select id="ipfs-kind"><option value="">Detect from files</option><option value="model">My Models</option><option value="torrent">Torrents</option></select></label><strong id="ipfs-selection" role="status"></strong><p class="hf-help">Sharing starts off. IPFS also keeps a block cache, so allow extra disk space. IPFS rates are separate from torrent bandwidth limits.</p>`,
      actions: [{ label: 'Cancel', kind: 'btn' }, { label: 'Download selected', kind: 'btn primary', onClick: async () => {
        if (!preview || !selected.size) return;
        const button = $('#modal-acts .primary'); button.disabled = true;
        try { const result = await api.ipfsAdd({ previewId: preview.id, selectedPaths: [...selected], deviceId: deviceId() || undefined, destination: destination(), name: $('#ipfs-name').value, kind: $('#ipfs-kind').value || undefined }); if (await changed(result)) { $('#modal-acts .btn:not(.primary)')?.click(); goTransfers(); } }
        catch (error) { toast(error.message, 'error'); } finally { if (!closed) summary(); }
      } }],
      onDismiss: () => { closed = true; generation++; onDismiss?.(); },
      onMount: () => {
        $('#ipfs-source').oninput = reset; $('#ipfs-device').onchange = pickDevice; $('#ipfs-preview').onclick = inspect;
        $('#ipfs-pick-folder').onclick = async () => { const folder = await api.pickSaveDir(); if (folder && !closed) { localDestination = folder; $('#ipfs-folder-label').textContent = folder; summary(); } };
        $('#ipfs-all').onclick = () => { selected = new Set(preview?.files.map(f => f.path)); renderFiles(); };
        $('#ipfs-none').onclick = () => { selected.clear(); renderFiles(); };
        $('#ipfs-remote-folder').onchange = summary;
        pickDevice(); $('#ipfs-source').focus(); if (source) inspect();
      },
    });
  };
  return { open, render, control };
}
