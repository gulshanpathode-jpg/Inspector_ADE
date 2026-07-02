# Inspector ADE - Extension

The Chrome MV3 side-panel extension. **Load this folder unpacked** at
`chrome://extensions` (Developer mode → Load unpacked).

It scrapes the **inspectorade.com** inspection modal (the Approve/Reject form),
verifies answers with AI via the backend on `http://localhost:3001`, and lets you
apply suggestions back into the form.

- `manifest.json` — MV3, side panel, matches `inspectorade.com/*`.
- `background.js` — opens the side panel; on-demand content-script injection.
- `content.js` — scrapes the modal (`#custom-form-body` questions, `#images`
  current-inspection photos, the Address header), applies answers back, and
  drives the focus/flash + in-page image viewer.
- `imageModal.js` — on-page image viewer (zoom / pan / prev-next).
- `sidepanel.html` / `.css` / `.js` — the UI (SmartFill design system, rebranded).

See the project root **README.md** (full functionality + request/response
contract) and **CONTEXT.md** (deep page-structure notes / handoff doc).
