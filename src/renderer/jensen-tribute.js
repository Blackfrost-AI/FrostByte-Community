// Commemorative Founders Leather (jensen) tribute & 2021–2026 AI / Open-Source timeline.
// All photography and vector signatures are bundled locally under permissive licenses
// (CC0 1.0, CC BY 2.0, CC BY 4.0, Public Domain — see assets/brand/jensen/sources.json).
// Independent open-source community tribute; not affiliated with or endorsed by NVIDIA Corporation.

export const JENSEN_NVIDIA_LOGO = Object.freeze({
  src: '../../assets/brand/jensen/nvidia-logo.svg',
  alt: 'NVIDIA logo',
});

export const JENSEN_PORTRAITS = Object.freeze([
  Object.freeze({
    id: 'leather-jacket-2023',
    src: '../../assets/brand/jensen/jensen-leather-jacket.jpg',
    alt: 'Jensen Huang speaking at podium in his trademark black pebble-leather jacket',
    caption: 'Trademark Black Leather Jacket · Taipei (2023)',
    credit: 'Photo: Office of the President (Taiwan) · CC BY 2.0',
  }),
  Object.freeze({
    id: 'stage-gpu-sc18',
    src: '../../assets/brand/jensen/jensen-stage-gpu.jpg',
    alt: 'Jensen Huang on stage in black leather jacket holding an NVIDIA GPU accelerator beside a DGX faceplate',
    caption: 'Keynote Architecture Reveal · Holding Tensor Silicon',
    credit: 'Photo: Raysonho @ Grid Engine · CC0 1.0 Public Domain',
  }),
  Object.freeze({
    id: 'portrait-2024',
    src: '../../assets/brand/jensen/jensen-portrait-2024.jpg',
    alt: 'Close-up portrait of Jensen Huang smiling in black leather moto jacket (2024)',
    caption: 'Accelerated Computing & Sovereign AI Era (2024)',
    credit: 'Photo: Peter Dasilva / European Union · CC BY 4.0',
  }),
]);

export const JENSEN_TIMELINE_MILESTONES = Object.freeze([
  Object.freeze({
    year: '2021',
    period: 'Apr – Nov 2021',
    title: 'Grace CPU Architecture, Omniverse & Open NeMo / Triton Scale-Out',
    impact: 'Unveiled the Grace Arm data-center CPU for giant-scale AI supercomputing and expanded Megatron-LM multi-node transformer training.',
    openSource: 'Expanded Apache-2.0 NVIDIA NeMo for open conversational/LLM training and Triton Inference Server for multi-framework model serving.',
  }),
  Object.freeze({
    year: '2022',
    period: 'Mar & May 2022',
    title: 'Hopper H100 Transformer Engine & Open-Source Linux GPU Kernel Modules',
    impact: 'Introduced Hopper H100 with dynamic FP8 Transformer Engine and 4th-Gen NVLink — the silicon foundation of the global generative AI wave.',
    openSource: 'Published dual MIT/GPLv2 open-source Linux GPU kernel modules (R515+), transforming upstream Linux and data-center GPU integration.',
  }),
  Object.freeze({
    year: '2023',
    period: 'Apr – Oct 2023',
    title: 'Generative AI Inflection, Grace Hopper GH200 & TensorRT-LLM',
    impact: 'Shipped coherent Grace Hopper GH200 superchips and Spectrum-X AI Ethernet fabric as the CUDA developer ecosystem surpassed 4 million builders.',
    openSource: 'Open-sourced TensorRT-LLM and NeMo Guardrails under Apache-2.0, giving the open-weights community state-of-the-art quantized LLM inference.',
  }),
  Object.freeze({
    year: '2024',
    period: 'Mar – Sep 2024',
    title: 'Blackwell B200 / GB200 NVL72 & Nemotron-4 340B Open Weights',
    impact: 'Unveiled 208B-transistor Blackwell GPUs with 2nd-Gen FP4 Transformer Engine and 72-GPU NVLink rack-scale AI factories.',
    openSource: 'Released Nemotron-4 340B open weights + synthetic data pipeline, Llama-3.1-Nemotron-70B, CUTLASS 3.x kernels, and co-founded the Alliance for OpenUSD.',
  }),
  Object.freeze({
    year: '2025',
    period: 'Jan – Mar 2025',
    title: 'DGX Spark (GB10) Personal AI Supercomputer, Cosmos & Isaac GR00T',
    impact: 'Launched DGX Spark (Project DIGITS) — bringing 1 petaflop of Grace Blackwell compute and 128 GB unified memory directly to local developers’ desks.',
    openSource: 'Released Cosmos open world-foundation models, Isaac GR00T N1 open humanoid robotics weights, Llama-Nemotron reasoning models, and Apache-2.0 NVIDIA Dynamo.',
  }),
  Object.freeze({
    year: '2026',
    period: 'Apr – Nov 2026',
    title: 'IEEE Medal of Honor, 650+ Open Models & 33-Year Founding Legacy',
    impact: 'Awarded the 2026 IEEE Medal of Honor and contributed open Vera Rubin rack specifications at OCP before concluding a historic 33-year CEO tenure (1993–2026).',
    openSource: 'Surpassed 650 open models and 250 open datasets on Hugging Face (Nemotron 3, Clara, Isaac ROS) and donated OpenShell to the open-source community.',
  }),
]);

