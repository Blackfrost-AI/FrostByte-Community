# Contributing to FrostByte Community

Thanks for helping give everyone access to open models.

## Ground rules

- Be respectful — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Security issues: follow [SECURITY.md](SECURITY.md), never a public issue.
- Model licensing: never add catalog entries whose license forbids
  redistribution, and never describe community-licensed weights (Llama,
  Gemma, …) as "open source". Per-entry license labels are required.
- No telemetry, ads, or silent network calls. Privacy regressions are blockers.

## Developer Certificate of Origin (DCO)

We use the DCO instead of a CLA. Sign off every commit:

```
git commit -s -m "fix: ..."
```

This appends `Signed-off-by: Your Name <you@example.com>` and certifies you
have the right to submit the contribution under Apache-2.0
(https://developercertificate.org/).

## Development setup

```sh
npm ci            # Node 22.12+ / npm 11.17+; never copy node_modules across OSes
npm start         # launch the app in development
npm test          # full desktop suite (unit + managers + reliability + e2e)
npm run test:e2e  # desktop workflows only (isolated temporary profile)
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for architecture and
[docs/PACKAGING.md](docs/PACKAGING.md) for platform builds. Live Hugging Face
checks need internet; hardware-gated specs skip cleanly without devices.

## Pull requests

1. Fork / branch from `main`; keep changes focused.
2. Add or update tests for behavior changes; `npm test` must pass.
3. Update user-facing docs when behavior changes.
4. Sign off commits (DCO) and describe what you verified, not just what you
   changed. Screenshots help for UI work.
5. CI must be green before review. Maintainers merge; releases are cut by
   Blackfrost AI/SI only.

## Style

- Match surrounding code; ES modules in the renderer, explicit preload bridge,
  context isolation stays on.
- Prefer small, reviewable diffs over sweeping refactors.