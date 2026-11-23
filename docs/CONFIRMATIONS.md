# Confirmation choices

Development change after 0.3.0; not yet published.

FrostByte shows a short summary before an action: the model or file, destination,
size, and any relevant sharing or account use. **Details…** opens the full request,
including exact paths, addresses, pinned revisions, and verification hashes.
**Back** returns to the summary. Cancel and Escape cancel the action in either view.

Routine prompts offer **Never show again**. Tick it and approve the action to save
the choice on this computer. Ticking it and cancelling saves nothing. Choices
survive restarts. Reset them under **Settings → Interface → Confirmations**.
Reset also clears temporary search and discovery approvals in the current session.
The separate large-download and quit-while-sharing reminders also have checkboxes
in their dialogs; their existing Settings switches turn them back on.

Remembered choices apply to the action described in the checkbox:

- Public Hugging Face browsing; authenticated browsing is a separate choice for
  the current saved credential. Replacing that credential asks again.
- Hugging Face downloads to a particular local folder with the current credential,
  or public downloads to a particular paired device and folder.
- Copying text, opening Hugging Face model pages, public torrent discovery,
  and reading dropped torrent metadata in a particular folder.
- IPFS lookups on a particular device, or downloads to a particular device folder.

Sharing files publicly, deleting files, trusting or changing device access,
sending an account token to a device, changing credentials, accepting updated
legal notices, and enabling diagnostics still require confirmation.

## Implementation and verification

Only the main process can save a permission, after an affirmative native dialog
response with its checkbox checked. Renderer settings cannot create grants;
the renderer can read the count and reset them. Existing endpoint, file,
credential, manifest, and device validation still runs on every action, including
actions covered by a remembered choice.

`confirmations.json` contains versioned, bounded hashes of permission scopes, not
searches, model names, paths, tokens, or device credentials. Device grants bind to
the saved connection identity. Corrupt, unsupported, linked, or oversized files
are ignored, so prompts return. A reset invalidates approvals already open.

Unit tests cover compact/detail views, cancellation, restart, reset races,
credential and destination changes, and persistence failures. Desktop tests
exercise real IPC handlers and Settings, including remembered searches across
restart and the large-download reminder. Existing boundary suites open Details
to verify exact destinations and stale-approval rejection.

Verified locally on September 14, 2026: Mac desktop flows include live HF
search/download/resume, torrent download/sharing, device inventory and approval
checks, IPFS, privacy, and the new confirmation controls. The 15 native review and
preference tests also pass on the owner's Windows PC using an isolated temporary
folder. The macOS native Details/Back layout and checkbox were exercised in a
separate preview. Existing 0.3.0 installers and owner installations are unchanged.
