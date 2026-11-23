# AEON Orb theme — design system

**Scope:** optional visual theme (`data-theme="aeon"`), bundled artwork/fonts, and the development preview.
**Audience:** FrostByte + AEON partnership UI — keep this file the source of truth when adding views.

## Intent

Public theme name in Settings: **AEON Orbit - a space theme for everyone**.

Settings credit link: [**AEON Forge / @SpaceTimeViking**](https://x.com/SpaceTimeViking), defined by `AEON_X` in `src/shared/aeon.js`.

Cyberpunk × brutalist × futurist × dark × elegant console.
One violet **signal** accent, cyan for **live/info** state, hard edges, inscribed labels, Orb mark in the titlebar.

Inherited from AEON Magick Orb’s “stele” language (inscription, proportion, aether light) — adapted to FrostByte’s dense LimeWire-style chrome without neon wallpaper.

## Tokens (`[data-theme="aeon"]`)

| Token | Role | Value |
|---|---|---|
| `--lime` | Primary signal / selected / primary CTA | `#B794FF` violet |
| `--lime-dim` | Pressed / secondary signal | `#7C5CCF` |
| `--lime-glow` / `--lime-line` | Selection wash / hairline | translucent violet |
| `--abyss` | App canvas | `#05060D` |
| `--surface` / `--surface-hi` | Panels / hover | `#0B0E18` / `#14182A` |
| `--border` / `--border-strong` | Chassis lines | `#1E2438` / `#3A4466` |
| `--text` / `--text-dim` / `--text-faint` | Inscription hierarchy | `#E8EAFF` / `#9AA3C7` / `#8792B8` |
| `--info` / `--down` | Live / download / focus ring | `#3DE7FF` cyan |
| `--up` | Upload | `#D4A8FF` |
| `--warn` / `--danger` | Fault states | amber / hot pink-red |
| `--ui` | Display / chrome type | `AeonDisplay` → Orbitron |
| `--mono` | Readouts / paths / hashes | `AeonMono` → Share Tech Mono |
| `--radius-panel` / `--radius-ctl` | Brutalist corners | `2px` |
| `--inscribe-tracking` | Label tracking | `.14em` |

**Rules**
1. **One accent.** Violet (`--lime`) means action/selection. Cyan (`--info`) means live/state/focus — never both fighting on the same control.
2. **No soft blobs.** Prefer hairlines, inset top light, 2px radii. Outer neon glows only as tiny CTA blooms.
3. **Inscription.** Section labels, table headers, nav: uppercase + wide tracking + `--ui`.
4. **Readouts.** Speeds, peers, CIDs, hashes: `--mono` + tabular nums.
5. **Scanline / starfield** are atmosphere only — never reduce text contrast below 4.5:1 for small text, including secondary labels.

## Brand mark

| Theme | Titlebar icon |
|---|---|
| frost / abyss / malachite | `assets/brand/app-icon.png` (`.brand-frost`) |
| **aeon** | `assets/brand/aeon-orb.png` (`.brand-orb`) — AEON Magick Orb logo |

`applyTheme()` toggles `.brand-frost` / `.brand-orb` `hidden`. Do not show both.

Logo source: AEON-7/aeon-magick-ai-computer-control `docs/images/orb.png` (512²).

## Typography

| Role | Face | License note |
|---|---|---|
| Display (target) | **Valorax** (Maknastudio) | Free download = **personal use only**. Buy commercial license before shipping in FrostByte/AEON product UI: https://maknastudio.com/product/valorax/ |
| Display (bundled) | **Orbitron** | [SIL OFL 1.1](../licenses/fonts/orbitron/OFL.txt) — `assets/fonts/Orbitron.ttf` |
| Mono | **Share Tech Mono** | [SIL OFL 1.1](../licenses/fonts/sharetechmono/OFL.txt) — `assets/fonts/ShareTechMono-Regular.ttf` |

Valorax is not bundled. A future font replacement needs its own licensing review, packaging entries, protocol support, and native font-loading check. The current Orbitron and Share Tech Mono bytes are unchanged; provenance and hashes are in [the font inventory](../assets/fonts/sources.json).

## Components to restyle under aeon

Always gate with `[data-theme="aeon"] …` so other themes stay untouched:

- `.titlebar` / `.brand` / `.omnisearch`
- `.sidebar` / `.nav` / `.navlabel` / `.boxstat` / `.sb-footer`
- `.btn` / `.btn.primary`
- `.viewhead` / tables `.grid` / `.mx` filters
- `.aeon-device-space` + tool buttons (Orb connected panel)
- `.ipfs-transfer*` (Aether / IPFS rows)

**New UI checklist** (paste into PR description):

- [ ] Uses existing tokens — no one-off hex except inside the aeon block
- [ ] Accent vs info roles respected
- [ ] Labels inscribed (uppercase + tracking) where other chrome is
- [ ] Data in `--mono`
- [ ] Radius ≤ 2px under aeon
- [ ] Contrast checked on abyss background
- [ ] Works with Orb mark + without (other themes)

## Theme files

```
docs/AEON-THEME.md                          ← this file
assets/brand/aeon-orb.png                   ← Orb logo
assets/fonts/Orbitron.ttf                   ← OFL display font
assets/fonts/ShareTechMono-Regular.ttf      ← OFL mono
src/renderer/styles.css                     ← @font-face + aeon tokens/rules
src/renderer/index.html                     ← dual brand marks + theme label
src/renderer/app.js                         ← applyTheme toggles marks
```

## Safety

- Theme cannot grant device access (`src/shared/aeon.js` already: “A theme never grants device access”).
- No changes to companions, SSH, IPFS publish, or tokens in this patch.
- The preview loads current renderer markup, including the consent dialog, through a browser-only mock bridge. Mock acceptance belongs only to that harness; the desktop consent flow has no preview bypass.
- Preview API operations never connect to devices, start transfers, save credentials, or send feedback. Unsupported actions show a preview notice. The fixture labels and rates are simulated.

## Preview

```bash
# from repo root
python3 -m http.server 8765 --bind 127.0.0.1
# open http://127.0.0.1:8765/scripts/preview.html?theme=aeon&view=transfers
# also try: view=spark | view=settings | view=hf
```

## Mac + Windows

Mac and Windows package the same assets. `npm run test:release` checks builder inclusion and license integrity; `tests/e2e/aeon-ipfs.spec.js` checks theme switching, actual native font loading, layout, and device-scoped tools. `npm run test:packaged` verifies both marks and fonts load from the packaged app and that the complete font notices ship.

The preview uses the current renderer HTML rather than a copied page. Serve the repository on loopback as above; `view=spark` includes an explicitly simulated AEON Pi. `hf=qwen&hfsel=Qwen/Qwen3-8B` opens a fixture search/detail view. No preview code or sample transfers are included in installers.
