import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Synthetic metadata exercises large/partial repositories without downloading
// multi-GB weights. app.spec.js separately covers the real HF download path.
const GB = 1024 ** 3;
const metadata = (id, files, gated = false) => ({ id, files, gated, sha: 'a'.repeat(40), license: 'apache-2.0', downloads: 42000, likes: 300, pipelineTag: 'text-generation' });
const file = (path, size = 1024) => ({ path, size });
const models = [
  metadata('test/Orion-GGUF', [
    file('orion-Q4_K_M-00001-of-00002.gguf', 2 * GB), file('orion-Q4_K_M-00002-of-00002.gguf', 2 * GB),
    ...['Q2_K', 'Q3_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'F16'].map((quant, i) => file(`orion-${quant}.gguf`, (i + 3) * GB)),
    file('orion-IQ4_XS-00001-of-00002.gguf', GB), file('mmproj-orion-f16.gguf', GB / 2),
    file('README.md'), file('LICENSE'), file('config.json'),
    ...Array.from({length:80}, (_, i) => file(`extras/notes-${String(i).padStart(3, '0')}.txt`)),
  ]),
  metadata('test/Orion-Safetensors', [file('model-00001-of-00002.safetensors', GB), file('model-00002-of-00002.safetensors', GB), file('model.safetensors.index.json'), file('config.json'), file('tokenizer.json'), file('merges.txt'), file('README.md')]),
  {...metadata('test/Restricted', [file('model.safetensors', GB), file('config.json')], 'manual'), architectures:['Qwen3ForCausalLM']},
  metadata('test/Other-files', [file('weights.custom', 0), file('config.json')]),
  metadata('test/Mixed-formats', [file('model.safetensors', GB), file('pytorch_model.bin', GB), file('model-Q4_K_M.gguf', GB / 2), file('config.json')]),
];
let app, page, home;
const errors = [];
const snapshots = path.resolve('test-results/screenshots');
const nav = () => page.locator('#nav [data-tab="hf"]').click();
const openModel = async id => {
  await nav();
  await page.locator(`#grid-hf tr[data-id="${id}"]`).click();
  await expect(page.locator('#hf-detail h3')).toHaveText(id);
  await expect(page.locator('#hf-download')).toBeVisible();
};
const selectedPaths = () => page.locator('#hf-files input[data-f]:checked').evaluateAll(inputs => inputs.map(input => input.dataset.f).sort());
const choice = label => page.locator('.hf-option').filter({has: page.locator('strong', {hasText: new RegExp(`^${label}$`)})});
async function pickerGeometry() {
  return page.evaluate(() => {
    const target = document.querySelector('#hf-files input[data-f="extras/notes-079.txt"]');
    const rect = element => element?.getBoundingClientRect().toJSON();
    const body = document.querySelector('.hf-detail-body');
    const box = target?.getBoundingClientRect();
    const hit = box ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null;
    return { body: { rect: rect(body), scrollTop: body?.scrollTop, scrollHeight: body?.scrollHeight, clientHeight: body?.clientHeight },
      target: rect(target), toolbar: rect(document.querySelector('.hf-filetools')), checkout: rect(document.querySelector('.hf-checkout')),
      hit: { tag: hit?.tagName, id: hit?.id, className: hit?.className }, active: document.activeElement?.id || document.activeElement?.getAttribute('data-f'),
      focused: document.hasFocus(), dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } };
  });
}

