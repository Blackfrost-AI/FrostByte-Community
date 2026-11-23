import { linkEntries, exportKey, linkHash } from '../shared/share-export.js';
import { contentKind } from '../shared/content-kind.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function bindLibraryTools({ api, getState, applyState, refresh, openModal, closeModal, toast }) {
  const selected = new Set(), bars = new Map(), $ = selector => document.querySelector(selector);
  let busy = false, progress = '';
  const entries = () => linkEntries(getState());
  const action = async run => { try { const result = await run(); if (!result.ok) throw new Error(result.error); if (result.data?.state) applyState(result.data.state); await refresh(); return result.data; } catch (error) { toast(error.message, 'error'); } };
  const recover = () => {
    const state = getState();
    const rows = [
      ...(state.hiddenItems || []).map(row => ({ name: row.name, detail: row.path, action: 'hidden', id: row, label: 'Restore listing' })),
      ...(state.retainedHf || []).map(row => ({ name: row.repoId + '/' + row.filePath, detail: row.dest, action: 'hf', id: row.id, label: 'Restore paused transfer' })),
      ...(state.devices || []).flatMap(device => (device.status?.downloads || []).filter(row => row.removed).map(row => ({ name: row.repoId + '/' + row.filePath, detail: device.name + ' · ' + row.dest, action: 'hf', id: row.id, deviceId: device.id, label: 'Restore paused device transfer' }))),
      ...(state.ipfs?.downloads || []).filter(row => row.removed || row.cleared).map(row => ({ name: row.name, detail: row.dest, action: 'ipfs', id: row.id, label: 'Restore transfer' })),
      ...(state.devices || []).flatMap(device => (device.status?.ipfs?.downloads || []).filter(row => row.removed || row.cleared).map(row => ({ name: row.name, detail: device.name + ' · ' + row.dest, action: 'ipfs', id: row.id, deviceId: device.id, label: 'Restore on device' }))),
      ...(state.linkJobs || []).map(row => ({ name: row.name, detail: `Link: ${row.status}${row.total ? ' · ' + Math.floor((row.completed || 0) / row.total * 100) + '%' : ''} ${row.error || ''}`, action: 'link', id: row.key, label: row.status === 'hashing' ? 'Pause' : row.status === 'done' ? 'Clear finished jobs' : 'Resume / recheck', operation: row.status === 'hashing' ? 'pause' : row.status === 'done' ? 'clear' : 'resume' })),
    ];
    openModal({ title: 'Hidden & retained entries', sub: 'Restoring a listing does not start sharing. Retained downloads return paused; link jobs recheck bytes on resume.',
      body: `<div class="recovery-list">${rows.map((row, i) => `<article><strong>${esc(row.name)}</strong><p class="inventory-path">${esc(row.detail)}</p><button class="btn sm" data-restore-row="${i}">${row.label}</button></article>`).join('') || '<p>No hidden entries or retained jobs.</p>'}</div>${(state.entryOperations || []).map(op => `<p class="inventory-error">${esc(op.entry.name)}: ${esc(op.error || 'Removal interrupted. Review this exact copy again in the library.')} (${esc(op.phase)})</p>`).join('')}`,
      actions: [{ label: 'Done', kind: 'btn', onClick: closeModal }], onMount: () => {
        for (const button of document.querySelectorAll('[data-restore-row]')) button.onclick = async () => {
          button.disabled = true; const row = rows[Number(button.dataset.restoreRow)];
          const result = await action(() => row.action === 'hidden' ? api.restoreItem(row.id) : row.action === 'hf' ? api.hfRestoreRetained(row.id, row.deviceId) : row.action === 'ipfs' ? api.ipfsControl({ id: row.id, deviceId: row.deviceId, action: 'restore' }) : api.controlLinks(row.id, row.operation));
          if (result) recover(); else button.disabled = false;
        };
      } });
  };
  const scopeRows = (kind, scope) => {
    const rows = entries().filter(row => kind === 'saved' ? row.device === 'catalog' : row.device !== 'catalog' && contentKind(row) === kind);
    if (scope === 'all') return rows;
    if (scope === 'selected') return rows.filter(row => selected.has(exportKey(row)));
    const host = $(kind === 'model' ? '#library-downloads' : kind === 'torrent' ? '#torrents-inventory' : '#grid-catalog');
    const keys = new Set([...host.querySelectorAll('[data-export-key]')].map(input => input.dataset.exportKey));
    return rows.filter(row => keys.has(exportKey(row)));
  };
  const preview = async kind => {
    let scope = 'selected', current = [];
    const update = async () => {
      current = scopeRows(kind, scope); const keys = current.map(exportKey);
      const result = await api.previewLinks(keys);
      if (!$('#export-summary')) return;
      $('#export-summary').textContent = result.ok ? `${current.length} entries → ${result.data.links.length} distinct magnets; ${result.data.excluded.length} without torrent links.` : result.error;
      $('#export-missing').textContent = result.ok ? result.data.excluded.map(row => row.name + ': ' + row.reason).join('\n') : '';
    };
    openModal({ title: 'Export magnet links', sub: 'CSV and JSON contain public link metadata—not private locations or credentials. Exporting does not start sharing.',
      body: '<label class="field">Scope<select id="export-scope"><option value="selected">Selected entries</option><option value="filtered">Filtered / visible entries</option><option value="all">All entries in this view</option></select></label><p id="export-summary" role="status"></p><pre id="export-missing" class="export-missing"></pre><button class="btn" id="export-create">Create missing local links…</button><p class="hint">Generated links can be paused or resumed in Hidden & retained entries. Remote copies use their reviewed Sharing control.</p>',
      actions: [{ label: 'Cancel', kind: 'btn' }, ...[['CSV', 'csv'], ['JSON', 'json'], ['CSV + JSON', 'both']].map(([label, format]) => ({ label, kind: 'btn primary', onClick: async () => {
        const result = await action(() => api.exportLinks(current.map(exportKey), format));
        if (result?.saved?.length) { toast(`Saved ${result.rows} magnet rows in ${result.saved.length} file(s). ${result.excluded} entries had no magnet.`); closeModal(); }
      } }))], onMount: () => {
        $('#export-scope').onchange = event => { scope = event.target.value; void update(); };
        $('#export-create').onclick = async () => { const missing = current.filter(row => row.device === 'local' && !linkHash(row.infohash || row.magnet)); const result = await action(() => api.createLinks(missing.map(exportKey))); if (result && !result.cancelled) { toast('Link jobs started. Sharing remains unchanged.'); closeModal(); } };
        void update();
      } });
  };
  const showResults = results => {
    const failures = results.filter(row => !row.ok);
    for (const row of results) if (row.ok) selected.delete(row.key);
    decorate();
    const summary = `${results.length - failures.length} completed · ${failures.length} not completed`;
    if (!failures.length) { toast(summary); return; }
    openModal({ title: 'Selected-item results', sub: summary + '. Unfinished items remain selected.',
      body: `<div class="recovery-list">${failures.map(row => `<article><strong>${esc(row.name)}</strong><p class="inventory-error">${esc(row.error)}</p></article>`).join('')}</div>`,
      actions: [{ label: 'Done', kind: 'btn' }] });
  };
  const runBatch = async (kind, operation) => {
    if (busy) return;
    const rows = scopeRows(kind, 'selected');
    if (!rows.length) return;
    const requests = rows.map(row => ({ device: row.device, deviceId: row.deviceId || '', id: row.id }));
    const run = async () => {
      if (busy) return;
      busy = true; progress = `Working on ${rows.length} selected…`; decorate();
      try {
        if (['hide', 'remove', 'stop'].includes(operation)) {
          const result = await api.batchItems(operation, requests);
          if (!result.ok) throw new Error(result.error);
          if (result.data.state) applyState(result.data.state);
          if (!result.data.cancelled) showResults(result.data.results);
        } else {
          const results = [];
          for (const [index, row] of rows.entries()) {
            progress = `${index + 1} / ${rows.length} · ${row.name}`; updateBars();
            try {
              if (row.offline) throw new Error('Reconnect this device first.');
              if (operation === 'delete' && (['scan', 'ipfs'].includes(row.source) || row.id.startsWith('shared:'))) throw new Error('This copy has no deletable completed-download manifest. Use Hide or Remove (keep files).');
              const request = requests[index];
              const result = await (operation === 'delete' ? api.removeItem({ ...request, deleteFiles: true })
                : row.source === 'ipfs' ? api.ipfsSharing({ id: row.id, deviceId: row.deviceId || undefined, enabled: true })
                : row.source === 'scan' ? api.shareDiscoveredModel({ id: row.id, enabled: true })
                : api.setItemSharing({ ...request, enabled: true }));
              if (!result.ok) throw new Error(result.error);
              if (result.data?.state) applyState(result.data.state);
              if (result.data?.cancelled) {
                results.push(...rows.slice(index).map(item => ({ key: exportKey(item), name: item.name, ok: false, error: 'Cancelled — not applied.' })));
                break;
              }
              results.push({ key: exportKey(row), name: row.name, ok: true });
            } catch (error) { results.push({ key: exportKey(row), name: row.name, ok: false, error: error.message }); }
          }
          showResults(results);
        }
      } catch (error) { toast(error.message, 'error'); }
      finally { busy = false; progress = ''; await refresh(); decorate(); }
    };
    if (['hide', 'remove', 'stop'].includes(operation)) return run(); // one main-process batch review
    openModal({ title: operation === 'delete' ? `Review deletion of ${rows.length} selected copies?` : `Share ${rows.length} selected copies?`,
      sub: operation === 'delete'
        ? 'Permanent deletion is reviewed separately for each exact device copy. Unsupported copies stay selected. Cancel any native review to stop the remaining batch.'
        : 'Each sharing request uses the existing device/file approval. Only share files you can redistribute. Cancel a review to stop the remaining batch.',
      body: `<div class="recovery-list">${rows.map(row => `<article><strong>${esc(row.name)}</strong><p class="inventory-path">${esc(row.device === 'local' ? 'This computer' : getState().devices?.find(d => d.id === row.deviceId)?.name || row.deviceId)} · ${esc(row.path)}</p></article>`).join('')}</div>`,
      actions: [{ label: 'Cancel', kind: 'btn' }, { label: 'Review selected copies', kind: operation === 'delete' ? 'btn danger' : 'btn primary', onClick: async () => { closeModal(); await run(); } }] });
  };
  function updateBars() {
    for (const [kind, bar] of bars) {
      const count = scopeRows(kind, 'selected').length, visible = scopeRows(kind, 'filtered').filter(row => selected.has(exportKey(row))).length;
      bar.querySelector('[data-selection-count]').textContent = busy ? progress : `${count} selected${count > visible ? ` · ${count - visible} outside current filter` : ''}`;
      for (const control of bar.querySelectorAll('button, select')) control.disabled = busy || !count;
      bar.classList.toggle('has-selection', count > 0);
    }
  }
  for (const [selector, kind] of [['#view-library .library-toolbar', 'model'], ['#view-catalog .library-toolbar', 'torrent'], ['#saved-links .saved-links-tools', 'saved']]) {
    const host = $(selector);
    for (const [label, handler] of [['Export links…', () => preview(kind)], ['Select visible', () => { if (busy) return; for (const row of scopeRows(kind, 'filtered')) selected.add(exportKey(row)); decorate(); }], ['Clear selection', () => { if (busy) return; for (const row of scopeRows(kind, 'all')) selected.delete(exportKey(row)); decorate(); }]]) {
      const button = document.createElement('button'); button.className = 'btn sm'; button.textContent = label; button.onclick = handler; host.append(button);
    }
    if (kind !== 'saved') { const button = document.createElement('button'); button.className = 'btn sm'; button.textContent = 'Hidden & retained entries'; button.onclick = recover; host.append(button); }
    if (kind !== 'saved') {
      const bar = document.createElement('div'); bar.className = 'library-selection-bar'; bar.dataset.selectionKind = kind;
      bar.innerHTML = `<span data-selection-count role="status" aria-live="polite">0 selected</span><select aria-label="Selected ${kind === 'model' ? 'model' : 'torrent'} action"><option value="share">Turn sharing on…</option><option value="stop">Turn sharing off…</option><option value="hide">Hide · keep sharing…</option><option value="remove">Remove · stop sharing, keep files…</option><option value="delete">Delete downloaded files…</option></select><button class="btn sm primary" data-apply-selection>Apply to selected…</button><span class="selection-hint">Actions affect only the selected device copies.</span>`;
      bar.querySelector('button').onclick = () => runBatch(kind, bar.querySelector('select').value);
      host.after(bar); bars.set(kind, bar);
    }
  }
  const importer = document.createElement('button'); importer.className = 'btn sm'; importer.textContent = 'Import JSON file'; importer.onclick = async () => { const result = await action(() => api.importLinks()); if (result?.imported) toast(`Imported ${result.imported} portable links.`); }; $('#saved-links .saved-links-tools').append(importer);
  function decorate() {
    const rows = entries();
    const valid = new Set(rows.map(exportKey));
    if (!busy) for (const key of selected) if (!valid.has(key)) selected.delete(key);
    for (const host of document.querySelectorAll('#library-downloads [data-inventory-id], #torrents-inventory [data-inventory-id], #grid-catalog tbody tr')) {
      const row = host.dataset.inventoryId ? rows.find(row => row.id === host.dataset.inventoryId && row.device === host.dataset.inventoryDevice && (row.deviceId || '') === (host.dataset.inventoryConnection || '')) : rows.find(row => row.id === 'catalog:' + host.dataset.id);
      if (!row) continue;
      let input = host.querySelector('[data-export-key]');
      if (!input) { input = document.createElement('input'); input.type = 'checkbox'; input.className = 'entry-select'; (host.querySelector('.inventory-title') || host.querySelector('td')).prepend(input); input.onclick = event => event.stopPropagation(); input.onchange = () => { if (input.checked) selected.add(input.dataset.exportKey); else selected.delete(input.dataset.exportKey); updateBars(); }; }
      input.dataset.exportKey = exportKey(row); input.setAttribute('aria-label', 'Select ' + row.name); input.checked = selected.has(exportKey(row)); input.disabled = busy;
    }
    updateBars();
  }
  return { decorate, recover };
}
