# README visual assets

- `hero.svg`: original vector wordmark/banner for this README; brand credit Blackfrost_AI/SI. Not an application screenshot.
- `transfers-preview.png`: current renderer Transfers panel, synthetic fixture data.
- `devices-preview.png`: current renderer Devices (`spark`) panel, synthetic fixture data.

Captured from `scripts/preview.html` in local headless Playwright Chromium at a 1440×960 viewport. Panel crop: x=196, y=45, width=1244, height=840. The crop omits navigation; visible application panel content is not composited. Caption labels in the README identify simulation because the preview's floating simulation badge is outside the crop.

All non-loopback requests were blocked. Fixture model names, speeds, hashes, paths and hardware are illustrative—not benchmarks, verified content provenance or real device measurements. No user profile was opened.

The preview fixture predates the current network-device bridge. For capture only, the intercepted `preview-fixture.js` response added `networkDevices: { onChanged: () => () => {}, snapshot: async () => ({}) }` to the fixture API. No app or preview source files were modified. This avoids live discovery while allowing the current renderer to initialize. The query used `theme=frost`; the renderer displayed its green default theme, so no custom blue-theme claim is made. The banner's blue palette is editorial branding, separate from application theming.

These images do not prove end-to-end runtime compatibility or release readiness. No Assistant screenshot is included: the legacy fixture does not establish a working current inference session. Capture a supported local session before adding one.
