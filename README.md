# Inspector ADE

A Chrome side-panel extension that scrapes an **Inspector ADE** inspection
(inspectorade.com) Approve/Reject form, sends the questions/answers + labeled
photos to a backend, gets AI-suggested answers, and highlights matches/mismatches
so you can click to apply.

It is a sibling of the **EZ Inspections SmartFill** extension: same architecture
and full feature set, only the scraped site differs. The UI uses the SmartFill
design system, rebranded to **Inspector ADE**.

## Project layout

```
extension/          # the Chrome MV3 extension (load this unpacked)
  manifest.json     # matches inspectorade.com/*, side panel
  background.js     # opens the side panel + on-demand content-script injection
  content.js        # scrapes the ADE modal + applies answers back
  imageModal.js     # on-page image viewer (zoom/pan/prev-next)
  sidepanel.html/.css/.js   # the UI
  icons/
backend/            # Express + Multer stub on PORT 3001
  server.js
  package.json
```

## How it works

1. **Scrape** (`content.js`): the inspection form is a **modal** on
   `inspectorade.com/orders` (the URL never changes), opened from an order's
   **Approve/Reject** tab.
   - **Questions** live in `#custom-form-body` (class `custom-form-body-<inspId>`).
     A `div.formHeading` starts a section; each control carries
     `data-custom-form-name` and a name like
     `GainAccess-form_id_95-custom-form-body-<inspId>`. The stable field key is
     the prefix `GainAccess-form_id_95`. Current radio/checkbox selection is read
     from the `.checked` property, falling back to the `customFormHighlightBlue`
     wrapper class (Green/DkGreen = previous/changed values, ignored). Hidden
     conditional questions (`display:none`) are skipped.
   - **Photos** come only from the **"Images from current inspection"** list
     (`<ul id="images">`): each `<div imageid="<id>">` gives an id, a thumbnail
     (`/image/thumb/<id>`), a category (`<select name="Image[<id>][LabelID]">`),
     and a full-res **download** URL
     (`inspectorade.com/inspections/downloadImage?ImageID=<id>`).
   - **Address** comes from the modal header `<tr><th>Address</th><td><a
     onclick="mapDialog(...)">…</a></td></tr>`.
   - The inspection id is read from the DOM (`custom-form-body-<id>` /
     `iid<id>`), since the URL never changes.

2. **Sync** (`sidepanel.js` + `content.js`): the **content script** fetches each
   image **in the page origin** (so the SameSite session cookie is sent
   first-party - the panel's own cross-site fetch would come back unauthorized)
   and returns each as a data URL. The panel builds a `FormData` with `images`
   files (named `<id>.jpg`) plus a `payload` JSON field and POSTs to the backend;
   the same data URLs render the reference thumbnails and the on-page viewer.

3. **Compare**: the backend returns `{ answers: [{ questionId, aiAnswer, … }] }`.
   The panel shows the page answer vs the AI answer, flags ✓ Match / ✗ Mismatch,
   and each option is a button - click to write it back into the page
   (`APPLY_ANSWER` clicks the real radio/checkbox/select so the site's own
   show/hide logic fires).

## Run the backend

```bash
cd backend
npm install
npm start        # http://localhost:3001
```

It runs on **3001** so it can sit alongside the EZ backend (3000). The stub saves
uploaded images to `backend/uploads/` and returns a **mock** AI response that
flips roughly half the answers so you can see matches and mismatches. Replace
`mockVerify()` with a real model call.

## Load the extension

1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Open `inspectorade.com/orders`, click an order, open its **Approve/Reject**
   tab. The side panel auto-detects it as **SUPPORTED** (no reload needed).
   Detection re-runs on tab switches and when a browser window regains focus, so
   opening a photo in a separate tab/window and closing it recovers on its own.
4. Click **Sync & Verify with AI** - one button runs scrape → fetch photos →
   verify. Review each suggestion with **Accept / Reject / Reconsider**, filter
   by **All / Different / Matched**, and click a card to scroll the page to that
   question and flash it.

## Request / response contract

**POST** `http://localhost:3001/api/ade/verify` - `multipart/form-data`

- `payload` (text): JSON
  ```json
  {
    "jobId": "111564554",
    "work_code": "PI",
    "sections": [
      { "header": "Gain Access",
        "questions": [
          { "id": "GainAccess-form_id_95",
            "text": "Are you able to complete an exterior inspection?",
            "type": "radio", "options": ["Yes","No"], "currentAnswer": "Yes" }
        ] }
    ],
    "photos": [ { "id": "1199538320", "category": "House#/Address Sign" } ]
  }
  ```
- `images` (files, repeated): each named `<id>.jpg` so the backend maps bytes
  back to `photos[].id`.

**Response** - JSON
```json
{
  "result_id": "2026-06-30T14-25-19Z__job-111564554__co0u",
  "answers": [
    { "questionId": "GainAccess-form_id_95", "aiAnswer": "No",
      "confidence": 0.78, "reasoning": "…",
      "referenceImages": [ { "id": "1199538320", "category": "House#/Address Sign" } ] }
  ]
}
```

- `aiAnswer` for radio/select must be one of that question's `options`
  (the human label text). For checkbox questions it's an array of labels.
- `referenceImages` cites evidence photos by **id + category only**; the
  extension rebuilds the image URL from the id.
- `confidence` and `reasoning` are optional.

**POST** `http://localhost:3001/api/ade/feedback` - `application/json`
```json
{ "result_id": "…", "jobId": "111564554",
  "feedback": [ { "questionId": "GainAccess-form_id_95", "decision": "accept", "finalAnswer": "No" } ] }
```
→ `{ "ok": true }`. Sent once per inspection with the operator's Accept/Reject
decisions (also auto-sent on ↻ / panel close).

## Wiring up real AI (later)

In `mockVerify()` you already receive `photoFiles` mapping each image `id` to its
saved path. For each question, select photos whose `category` is relevant, read
the bytes, send question text + images to your model, and constrain the answer to
`question.options`. Return the same answer shape.

## Things to verify on the live site

- That the live DOM sets `radio.checked` (the scraper prefers it; the
  `customFormHighlightBlue` class is the fallback for both live and saved HTML).
- That `<select>` current values read back from the live `.value` (the saved HTML
  capture loses them; the live property is authoritative).
- Images are fetched by the content script in the page origin (first-party, so
  the session cookie is sent). If a host serves photos from a *different* origin
  than the page (e.g. `archive.inspectorade.com`), confirm those still load.
