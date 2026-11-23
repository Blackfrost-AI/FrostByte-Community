# Frost/Byte brand artwork

Created with the built-in imagegen tool for this project.

- `app-icon-master.png`: original generated artwork with alpha transparency.
- `app-icon.png`: 1024 px PNG used by the app and development Dock icon.
- `logo-dark.png`: finished horizontal Frost/Byte wordmark on dark graphite.
- `../../build/icon.icns`: native macOS icon with 16–1024 px representations.

Run `npm run build:icon` on macOS to regenerate the PNG and ICNS. The script
only resamples and converts the original artwork with Apple’s `sips`/`iconutil`;
creative generation and editing used imagegen. The first logo concept is retained
under `concepts/` and is excluded from the application bundle.

Final generation/edit prompts are recorded in `prompts.md`.
