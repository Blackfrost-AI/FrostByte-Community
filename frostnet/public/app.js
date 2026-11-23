const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bytes = value => value >= 1e9 ? (value / 1e9).toFixed(1) + ' GB' : value >= 1e6 ? (value / 1e6).toFixed(1) + ' MB' : value >= 1e3 ? (value / 1e3).toFixed(1) + ' KB' : value + ' B';
const total = manifest => manifest.files.reduce((sum, file) => sum + file.size, 0);
const magnet = manifest => manifest.torrent ? `magnet:?xt=urn:btih:${manifest.torrent.infohash_v1}&dn=${encodeURIComponent(manifest.name)}` : '';
async function request(route) { const response = await fetch(route, { credentials: 'omit', signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error(response.status === 404 ? 'This release was not found.' : 'The directory is temporarily unavailable. Please retry.'); return response.json(); }
let cursor = '', query = '', generation = 0, count = 0;
async function search(more = false) {
  const version = ++generation; $('#search-form button').disabled = true; $('#load-more').disabled = true;
  if (!more) { cursor = ''; count = 0; $('#release-grid').replaceChildren(); }
  $('#search-status').textContent = 'Finding releases…';
  try {
    const result = await request('/v1/search?q=' + encodeURIComponent(query) + '&cursor=' + cursor);
    if (version !== generation) return;
    for (const row of result.items) { const manifest = row.manifest, element = document.createElement('a'); element.className = 'release-card'; element.href = '/releases/' + row.digest;
      element.innerHTML = `<div class="card-top"><span>${esc(manifest.publisher.toUpperCase())}</span><span>↗</span></div><h3>${esc(manifest.name)}</h3><p>${esc(manifest.description.slice(0, 140) || 'Inspect the exact files, hashes and publisher evidence.')}</p><div class="chips"><span class="chip">${esc(manifest.variant)}</span><span class="chip">${esc(manifest.license.id)}</span></div><div class="card-bottom"><span>${bytes(total(manifest))} · ${manifest.files.length} files</span><span>View release →</span></div>`; $('#release-grid').append(element); }
    count += result.items.length; cursor = result.cursor || ''; $('#load-more').hidden = !cursor;
    $('#search-status').textContent = `${count} ${count === 1 ? 'release' : 'releases'}${query ? ' matching “' + query + '”' : ' in the directory'} · Seed availability is separate from listing status`;
    if (!count) $('#release-grid').innerHTML = `<div class="empty-state"><span class="mark" aria-hidden="true">✳</span><h3>${query ? 'No matching releases yet.' : 'The next release starts here.'}</h3><p>${query ? 'Try a model name, release ID or variant prefix.' : 'Frostnet is ready for reviewed Blackfrost releases. Published models will appear here with their exact manifests and portable links.'}</p></div>`;
  } catch (error) { if (version === generation) { $('#search-status').textContent = error.message; if (!count) $('#release-grid').innerHTML = '<div class="empty-state"><h3>Directory unavailable</h3><p>Use Search to retry. No availability or seed counts are being assumed.</p></div>'; } }
  finally { if (version === generation) { $('#search-form button').disabled = false; $('#load-more').disabled = false; } }
}
async function detail(id) {
  $('#home-hero').hidden = true; $('#directory').hidden = true; $('#release-detail').hidden = false;
  $('#release-detail').innerHTML = '<p role="status">Loading release manifest…</p>';
  try {
    const row = await request('/v1/releases/' + id), manifest = row.manifest;
    document.title = manifest.name + ' — Frostnet';
    const uri = magnet(manifest), withdrawn = row.status === 'withdrawn';
    $('#release-detail').innerHTML = `<a class="muted" href="/">← All releases</a><p class="eyebrow">${esc(manifest.publisher.toUpperCase())} / ${esc(manifest.release)}</p><h1>${esc(manifest.name)}</h1><div class="chips"><span class="chip">${esc(manifest.variant)}</span><span class="chip">${esc(manifest.license.id)}</span><span class="chip">${bytes(total(manifest))}</span><span class="chip">${esc(row.status)}</span></div>${withdrawn ? '<p class="warning">This listing has been withdrawn. This tombstone preserves its correction history; download actions are disabled. Existing peer copies cannot be recalled.</p>' : ''}<div class="release-meta"><section class="release-panel"><h2>About this release</h2><p>${esc(manifest.description || 'No description supplied.')}</p><h2>Source & license evidence</h2><p>${esc(manifest.license.statement)}</p>${manifest.license.evidence_url ? `<p><a href="${esc(manifest.license.evidence_url)}" rel="noreferrer">Read public license evidence ↗</a></p>` : '<p>No external evidence URL supplied. Review the publisher’s statement.</p>'}${manifest.upstream ? `<p>Upstream: <a href="https://huggingface.co/${esc(manifest.upstream.repo)}/tree/${manifest.upstream.revision}" rel="noreferrer">${esc(manifest.upstream.repo)} ↗</a></p><code>${manifest.upstream.revision}</code>` : '<p>Original release · no Hugging Face origin required.</p>'}</section><aside class="release-panel"><h2>Take the link</h2>${!withdrawn && uri ? `<a class="button" href="${esc(uri)}">Open in FrostByte <span>↗</span></a><button class="small-button" id="copy-magnet">Copy magnet link</button><p>Opens your default magnet app. Choose FrostByte to review the files and destination before downloading.</p>` : ''}${!withdrawn && manifest.cid ? `<code>ipfs://${esc(manifest.cid)}</code>` : ''}<p class="warning">Seed availability unknown. A listing does not guarantee that a peer is currently online.</p><a class="small-button" href="/v1/manifests/${id}" download="${esc(manifest.release)}.release.json">Download manifest ↓</a><p>Publisher-reported verification: ${esc(new Date(manifest.verified_at).toLocaleString())}. Frostnet stores metadata, not model bytes.</p></aside></div><section class="release-panel"><h2>Exact files · ${manifest.files.length}</h2><p>SHA-256 hashes identify the reviewed bytes. Verify files after downloading; model files can contain executable code.</p><table class="file-table"><thead><tr><th>FILE / SHA-256</th><th>SIZE</th></tr></thead><tbody>${manifest.files.map(file => `<tr><td>${esc(file.path)}<code>${file.sha256}</code></td><td>${bytes(file.size)}</td></tr>`).join('')}</tbody></table><p>Manifest digest</p><code>${id}</code>${manifest.torrent ? '<p>Torrent infohash v1</p><code>' + manifest.torrent.infohash_v1 + '</code>' : ''}</section>`;
    $('#copy-magnet')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(uri); $('#toast').textContent = 'Magnet link copied. Sharing has not changed.'; $('#toast').hidden = false; setTimeout(() => { $('#toast').hidden = true; }, 3500); } catch { $('#copy-magnet').textContent = 'Clipboard unavailable — use the Open link'; } });
  } catch (error) { $('#release-detail').innerHTML = `<a href="/">← Back to directory</a><h1>Release unavailable</h1><p role="status">${esc(error.message)}</p>`; }
}
$('#search-form').addEventListener('submit', event => { event.preventDefault(); query = $('#query').value.trim(); void search(); });
$('#load-more').addEventListener('click', () => void search(true));
const match = /^\/releases\/([a-f0-9]{64})\/?$/.exec(location.pathname);
if (match) void detail(match[1]); else void search();
