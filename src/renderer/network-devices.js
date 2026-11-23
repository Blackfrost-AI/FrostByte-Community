/** Discovery does not establish trust or grant access to a remote device. */
export function bindNetworkDevices({ api, setup, goNetwork, toast }) {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  let state = { candidates: [], overlays: [], wireguard: { services: [] }, scan: { phase: 'idle', results: [] } }, busy = false;
  const status = (text, error = false) => { $('#network-message').textContent = text; $('#network-message').classList.toggle('inventory-error', error); };
  function renderResults() {
    const scan = state.scan, running = scan.phase === 'scanning';
    $('#network-scan').disabled = busy || running || !$('#network-interface').value;
    $('#network-cancel').hidden = !running;
    $('#network-scan-progress').textContent = running ? `Checking ${scan.checked} of ${scan.total} addresses…`
      : scan.phase === 'complete' ? `Check complete · ${scan.results.length} device${scan.results.length === 1 ? '' : 's'} with SSH or file sharing found.`
      : scan.phase === 'cancelled' ? `Scan stopped · ${scan.results.length} results kept.` : 'No scan has run. Nothing is scanned automatically.';
    $('#network-results').innerHTML = scan.results.map((row, index) => `<article class="network-device"><div><h4>${esc(row.name)}</h4><p class="mono">${esc(row.address)}</p><p>${row.platformHint === 'windows' ? 'Windows SSH service' : 'Device type unverified'} · ${[row.ssh && 'SSH available', row.smb && 'File sharing available'].filter(Boolean).join(' · ')}</p><p class="hint">${row.platformHint === 'windows'
      ? 'Found, not paired. Native Windows remote management is not supported by this companion installer. Use a supported Linux/WSL host with its own SSH endpoint, or a mounted Windows share. Existing seeding is unchanged.'
      : row.ssh ? 'SSH is reachable; OS, account access and companion compatibility are checked during setup. Mac and Linux/Docker hosts are supported.' : 'Mount an authorized share in Finder or File Explorer, then choose it in Settings → Folders. Share access is not transfer-client control.'}</p></div><div class="network-device-actions">${row.ssh && row.platformHint !== 'windows' ? `<button class="btn sm" data-network-setup="${index}">Set up companion</button>` : ''}<button class="btn sm" data-network-copy="${index}">Copy address</button></div></article>`).join('');
    if (scan.phase === 'complete' && !scan.results.length) $('#network-results').innerHTML = '<p class="note">No supported service replied. This does not prove the device is offline. Check its firewall or enter its hostname/IP; discovery checks only ports 22 and 445.</p>';
  }
  function renderInventory() {
    const selected = $('#network-interface').value;
    const choices = state.candidates.filter(row => row.kind === 'lan' || row.kind === 'wireguard' && state.overlays.some(saved => saved.id === row.overlayId));
    $('#network-interface').innerHTML = '<option value="">Choose a network</option>' + choices.map(row => `<option value="${esc(row.id)}">${esc(row.name)} · ${esc(row.address)} · ${row.kind === 'wireguard' ? 'WireGuard (exact peer only)' : esc(row.cidr)}</option>`).join('');
    if (choices.some(row => row.id === selected)) $('#network-interface').value = selected;
    else if (choices.length === 1) $('#network-interface').value = choices[0].id;
    const services = [...state.wireguard.services];
    for (const saved of state.overlays) if (!services.some(row => row.id === saved.id)) services.push({ ...saved, active: false });
    $('#wireguard-status').textContent = services.length ? `${services.length} WireGuard tunnel${services.length === 1 ? '' : 's'} detected or saved.`
      : state.wireguard.unavailable ? 'WireGuard is installed, but its status is not readable with this account. No elevated access was requested. Activate the tunnel in WireGuard, then refresh.'
      : state.wireguard.installed ? 'WireGuard tools found; no tunnel is currently exposed. Activate one in WireGuard, then refresh.'
      : 'No WireGuard service detected. Configure WireGuard using its official app, then refresh. Other VPN interfaces are not assumed to be WireGuard.';
    $('#wireguard-overlays').innerHTML = services.map(row => {
      const saved = state.overlays.some(item => item.id === row.id);
      return `<div class="network-overlay"><div><strong>${esc(row.name)}</strong><p class="hint">${row.active ? 'Private IPv4 interface available' : 'Inactive or no private IPv4 address'} · ${saved ? 'Added to FrostByte' : 'Not added'}</p></div><button class="btn sm" data-overlay-id="${esc(row.id)}" data-overlay-enabled="${!saved}" ${!saved && !row.active ? 'disabled' : ''}>${saved ? 'Remove from FrostByte' : 'Add overlay'}</button></div>`;
    }).join('');
    renderResults();
  }
  async function refresh() {
    if (busy) return;
    busy = true; $('#network-refresh').disabled = true; status('Reading local network interfaces and WireGuard service names…');
    try { state = { ...state, ...await api.inventory() }; renderInventory(); status('Choose your own network or enter an exact device address. Each check requires approval.'); }
    catch (error) { status(error.message, true); }
    finally { busy = false; $('#network-refresh').disabled = false; renderResults(); }
  }
  $('#network-refresh').onclick = refresh;
  $('#devices-discover').onclick = () => { goNetwork(); $('#network-refresh').focus(); };
  $('#network-interface').onchange = () => { renderResults(); const row = state.candidates.find(item => item.id === $('#network-interface').value); $('#network-host').placeholder = row?.kind === 'wireguard' ? 'Required: private WireGuard peer IP or hostname' : 'Optional: desktop-128.local or a private IP'; };
  $('#network-scan').onclick = async () => {
    if (busy) return; busy = true; renderResults(); status('Review the network check in the app confirmation dialog.');
    try { const result = await api.scan({ networkId: $('#network-interface').value, host: $('#network-host').value.trim() }); state = { ...state, ...result }; status(result.cancelled ? 'Check cancelled. No devices were contacted.' : 'Checking only the approved network. You can stop at any time.'); }
    catch (error) { status(error.message, true); }
    finally { busy = false; renderResults(); }
  };
  $('#network-cancel').onclick = async () => { try { await api.cancel(); } catch (error) { status(error.message, true); } };
  $('#wireguard-overlays').onclick = async event => {
    const button = event.target.closest('[data-overlay-id]'); if (!button || busy) return;
    busy = true; button.disabled = true;
    try { const result = await api.setOverlay(button.dataset.overlayId, button.dataset.overlayEnabled === 'true'); state = { ...state, ...result }; status(result.cancelled ? 'Overlay was not added.' : 'Overlay preference saved. VPN configuration and running transfers are unchanged.'); }
    catch (error) { status(error.message, true); }
    finally { busy = false; renderInventory(); }
  };
  $('#network-results').onclick = async event => {
    const connect = event.target.closest('[data-network-setup]'), copy = event.target.closest('[data-network-copy]');
    if (connect) { const row = state.scan.results[Number(connect.dataset.networkSetup)]; if (row?.ssh && row.platformHint !== 'windows') await setup(row.address); }
    if (copy) { const row = state.scan.results[Number(copy.dataset.networkCopy)]; if (row) { try { await window.frostbyte.copyText(row.address); } catch (error) { toast(error.message, 'error'); } } }
  };
  api.onChanged(next => { state = { ...state, ...next }; renderResults(); });
  // Restoring in-memory results does not inspect services or send network traffic.
  api.snapshot().then(next => { state = { ...state, ...next }; renderResults(); }).catch(() => {});
}