export const JENSEN_TAB_BACKDROPS = Object.freeze([
  Object.freeze({ tab: 'dashboard', label: 'Dashboard', asset: 'bg-01-dgx-spark.svg', innovation: 'DGX Spark & GB10 Superchip' }),
  Object.freeze({ tab: 'discover', label: 'FrostNet', asset: 'bg-02-nvlink-fabric.svg', innovation: 'NVLink & Spectrum-X Fabric' }),
  Object.freeze({ tab: 'transfers', label: 'Transfers', asset: 'bg-03-gpudirect-hbm.svg', innovation: 'GPUDirect RDMA & HBM3e' }),
  Object.freeze({ tab: 'library', label: 'My Models', asset: 'bg-04-nemotron-open.svg', innovation: 'Nemotron & NeMo Open Weights' }),
  Object.freeze({ tab: 'catalog', label: 'Torrents', asset: 'bg-05-cuda-grid.svg', innovation: 'CUDA SIMT Parallel Grid' }),
  Object.freeze({ tab: 'hf', label: 'Models', asset: 'bg-06-tensor-core.svg', innovation: 'FP8 / FP4 Tensor Core Array' }),
  Object.freeze({ tab: 'spark', label: 'Devices', asset: 'bg-07-grace-blackwell.svg', innovation: 'Grace Blackwell Superchips' }),
  Object.freeze({ tab: 'settings', label: 'Settings', asset: 'bg-08-omniverse-grid.svg', innovation: 'Omniverse, OpenUSD & RTX' }),
]);

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[ch]));

