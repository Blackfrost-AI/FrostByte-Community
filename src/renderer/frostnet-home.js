/**
 * FrostNet community home (P3) — the front page for local AI.
 *
 * Sections: operator news (pinned + announcements + public release notes),
 * recently shared recipes (with memory-fit badges), recipes from creators you
 * follow (signed-in, server graph), creator strip, signed app-update check
 * (Plus/Pro, existing hub:check-update — no new update plumbing), community
 * links, and the offline bundle seed card (kept from P0).
 *
 * Honesty rules:
 * - Hub unreachable → explicit error state + Retry; community links and
 *   Open Search always work (they need no hub).
 * - Signed-out follows are device-local and never sent anywhere; the opt-in
 *   "Add to my account" migration is the ONLY path from device list to server.
 * - All announcement/release bodies are plain text rendered via textContent
 *   or escaped interpolation — never innerHTML of server content.
 */
import { esc, fmtBytes } from './dom.js';
import { fitHint } from './hf-variants.js';

export function createFrostnetHome({ api, toast, state, goTab, openRecipeInSearch, memoryBytes }) {
  let loaded = false;
  let loading = false;
  let migrateDismissed = false;
  let serverFollows = null; // null = unknown; [] = signed-in with empty graph
  let lastFeed = null;

  const signedIn = () => Boolean(state.hubAccount?.signedIn);
  const localFollows = () => state.hubConfig?.follows || [];

  function setStatus(text, kind = 'hint') {
    const el = document.getElementById('fn-home-status');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
    el.className = `hf-help fn-home-status${kind === 'error' ? ' fn-home-error' : ''}`;
  }

  function recipeCard(row) {
    const creator = row.creator || {};
    const who = creator.handle ? `@${creator.handle}` : (creator.displayName || `${String(row.publisher || '').slice(0, 8)}…`);
    const verified = creator.verified ? ' <span class="fn-verified" title="Bound publisher key">✓</span>' : '';
    const bytes = Number(row.totalBytes || 0);
    const fit = bytes > 0 ? fitHint(bytes, memoryBytes()) : null;
    const fitBadge = fit ? `<span class="hf-fit fit-${fit.cls}" title="${esc(fit.title)}">${esc(fit.label)}</span>` : '';
    return `<div class="fn-home-card" role="button" tabindex="0" data-home-recipe="${esc(row.id)}" data-home-pubkey="${esc(row.publisher || '')}">
      <div class="fn-home-card-title">${esc(row.title || row.id)}</div>
      <div class="fn-home-card-meta">
        <span class="fn-home-creator">${esc(who)}${verified}</span>
        ${row.kind ? `<span class="hf-tag">${esc(row.kind)}</span>` : ''}
        ${fitBadge}
        ${bytes > 0 ? `<span class="hf-help">${esc(fmtBytes(bytes))}</span>` : ''}
      </div>
      ${row.description ? `<p class="fn-home-card-desc">${esc(row.description)}</p>` : ''}
    </div>`;
  }

  function newsItem(item, kind) {
    const when = kind === 'release' ? (item.released || '') : String(item.publishedAt || '').slice(0, 10);
    const tag = kind === 'release' ? `v${item.version}` : (item.tag || '');
    return `<article class="fn-home-news-item${item.pinned ? ' fn-home-pinned' : ''}">
      <div class="fn-home-news-head">
        ${item.pinned ? '<span class="hf-tag">Pinned</span>' : ''}
        ${tag ? `<span class="hf-tag">${esc(tag)}</span>` : ''}
        <strong>${esc(item.title)}</strong>
        ${when ? `<span class="hf-help">${esc(when)}</span>` : ''}
      </div>
      <p class="fn-home-news-body">${esc(item.body)}</p>
    </article>`;
  }

  function renderNews(feed) {
    const section = document.getElementById('fn-home-news');
    const list = document.getElementById('fn-home-news-list');
    if (!section || !list) return;
    const items = [
      ...(feed.pinned || []).map(i => newsItem(i, 'announcement')),
      ...(feed.announcements || []).map(i => newsItem(i, 'announcement')),
      ...(feed.releases || []).map(i => newsItem(i, 'release')),
    ];
    section.hidden = items.length === 0;
    list.innerHTML = items.join('');
  }

  function renderRecent(feed) {
    const el = document.getElementById('fn-home-recent');
    if (!el) return;
    const rows = feed.recipes || [];
    el.innerHTML = rows.length
      ? rows.map(recipeCard).join('')
      : '<p class="hf-help">Nothing shared yet. Publish a recipe from Search → FrostNet and it will appear here.</p>';
  }

  async function renderFollowing() {
    const section = document.getElementById('fn-home-following');
    const list = document.getElementById('fn-home-following-list');
    if (!section || !list) return;
    if (!signedIn()) { section.hidden = true; return; }
    section.hidden = false;
    try {
      const feed = await api.hubFeed({ following: true, limit: 10 });
      const rows = feed.recipes || [];
      list.innerHTML = rows.length
        ? rows.map(recipeCard).join('')
        : '<p class="hf-help">No shares from creators you follow yet. Follow creators from Search → FrostNet.</p>';
    } catch (err) {
      list.innerHTML = `<p class="hf-help fn-home-error">Following feed unavailable: ${esc(err.message || err.code || 'error')}</p>`;
    }
  }

  async function renderCreators() {
    const el = document.getElementById('fn-home-creators');
    if (!el) return;
    const keys = signedIn() ? (serverFollows || []).map(f => f.pubkey) : localFollows();
    if (!keys.length) {
      el.innerHTML = `<p class="hf-help">${signedIn() ? 'Follow creators from Search to see them here.' : 'Follow creators from Search to see them here. Signed-out follows stay on this device.'}</p>`;
      return;
    }
    const shown = keys.slice(0, 8);
    const cards = await Promise.all(shown.map(async (key) => {
      try {
        const res = await api.hubCreator(key);
        const c = res?.creator || res || {};
        const name = c.handle ? `@${c.handle}` : (c.displayName || `${key.slice(0, 8)}…`);
        const stats = res?.stats || c.stats || {};
        return `<div class="fn-home-creator-card">
          <strong>${esc(name)}</strong>${c.verified ? ' <span class="fn-verified" title="Bound publisher key">✓</span>' : ''}
          <span class="hf-help">${Number(stats.recipes || 0)} recipes · ${Number(stats.followers || 0)} followers</span>
        </div>`;
      } catch {
        return `<div class="fn-home-creator-card"><strong>${esc(key.slice(0, 8))}…</strong><span class="hf-help">profile unavailable</span></div>`;
      }
    }));
    el.innerHTML = cards.join('') + (keys.length > shown.length ? `<p class="hf-help">+${keys.length - shown.length} more</p>` : '');
  }

  async function renderUpdates() {
    const el = document.getElementById('fn-home-updates');
    if (!el) return;
    if (!signedIn()) {
      el.innerHTML = '<p class="hf-help">Sign in with a Plus or Pro account to get signed update checks. Public release news is in “News &amp; updates”.</p>';
      return;
    }
    const tier = String(state.hubEntitlement?.tier || 'free').toLowerCase();
    if (tier !== 'plus' && tier !== 'pro') {
      el.innerHTML = '<p class="hf-help">Signed update checks are a Plus/Pro feature. Public release news is in “News &amp; updates”.</p>';
      return;
    }
    el.innerHTML = '<button class="btn sm" id="fn-home-check-update">Check for app updates</button><p class="hf-help" id="fn-home-update-note"></p>';
    document.getElementById('fn-home-check-update')?.addEventListener('click', async () => {
      const note = document.getElementById('fn-home-update-note');
      const btn = document.getElementById('fn-home-check-update');
      if (btn) btn.disabled = true;
      try {
        const res = await api.hubCheckUpdate();
        if (note) {
          note.textContent = res?.updateAvailable
            ? `Update available: ${res.latestVersion || res.version || 'newer build'} — open Settings → Account to install.`
            : 'You are on the latest version.';
        }
      } catch (err) {
        if (note) note.textContent = `Update check failed: ${err.message || err.code || 'error'}`;
      } finally {
        if (btn) btn.disabled = false;
      }
    }, { once: true });
  }

  function renderMigrateBanner() {
    const banner = document.getElementById('fn-home-migrate');
    const note = document.getElementById('fn-home-migrate-note');
    if (!banner || !note) return;
    const local = localFollows();
    const show = signedIn() && local.length > 0 && !migrateDismissed;
    banner.hidden = !show;
    if (show) note.textContent = `This device follows ${local.length} creator${local.length === 1 ? '' : 's'}. Add them to your account so they follow you across machines? Nothing is sent until you press the button.`;
  }

  async function refreshGraph() {
    if (!signedIn()) { serverFollows = null; return; }
    try {
      const res = await api.hubMeFollows();
      serverFollows = res?.follows || [];
    } catch {
      serverFollows = serverFollows || [];
    }
  }

  async function load({ refresh = false } = {}) {
    if (loading) return;
    loading = true;
    setStatus('Loading FrostNet…');
    try {
      await refreshGraph();
      const feed = await api.hubFeed({ limit: 12, refresh });
      lastFeed = feed;
      loaded = true;
      setStatus('');
      renderNews(feed);
      renderRecent(feed);
      await renderFollowing();
      await renderCreators();
      await renderUpdates();
      renderMigrateBanner();
    } catch (err) {
      const code = err?.code || '';
      const msg = code === 'hub_not_configured'
        ? 'FrostNet needs its hub connection configured. Community links and Search still work.'
        : `FrostNet is unreachable right now (${err.message || code || 'network error'}). Community links and Search still work.`;
      setStatus(msg, 'error');
      const recent = document.getElementById('fn-home-recent');
      if (recent && !loaded) recent.innerHTML = `<p class="hf-help fn-home-error">${esc(msg)} <button class="btn sm" id="fn-home-retry">Retry</button></p>`;
      document.getElementById('fn-home-retry')?.addEventListener('click', () => load({ refresh: true }), { once: true });
      // Side sections that need no hub still render.
      await renderCreators().catch(() => {});
      await renderUpdates().catch(() => {});
      renderMigrateBanner();
    } finally {
      loading = false;
    }
  }

  function wire() {
    document.getElementById('fn-home-refresh')?.addEventListener('click', () => load({ refresh: true }));
    document.getElementById('hub-coming-search')?.addEventListener('click', () => goTab('hf'));
    document.getElementById('fn-home-migrate-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('fn-home-migrate-btn');
      if (btn) btn.disabled = true;
      try {
        const res = await api.hubFollowsMigrate();
        toast?.(`Added ${res.migrated} follow${res.migrated === 1 ? '' : 's'} to your account${res.failed ? ` (${res.failed} failed — kept on device)` : ''}.`, res.failed ? 'warn' : 'ok');
        migrateDismissed = true;
        await load({ refresh: true });
      } catch (err) {
        toast?.(`Migration failed: ${err.message || err.code || 'error'}`, 'warn');
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    document.getElementById('fn-home-migrate-dismiss')?.addEventListener('click', () => {
      migrateDismissed = true;
      renderMigrateBanner();
    });
    // Recipe cards open the full signed detail in Search → FrostNet.
    const grid = document.querySelector('.fn-home');
    grid?.addEventListener('click', (e) => {
      const card = e.target.closest('[data-home-recipe]');
      if (card && openRecipeInSearch) openRecipeInSearch(card.dataset.homeRecipe);
    });
    grid?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('[data-home-recipe]');
      if (card && openRecipeInSearch) { e.preventDefault(); openRecipeInSearch(card.dataset.homeRecipe); }
    });
  }

  return { wire, load, renderMigrateBanner, get lastFeed() { return lastFeed; } };
}