test.describe.serial('HuggingFace download chooser', () => {
  test.beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-picker-'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({downloadDir:path.join(home,'downloads'),upnpEnabled:false,dhtEnabled:false,confirmExitSeeding:false,confirmBigPull:true,bigPullGB:1}));
    app = await electron.launch({executablePath:process.env.FROSTBYTE_EXECUTABLE,args:process.env.FROSTBYTE_EXECUTABLE?[]:['.'],env:{...process.env,FROSTBYTE_HOME:home}});
    page = await app.firstWindow(); await acceptBetaTerms(page, app);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
    await app.evaluate(({ipcMain}, fixtures) => {
      globalThis.pickerRequests = [];
      globalThis.pickerModelFinished = 0;
      for (const name of ['hf:search','hf:model','hf:download']) ipcMain.removeHandler(name);
      globalThis.pickerSearches = 0;
      globalThis.pickerModelIds = [];
      globalThis.pickerSearchOptions = [];
      ipcMain.handle('hf:search', (_, _query, options) => { globalThis.pickerSearches++; globalThis.pickerSearchOptions.push(options || {}); return {ok:true,data:fixtures}; });
      ipcMain.handle('hf:model', async (_, id, revision) => {
        globalThis.pickerModelIds.push([id, revision]);
        await new Promise(resolve => setTimeout(resolve, 150));
        globalThis.pickerModelFinished++;
        return {ok:true,data:fixtures.find(model => model.id === id)};
      });
      ipcMain.handle('hf:download', async (_, request) => {
        globalThis.pickerRequests.push(request);
        return {ok:true,data:{downloads:[]}};
      });
    }, models);
    await nav(); await page.locator('#hf-q').fill('Orion'); await page.locator('#hf-go').click();
    await expect(page.locator('#grid-hf tbody tr')).toHaveCount(models.length);
    fs.mkdirSync(snapshots, {recursive:true});
  });
  test.afterAll(async () => { await app?.close(); if(home)fs.rmSync(home,{recursive:true,force:true}); });
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      await page.screenshot({path:info.outputPath('hf-picker-failure.png')}).catch(()=>{});
      const geometryFile = info.outputPath('picker-geometry.json');
      fs.writeFileSync(geometryFile, JSON.stringify(await pickerGeometry(), null, 2));
      await info.attach('picker-geometry', {path:geometryFile, contentType:'application/json'});
    }
  });

  test('results show owner byline, format badges with EXL3/NVFP4 highlighted, and format chips drive the search filter', async () => {
    await nav();
    await page.locator('#hf-q').fill('Orion'); await page.locator('#hf-go').click();
    const first = page.locator('#grid-hf tbody tr').first();
    await expect(first.locator('.owner')).toHaveText('test/');
    await expect(first.locator('.fmt[data-format="gguf"]')).toHaveText('GGUF');
    await expect(page.locator('#grid-hf .fmt.primary')).toHaveCount(0);
    const chips = page.locator('#hf-format-chips .hf-chip');
    await expect(chips.nth(0)).toHaveText('All formats');
    await expect(chips.nth(1)).toHaveText('EXL3');
    await expect(chips.nth(2)).toHaveText('NVFP4');
    await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'true');
    const before = await app.evaluate(() => globalThis.pickerSearches);
    await page.locator('#hf-format-chips .hf-chip[data-format="nvfp4"]').click();
    await expect.poll(() => app.evaluate(() => globalThis.pickerSearches)).toBe(before + 1);
    expect((await app.evaluate(() => globalThis.pickerSearchOptions)).at(-1).format).toBe('nvfp4');
    await expect(page.locator('#hf-search-format')).toHaveValue('nvfp4');
    await expect(page.locator('#hf-format-chips .hf-chip[data-format="nvfp4"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#hf-format-chips .hf-chip[data-format=""]')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#hf-format-chips .hf-chip[data-format=""]').click();
    await expect.poll(() => app.evaluate(() => globalThis.pickerSearches)).toBe(before + 2);
    expect((await app.evaluate(() => globalThis.pickerSearchOptions)).at(-1).format || '').toBe('');
    await page.screenshot({ path: path.join(snapshots, 'hf-results-cards.png') });
  });

  test('a pasted huggingface.co link opens that model directly without running a search', async () => {
    const target = models[0].id;
    const searches = await app.evaluate(() => globalThis.pickerSearches);
    await page.locator('#hf-q').fill(`https://huggingface.co/${target}/tree/main`);
    await page.locator('#hf-q').press('Enter');
    await expect(page.locator('#hf-detail')).toBeVisible();
    await expect(page.locator('#hf-detail')).toContainText(target.split('/')[1]);
    expect(await app.evaluate(() => globalThis.pickerSearches)).toBe(searches);
    expect((await app.evaluate(() => globalThis.pickerModelIds)).at(-1)).toEqual([target, 'main']);
    await page.keyboard.press('Escape');
    // A lookalike host is treated as search text, never followed.
    await page.locator('#hf-q').fill(`https://huggingface.co.evil.example/${target}`);
    await page.locator('#hf-q').press('Enter');
    await expect.poll(() => app.evaluate(() => globalThis.pickerSearches)).toBe(searches + 1);
    await page.locator('#hf-q').fill('Orion'); await page.locator('#hf-go').click();
    await expect(page.locator('#grid-hf tbody tr')).toHaveCount(models.length);
  });

  test('one version selects its split parts, confirmation can cancel, and only that version is queued', async () => {
    await openModel('test/Orion-GGUF');
    await expect(page.locator('#hf-download')).toBeDisabled();
    await choice('Q4_K_M').click();
    const expected = ['LICENSE','README.md','orion-Q4_K_M-00001-of-00002.gguf','orion-Q4_K_M-00002-of-00002.gguf'];
    expect(await selectedPaths()).toEqual(expected);
    await expect(page.locator('#hf-download')).toHaveText('Download · 4.0 GB');
    await page.locator('.hf-detail-body').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({path:path.join(snapshots,'hf-version-chooser.png')});
    await page.locator('#hf-download').click();
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#modal-remember')).not.toBeChecked();
    await page.locator('#modal-remember').check();
    await page.keyboard.press('Escape');
    expect(await app.evaluate(() => globalThis.pickerRequests.length)).toBe(0);
    expect((await page.evaluate(() => window.frostbyte.getState())).data.settings.confirmBigPull).toBe(true);
    await expect(page.locator('#hf-download')).toBeEnabled();
    await page.locator('#hf-download').click();
    await page.locator('#modal .modal-acts button.primary').click();
    await expect(page.locator('#view-transfers')).toBeVisible();
    const requests = await app.evaluate(() => globalThis.pickerRequests);
    expect(requests).toHaveLength(1);
    expect(requests[0].revision).toBe('a'.repeat(40));
    expect(requests[0].files.map(file => file.path).sort()).toEqual(expected);
    await nav();
    await choice('Q8_0').click();
    expect(await selectedPaths()).toEqual(['LICENSE','README.md','orion-Q8_0.gguf']);
    await expect(choice('IQ4_XS').locator('input')).toBeDisabled();
  });

  test('option and file filters preserve selection, focus, and scroll; footer stays visible at minimum size', async () => {
    await page.locator('#hf-option-filter').fill('Q4_K_M');
    await expect(page.locator('.hf-option')).toHaveCount(1);
    await expect(page.locator('#hf-choice-name')).toHaveText('Q8_0');
    await choice('Q4_K_M').click();
    await page.locator('#hf-option-filter').fill('no-match');
    await expect(page.locator('#hf-options')).toContainText('No versions match');
    await page.locator('#hf-option-filter').fill('');
    await page.locator('#hf-custom summary').click();
    await page.locator('#hf-pick-none').click();
    await page.locator('#hf-ffilter').fill('extras/notes-07');
    await expect(page.locator('#hf-ffilter')).toBeFocused();
    await page.locator('#hf-pick-visible').click();
    await expect(page.locator('#hf-selinfo')).toHaveText('10 files selected');
    await page.locator('#hf-ffilter').fill('');
    const target = page.locator('#hf-files input[data-f="extras/notes-079.txt"]');
    await target.scrollIntoViewIfNeeded();
    // Centering can put a row behind the sticky filter toolbar at Windows
    // display scaling. Establish a visible click target before measuring
    // whether changing its selection moves the list.
    await target.click({trial:true});
    expect(await target.evaluate(input => {
      const box = input.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === input;
    })).toBe(true);
    const before = await page.locator('.hf-detail-body').evaluate(el => el.scrollTop);
    await target.uncheck();
    await expect(target).toBeFocused();
    expect(await page.locator('.hf-detail-body').evaluate(el => el.scrollTop)).toBe(before);
    await expect(page.locator('#hf-selinfo')).toHaveText('9 files selected');
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(980,600));
    await expect.poll(() => page.locator('#hf-download').evaluate(el => {
      const button = el.getBoundingClientRect();
      const panel = document.querySelector('#hf-detail').getBoundingClientRect();
      return button.bottom <= panel.bottom && button.left >= panel.left && button.right <= panel.right;
    })).toBe(true);
    // A visible checkout must still leave the file rows reachable in a short
    // window; a sticky toolbar can otherwise cover the entire scroll area.
    await target.locator('..').scrollIntoViewIfNeeded();
    await target.check({timeout:5000});
    await expect(target).toBeFocused();
    await expect(target).toBeChecked();
    await expect(page.locator('#hf-selinfo')).toHaveText('10 files selected');
    expect(await target.evaluate(input => {
      const box = input.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === input;
    })).toBe(true);
    expect(await target.evaluate(input => {
      const row = input.closest('.hf-file').getBoundingClientRect();
      const body = document.querySelector('.hf-detail-body').getBoundingClientRect();
      return row.top >= body.top && row.bottom <= body.bottom;
    })).toBe(true);
    await page.screenshot({path:path.join(snapshots,'hf-custom-small.png')});
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1400,900));
  });

  test('single Safetensors version is ready with supporting files and the destination can change', async () => {
    await openModel('test/Orion-Safetensors');
    await expect(page.locator('#hf-custom')).not.toHaveAttribute('open');
    expect(await selectedPaths()).toEqual(models[1].files.map(file => file.path).sort());
    await expect(page.locator('#hf-download')).toBeEnabled();
    const dest=path.join(home,'chosen-folder');
    await app.evaluate(({dialog}, dest) => { dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dest]}); },dest);
    await page.locator('#hf-folder').click();
    await expect(page.locator('.hf-destination')).toContainText('chosen-folder');
    expect(await page.evaluate(async()=>(await window.frostbyte.getState()).data.settings.downloadDir)).toBe(dest);
    expect(await selectedPaths()).toEqual(models[1].files.map(file => file.path).sort());
    await openModel('test/Mixed-formats');
    await expect(page.locator('#hf-download')).toBeDisabled();
    await page.locator('#hf-format').selectOption('Safetensors');
    await expect(page.locator('.hf-option')).toHaveCount(1);
    await choice('Safetensors').click();
    expect(await selectedPaths()).toEqual(['config.json','model.safetensors']);
    await page.locator('#hf-format').selectOption('GGUF');
    await expect(page.locator('.hf-option')).toHaveCount(1);
    await expect(page.locator('#hf-choice-name')).toHaveText('Safetensors');
  });

  test('gated models offer account setup and unrecognized files have an explicit custom path', async () => {
    await openModel('test/Restricted');
    await expect(page.locator('#hf-download')).toBeDisabled();
    await page.getByRole('button',{name:'Add token',exact:true}).click();
    await expect(page.locator('#sec-hftoken')).toBeVisible();
    await expect(page.locator('#set-hftoken')).toBeFocused();
    await openModel('test/Other-files');
    await expect(page.locator('#hf-custom')).toHaveAttribute('open','');
    await page.locator('#hf-files input[data-f="weights.custom"]').check();
    await expect(page.locator('#hf-download')).toHaveText('Download · Size unavailable');
  });

  test('closing while metadata loads stays closed; keyboard selection and Escape restore the results', async () => {
    await page.getByRole('button',{name:'Close model details',exact:true}).click();
    const finished=await app.evaluate(()=>globalThis.pickerModelFinished);
    const row=page.locator('#grid-hf tr[data-id="test/Orion-GGUF"]');
    await row.focus(); await page.keyboard.press('Enter');
    await page.getByRole('button',{name:'Close model details',exact:true}).click();
    await expect.poll(()=>app.evaluate(()=>globalThis.pickerModelFinished)).toBe(finished+1);
    await expect(page.locator('#hf-detail')).toBeHidden();
    await row.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#hf-download')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#hf-detail')).toBeHidden();
    await expect(page.locator('#grid-hf tr[data-id="test/Orion-GGUF"]')).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('large-download reminders can be disabled in the dialog and restored in Settings', async () => {
    await openModel('test/Orion-Safetensors');
    await page.locator('#hf-download').click();
    await page.locator('#modal-remember').check();
    await page.locator('#modal .modal-acts button.primary').click();
    await expect(page.locator('#view-transfers')).toBeVisible();
    expect(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).confirmBigPull).toBe(false);
    const count = await app.evaluate(() => globalThis.pickerRequests.length);
    await openModel('test/Orion-Safetensors');
    await page.locator('#hf-download').click();
    await expect(page.locator('#view-transfers')).toBeVisible();
    await expect(page.locator('#modal')).toBeHidden();
    expect(await app.evaluate(() => globalThis.pickerRequests.length)).toBe(count + 1);
    await page.locator('#nav [data-tab="settings"]').click();
    await page.locator('#settings-nav [data-sec="interface"]').click();
    await expect(page.locator('#set-bigpull')).not.toBeChecked();
    await page.locator('#set-bigpull').check();
    await openModel('test/Orion-Safetensors');
    await page.locator('#hf-download').click();
    await expect(page.locator('#modal')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('versions are grouped by format with quant and fit tags, and the page shows download, save and share state', async () => {
    await openModel('test/Mixed-formats');
    await expect(page.locator('#hf-options .hf-variant-group')).toHaveCount(3);
    expect(await page.locator('#hf-options .hf-variant-group').evaluateAll(groups => groups.map(group => group.dataset.variantGroup))).toEqual(['gguf','safetensors','pytorch']);
    await expect(page.locator('[data-variant-group="gguf"] .hf-variant-head .fmt')).toHaveText('GGUF');
    // The GGUF repository groups companion files separately and labels each quant.
    await openModel('test/Orion-GGUF');
    expect(await page.locator('#hf-options .hf-variant-group').evaluateAll(groups => groups.map(group => group.dataset.variantGroup))).toEqual(['gguf','companion','incomplete']);
    await expect(page.locator('[data-variant-group="gguf"] .hf-tag.recommended')).toHaveCount(1);
    await expect(page.locator('#hf-lifecycle')).toBeHidden();

    // Report a live download and a saved copy for this exact repository through the real state channel.
    await app.evaluate(({ipcMain}) => {
      const original = ipcMain._invokeHandlers.get('app:state');
      globalThis.pickerOriginalState = original;
      ipcMain.removeHandler('app:state');
      ipcMain.handle('app:state', async event => {
        const result = await original(event);
        return {...result, data:{...result.data,
          downloads:[{id:'d1', repoId:'test/Orion-GGUF', revision:'main', filePath:'orion-Q8_0.gguf', destination:'/x', status:'active', downloaded:25, total:100, speedBps:1}],
          inventory:[...(result.data.inventory || []), {id:'saved-orion', source:'hf', kind:'model', repoId:'test/Orion-GGUF', name:'test/Orion-GGUF', path:'/x/test/Orion-GGUF', directory:true, available:true, files:[], size:5}]}};
      });
    });
    await expect(page.locator('#hf-lifecycle')).toBeVisible({timeout:5000});
    await expect(page.locator('#hf-lifecycle .hf-life-chip.active')).toContainText('Downloading on');
    await expect(page.locator('#hf-lifecycle .hf-life-chip.active')).toContainText('25%');
    await expect(page.locator('#hf-lifecycle .hf-life-chip.saved')).toContainText('Saved on');
    await page.locator('.hf-detail-body').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({path:path.join(snapshots,'hf-grouped-chooser.png')});
    await page.locator('#hf-lifecycle [data-hf-goto="library"]').click();
    await expect(page.locator('#view-library')).toBeVisible();
    await app.evaluate(({ipcMain}) => { ipcMain.removeHandler('app:state'); ipcMain.handle('app:state', globalThis.pickerOriginalState); });
    expect(errors).toEqual([]);
  });

  test('supported checkpoints offer vLLM and SGLang serve recipes; others explain why not', async () => {
    await openModel('test/Restricted');
    await expect(page.locator('#hf-detail [data-serve-open]')).toHaveText(['Serve with vLLM', 'Serve with SGLang']);
    await page.locator('#hf-detail [data-serve-open="sglang"]').click();
    await expect(page.locator('#hf-tab-serve')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#hf-pane-download')).toBeHidden();
    const vllm = page.locator('#hf-pane-serve [data-serve-engine="vllm"]');
    await expect(vllm).toContainText('Qwen3ForCausalLM');
    await expect(vllm.locator('pre').first()).toHaveText(/^docker pull \S+/);
    await expect(vllm.locator('pre').nth(1)).toContainText('vllm serve test/Restricted');
    await expect(vllm.locator('pre').nth(1)).toContainText('-e HF_TOKEN');
    await expect(vllm.locator('pre').nth(1)).not.toContainText('HF_TOKEN=');
    await expect(page.locator('#hf-pane-serve [data-serve-engine="sglang"] pre').nth(1)).toContainText('sglang.launch_server --model-path test/Restricted');
    await expect(page.locator('#hf-pane-serve .hf-serve-source')).toContainText(/vLLM [0-9a-f]{8} and SGLang [0-9a-f]{8}/);
    // Copy still goes through the clipboard review; capture the write without touching the real clipboard.
    await app.evaluate(({clipboard, dialog}) => {
      globalThis.serveCopy = { reviews: [], text: null, write: clipboard.writeText, box: dialog.showMessageBox };
      clipboard.writeText = text => { globalThis.serveCopy.text = text; };
      dialog.showMessageBox = async (window, options) => {
        if (options?.message !== 'Copy to clipboard?') return globalThis.serveCopy.box.call(dialog, window, options);
        globalThis.serveCopy.reviews.push(options.message); return { response: 1 };
      };
    });
    await vllm.locator('[data-serve-copy="run"]').click();
    await expect.poll(() => app.evaluate(() => globalThis.serveCopy.text)).toContain('vllm serve test/Restricted');
    expect(await app.evaluate(() => globalThis.serveCopy.reviews)).toEqual(['Copy to clipboard?']);
    await app.evaluate(({clipboard, dialog}) => { clipboard.writeText = globalThis.serveCopy.write; dialog.showMessageBox = globalThis.serveCopy.box; });
    await page.screenshot({path:path.join(snapshots,'hf-serve-recipes.png')});
    // The tab choice persists across models; repos without a known architecture say why instead.
    await openModel('test/Orion-GGUF');
    await expect(page.locator('#hf-detail [data-serve-open]')).toHaveCount(0);
    await expect(page.locator('#hf-pane-serve [data-serve-status="unsupported"]')).toContainText('GGUF');
    await openModel('test/Orion-Safetensors');
    await expect(page.locator('#hf-pane-serve [data-serve-status="unknown"]')).toContainText('architecture');
    await page.locator('#hf-tab-download').click();
    await expect(page.locator('#hf-pane-download')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