export function renderJensenTributeCard(container, { onSelectTab } = {}) {
  if (!container) return;
  if (!container.dataset.jensenMounted) {
    const years = ['all', ...JENSEN_TIMELINE_MILESTONES.map(item => item.year)];
    container.innerHTML = `
      <div class="jensen-rights-notice" role="note" aria-label="Community creation and rights notice">
        <svg class="jensen-rights-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2 18 17H2L10 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8v4M10 14.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <p class="jensen-rights-text"><strong>Community creation — we do not own these rights.</strong> This tribute is made by the FrostByte open-source community out of admiration. The NVIDIA name, eye logo, and trademarks belong to <strong>NVIDIA Corporation</strong>; they are shown for identification and homage only. This theme is not affiliated with, sponsored, or endorsed by NVIDIA, and Jensen Huang's name, likeness, and signature appear purely as a tribute. Photographs and the NVIDIA logo are bundled under their respective CC / public-domain licenses (credits below).</p>
      </div>

      <div class="jensen-lockup">
        <img class="jensen-nvidia-logo" src="${esc(JENSEN_NVIDIA_LOGO.src)}" alt="${esc(JENSEN_NVIDIA_LOGO.alt)}" />
        <span class="jensen-lockup-x" aria-hidden="true">×</span>
        <span class="jensen-lockup-jensen">Jensen Huang</span>
        <span class="jensen-lockup-tag">To us, Jensen is NVIDIA</span>
      </div>

      <div class="jensen-tribute-stitch">
        <div class="jensen-tribute-header">
          <div>
            <span class="jensen-tribute-kicker">Founders Leather · NVIDIA Community Tribute</span>
            <h4 class="jensen-tribute-title">Thank You, Jensen Huang — 33 Years of Accelerated Computing</h4>
            <p class="jensen-tribute-sub">
              To us, Jensen is NVIDIA. Honoring the co-founder and founding CEO (1993–2026): from programmable shading and the 20-year bet on CUDA to deskside Grace Blackwell supercomputers and hundreds of open-weight models empowering local AI builders everywhere.
            </p>
          </div>
          <span class="jensen-era-badge">1993 – 2026 · 33-Year Founding Run</span>
        </div>
      </div>

      <div class="jensen-gallery" aria-label="Jensen Huang commemorative photography">
        ${JENSEN_PORTRAITS.map(photo => `
          <figure class="jensen-photo-frame" data-jensen-photo="${esc(photo.id)}">
            <img src="${esc(photo.src)}" alt="${esc(photo.alt)}" loading="lazy" decoding="async" />
            <figcaption>
              <span class="jensen-photo-caption">${esc(photo.caption)}</span>
              <span class="jensen-photo-credit">${esc(photo.credit)}</span>
            </figcaption>
          </figure>
        `).join('')}
      </div>

      <div class="jensen-appreciation">
        <p>
          <strong>A moment of appreciation from the open-model community.</strong>
          Across three decades in his signature black leather jacket, Jensen turned graphics processors into scientific instruments — then paired world-leading silicon with open Linux kernel modules, Apache-2.0 inference stacks (<strong>TensorRT-LLM</strong>, <strong>Triton</strong>, <strong>NeMo</strong>, <strong>Dynamo</strong>), open <strong>Nemotron / Cosmos / GR00T</strong> weights, and personal <strong>DGX Spark</strong> hardware so anyone can run frontier intelligence on their own machine.
        </p>
        <div class="jensen-signature-wrap">
          <img class="jensen-signature-img" src="../../assets/brand/jensen/jensen-signature.svg" alt="Jensen Huang signature" decoding="async" />
          <span class="jensen-signature-label">Jen-Hsun “Jensen” Huang</span>
        </div>
      </div>

      <div class="jensen-timeline-section">
        <div class="jensen-timeline-head">
          <h5>Five Years That Reshaped AI &amp; Open Source (2021 – 2026)</h5>
          <div class="jensen-year-pills" role="tablist" aria-label="Filter timeline by year">
            ${years.map((yr, idx) => `
              <button
                type="button"
                class="jensen-year-pill"
                role="tab"
                data-jensen-year="${esc(yr)}"
                aria-controls="jensen-timeline-list"
                aria-selected="${idx === 0 ? 'true' : 'false'}"
                tabindex="${idx === 0 ? '0' : '-1'}"
              >${yr === 'all' ? 'All (2021–2026)' : esc(yr)}</button>
            `).join('')}
          </div>
        </div>
      </div>

      <div class="jensen-timeline-list" id="jensen-timeline-list">
        ${JENSEN_TIMELINE_MILESTONES.map(m => `
          <article class="jensen-milestone" data-milestone-year="${esc(m.year)}">
            <div class="jensen-milestone-top">
              <span class="jensen-milestone-year">${esc(m.year)}</span>
              <span class="jensen-milestone-date">${esc(m.period)}</span>
            </div>
            <h6 class="jensen-milestone-title">${esc(m.title)}</h6>
            <p class="jensen-milestone-row"><span class="jensen-milestone-tag impact">AI Industry</span>${esc(m.impact)}</p>
            <p class="jensen-milestone-row"><span class="jensen-milestone-tag oss">Open Source</span>${esc(m.openSource)}</p>
          </article>
        `).join('')}
      </div>

      <div class="jensen-backdrop-atlas">
        <div class="jensen-timeline-head">
          <h5>Per-Tab Innovation Backdrops (Click a Tab to View Its Blueprint)</h5>
        </div>
        <div class="jensen-atlas-grid">
          ${JENSEN_TAB_BACKDROPS.map(entry => `
            <button type="button" class="jensen-atlas-btn" data-jensen-goto="${esc(entry.tab)}">
              <span class="jensen-atlas-tab">${esc(entry.label)}</span>
              <span class="jensen-atlas-name">${esc(entry.innovation)}</span>
            </button>
          `).join('')}
        </div>
      </div>

      <p class="jensen-tribute-disclaimer">
        Independent open-source community creation — we do not own the NVIDIA name, eye logo, or trademarks, which belong to NVIDIA Corporation. FrostByte is not affiliated with, sponsored by, or endorsed by NVIDIA Corporation. NVIDIA, CUDA, GeForce, RTX, DGX, NVLink, Hopper, Grace, Blackwell, Omniverse, TensorRT, NeMo, and Nemotron are trademarks of NVIDIA Corporation. Photographs licensed under CC0 1.0, CC BY 2.0, and CC BY 4.0; the NVIDIA logo is public-domain geometry (full provenance in <code>assets/brand/jensen/sources.json</code>).
      </p>
    `;

    const applyYearFilter = selectedYear => {
      const pills = [...container.querySelectorAll('[data-jensen-year]')];
      pills.forEach(btn => {
        const active = btn.dataset.jensenYear === selectedYear;
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
        btn.setAttribute('tabindex', active ? '0' : '-1');
      });
      container.querySelectorAll('[data-milestone-year]').forEach(card => {
        card.hidden = selectedYear !== 'all' && card.dataset.milestoneYear !== selectedYear;
      });
    };

    container.addEventListener('click', event => {
      const yearBtn = event.target.closest('[data-jensen-year]');
      if (yearBtn) {
        applyYearFilter(yearBtn.dataset.jensenYear);
        return;
      }
      const tabBtn = event.target.closest('[data-jensen-goto]');
      if (tabBtn && typeof onSelectTab === 'function') {
        const targetTab = tabBtn.dataset.jensenGoto;
        onSelectTab(targetTab);
        if (targetTab === 'settings') {
          document.querySelector('.settings-body')?.scrollTo({ top: 0, behavior: 'smooth' });
        }
      }
    });

    container.addEventListener('keydown', event => {
      const yearBtn = event.target.closest('[data-jensen-year]');
      if (!yearBtn || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const pills = [...container.querySelectorAll('[data-jensen-year]')];
      const index = pills.indexOf(yearBtn);
      if (index < 0) return;
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % pills.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index + pills.length - 1) % pills.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = pills.length - 1;
      const next = pills[nextIndex];
      next.focus();
      applyYearFilter(next.dataset.jensenYear);
    });

    container.dataset.jensenMounted = '1';
  }
}
