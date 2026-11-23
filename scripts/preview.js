import { createPreviewApi } from './preview-fixture.js';

function showFailure(message) {
  let error = document.getElementById('preview-error');
  if (!error) { error = document.createElement('pre'); error.id = 'preview-error'; document.body.append(error); }
  error.textContent = `Preview failed: ${message}`;
}
window.addEventListener('error', event => showFailure(event.message));
window.addEventListener('unhandledrejection', event => showFailure(event.reason?.message || event.reason));

async function waitFor(read) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('The requested screen did not finish loading.');
}

try {
  // Reuse the real DOM, including first-launch consent. Only this browser-only
  // harness supplies simulated acceptance through its stub bridge.
  const [html, metadata] = await Promise.all([
    fetch('../src/renderer/index.html').then(response => { if (!response.ok) throw new Error('Missing renderer HTML'); return response.text(); }),
    fetch('../package.json').then(response => { if (!response.ok) throw new Error('Missing package metadata'); return response.json(); }),
  ]);
  const renderer = new DOMParser().parseFromString(html, 'text/html');
  renderer.querySelectorAll('script').forEach(script => script.remove());
  document.body.replaceChildren(...renderer.body.childNodes);
  const flag = document.createElement('aside'); flag.className = 'preview-flag';
  flag.textContent = 'Preview · simulated data · no real transfers or device connections';
  document.body.append(flag);

  const query = new URLSearchParams(location.search);
  const theme = ['aeon', 'frost', 'abyss', 'malachite'].find(value => value === query.get('theme')) || 'aeon';
  localStorage.setItem('fb:theme', JSON.stringify(theme));
  localStorage.setItem('fb:lastTab', JSON.stringify('transfers'));
  const density = ['comfortable', 'cozy', 'compact', 'ultra'].find(value => value === query.get('density')) || 'cozy';
  localStorage.setItem('fb:density', JSON.stringify(density));
  window.frostbyte = createPreviewApi(metadata.version, theme);
  await import('../src/renderer/app.js');
  await waitFor(() => document.querySelector('#nav .nav.on'));
  const view = query.get('view');
  [...document.querySelectorAll('#nav .nav')].find(button => button.dataset.tab === view)?.click();
  const section = query.get('sec');
  [...document.querySelectorAll('#settings-nav .snav')].find(button => button.dataset.sec === section)?.click();
  if (query.has('hf') || query.has('hfsel')) {
    document.querySelector('#nav [data-tab="hf"]').click();
    document.querySelector('#hf-q').value = query.get('hf') || '';
    document.querySelector('#hf-go').click();
    if (query.has('hfsel')) {
      const row = await waitFor(() => [...document.querySelectorAll('#grid-hf tbody tr')].find(item => item.textContent.includes(query.get('hfsel'))));
      row.click();
    }
  }
  document.documentElement.dataset.previewReady = 'true';
} catch (error) { showFailure(error.message); }
