// content.js - runs on inspectorade.com/orders.
//
// The inspection form is a MODAL loaded dynamically on top of the orders list
// (the URL never changes). Q&A + photos live in the modal's "Approve/Reject"
// tab. Responsibilities:
//   1. Scrape the custom form (#custom-form-body) -> sections -> questions ->
//      current answers.
//   2. Scrape the "Images from current inspection" photos (#images) -> imageid,
//      category, thumbnail + full-res (downloadImage) URL.
//   3. Apply an answer back into the modal (radio / checkbox / select / text) on
//      request, firing the site's own change handlers so its show/hide logic runs.
//   4. Lightweight DETECT + FOCUS_QUESTION (scroll a question into view + flash).
//
// Communicates with the side panel via chrome.runtime messages. Because the form
// is a modal that can be opened/closed/swapped without a page load, a
// MutationObserver announces ADE_PAGE_READY whenever a new inspection modal
// appears so the panel re-detects automatically.

(() => {
  // Guard against double-injection (manifest match + on-demand executeScript).
  if (window.__adeVerifierContentLoaded) return;
  window.__adeVerifierContentLoaded = true;

  // The element currently marked as "the question being answered".
  let highlightedGroup = null;

  function ensureHighlightStyle() {
    if (document.getElementById("ade-verifier-style")) return;
    const style = document.createElement("style");
    style.id = "ade-verifier-style";
    style.textContent = `
      .ade-verifier-active-question {
        outline: 3px solid #7c3aed !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.25) !important;
      }`;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------- helpers ----------

  function isVisible(el) {
    if (!el) return false;
    let node = el;
    while (node && node !== document.body) {
      const cs = window.getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      node = node.parentElement;
    }
    return true;
  }

  function text(el) {
    return (el ? el.textContent : "").replace(/\s+/g, " ").trim();
  }

  function norm(v) {
    return (v == null ? "" : String(v)).replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Absolutise a possibly-relative URL (e.g. "/image/thumb/123") against the page.
  function abs(url) {
    if (!url) return url;
    try {
      return new URL(url, location.origin).href;
    } catch (e) {
      return url;
    }
  }

  // The modal's form body is <div id="custom-form-body" class="custom-form-body-<id>">.
  function formRoot() {
    return document.getElementById("custom-form-body");
  }

  // The inspection id is embedded in the form-body class (and the image iid<id>
  // classes / "Order ID" in the modal header).
  function inspectionId() {
    const root = formRoot();
    if (root) {
      const m = (root.className || "").match(/custom-form-body-(\d+)/);
      if (m) return m[1];
    }
    const el = document.querySelector('[class*="iid"]');
    if (el) {
      const m = (el.className || "").match(/iid(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  // The label text shown next to a radio/checkbox input (the <label> wrapping it).
  function optionLabel(input) {
    const lbl = input.closest("label");
    const t = lbl ? text(lbl) : "";
    return t || input.value || "";
  }

  // The form encodes the current selection two ways: the `.checked` property (set
  // by the site's JS on the live page - it does NOT serialize to a `checked`
  // attribute, so saved HTML loses it) AND a `customFormHighlightBlue` class on
  // the option's wrapper div (the page's own "selected" tint; Green/DkGreen mark
  // previous/changed values, which we deliberately ignore).
  function hasBlue(input) {
    return !!input.closest(".customFormHighlightBlue");
  }

  // Pick the selected inputs from a radio/checkbox group. `.checked` wins at the
  // GROUP level: if any input is checked we trust the property and ignore the
  // highlight class entirely (so a stale Blue tint left over after an apply can
  // never override a real selection). Only when nothing is checked do we fall
  // back to the highlight class (e.g. the static HTML capture, which has no
  // `checked`). Returns the array of selected inputs.
  function selectedInputs(inputs) {
    const checked = inputs.filter((i) => i.checked);
    if (checked.length) return checked;
    return inputs.filter(hasBlue);
  }

  // The visible prompt of a question container (the form_id_* div/span/label,
  // NOT the option labels which wrap inputs and carry no id).
  function questionPrompt(container) {
    const cands = container.querySelectorAll(
      'div[id^="form_id_"], span[id^="form_id_"], label[id^="form_id_"]'
    );
    for (const c of cands) {
      if (c.querySelector("input, select, textarea")) continue; // skip wrappers
      const t = text(c);
      if (t) return t;
    }
    // Fallback: first non-empty leading text node of the container.
    const span = container.querySelector("span, label, div");
    return span ? text(span) : "";
  }

  // ---------- field key ----------
  // A stable key per question: "<DataName>-form_id_<n>" (the prefix of the
  // control's name attribute, minus the "-custom-form-body-<inspId>" suffix that
  // varies between inspections). Locating a control needs no inspection id - we
  // match by this name prefix.
  function fieldKeyFor(ctrl) {
    if (!ctrl || !ctrl.name) return null;
    const data = ctrl.getAttribute("data-custom-form-name");
    const m = ctrl.name.match(/-(form_id_\d+)-/);
    if (!data || !m) return null;
    return data + "-" + m[1];
  }

  // Every input/select/textarea belonging to a question key (radio group = many),
  // excluding the read-only "Previous Value" inputs (they lack data-custom-form-name).
  function controlsFor(fieldKey) {
    const root = formRoot();
    if (!root || !fieldKey) return [];
    return Array.from(root.querySelectorAll("[name][data-custom-form-name]")).filter(
      (el) => el.name && el.name.startsWith(fieldKey + "-")
    );
  }

  // ---------- scraping questions ----------

  function parseControl(container) {
    const ctrl = container.querySelector("[data-custom-form-name]");
    if (!ctrl) return null;
    const fieldKey = fieldKeyFor(ctrl);
    if (!fieldKey) return null;

    const tag = ctrl.tagName;
    const type = (ctrl.type || "").toLowerCase();

    // Radio group
    if (type === "radio") {
      const radios = Array.from(
        container.querySelectorAll('input[type="radio"][data-custom-form-name]')
      );
      const options = radios.map(optionLabel);
      const sel = selectedInputs(radios)[0];
      const currentAnswer = sel ? optionLabel(sel) : null;
      return { fieldKey, type: "radio", options, currentAnswer };
    }

    // Checkbox list (multi-select) - answer is the SET of checked labels.
    if (type === "checkbox") {
      const boxes = Array.from(
        container.querySelectorAll('input[type="checkbox"][data-custom-form-name]')
      );
      const labeled = boxes.filter((cb) => optionLabel(cb));
      const options = labeled.map(optionLabel);
      const selected = selectedInputs(labeled).map(optionLabel);
      return { fieldKey, type: "checkbox", options, currentAnswer: selected };
    }

    // Select dropdown
    if (tag === "SELECT") {
      const options = Array.from(ctrl.options).map((o) => o.text.trim());
      const currentAnswer =
        ctrl.selectedIndex >= 0 && ctrl.value ? ctrl.options[ctrl.selectedIndex].text.trim() : null;
      return { fieldKey, type: "select", options, currentAnswer };
    }

    // Textarea / text / number / date input
    if (tag === "TEXTAREA" || tag === "INPUT") {
      return { fieldKey, type: "text", options: [], currentAnswer: (ctrl.value || "").trim() };
    }

    return null;
  }

  function scrapeQuestions() {
    const root = formRoot();
    if (!root) return { sections: [] };

    const sections = [];
    let current = null;
    const seen = new Set();

    // Section headings (.formHeading) and question controls ([data-custom-form-name])
    // in document order. A heading starts a new section; each new control's leaf
    // container becomes a question under the most recent heading.
    const nodes = root.querySelectorAll(".formHeading, [data-custom-form-name]");
    for (const el of nodes) {
      if (el.classList && el.classList.contains("formHeading")) {
        current = { header: text(el) || "(Section)", questions: [] };
        sections.push(current);
        continue;
      }

      const container = el.closest(".customFormElement");
      if (!container || seen.has(container)) continue;
      seen.add(container);

      // Skip hidden conditional questions.
      if (!isVisible(container)) continue;

      if (!current) {
        current = { header: "(Ungrouped)", questions: [] };
        sections.push(current);
      }

      const parsed = parseControl(container);
      if (!parsed) continue;

      const label = questionPrompt(container);
      if (!label) continue; // unlabeled control - skip

      current.questions.push({
        id: parsed.fieldKey,
        text: label,
        type: parsed.type,
        options: parsed.options,
        currentAnswer: parsed.currentAnswer,
      });
    }

    return { sections: sections.filter((s) => s.questions.length > 0) };
  }

  // ---------- scraping photos ----------
  // Only the "Images from current inspection" list (<ul id="images">). Each
  // <li> holds a <div imageid="<id>"> with a thumbnail, a category <select>, and
  // a download link (full-res).

  function scrapePhotos() {
    const photos = [];
    const ul = document.getElementById("images");
    if (!ul) return photos;

    const containers = Array.from(ul.querySelectorAll("div[imageid]"));
    for (const div of containers) {
      const id = div.getAttribute("imageid");
      if (!id) continue;

      const img = div.querySelector("img[imgid], img");
      const thumbUrl = img ? abs(img.getAttribute("src")) : null;

      const dl = div.querySelector("a.image-download-link[href]");
      const fullResUrl = dl
        ? abs(dl.getAttribute("href"))
        : abs("/inspections/downloadImage?ImageID=" + id);

      const sel = div.querySelector('select.imageLabel, select[name^="Image["]');
      let category = null;
      if (sel && sel.selectedIndex >= 0) category = sel.options[sel.selectedIndex].text.trim();

      photos.push({
        ref: "img_" + id,
        attid: id, // the side panel keys photos by `attid`
        imageGlobalId: div.getAttribute("imageglobalid") || null,
        label: category || "Image " + id,
        category,
        thumbnailUrl: thumbUrl,
        fullResUrl,
        filename: id + ".jpg",
      });
    }
    return photos;
  }

  // ---------- fetching images in the PAGE origin ----------
  // The side panel runs at chrome-extension://… so its fetches to inspectorade.com
  // are cross-site - the SameSite session cookie isn't sent and the images come
  // back unauthorized. The content script runs in the page's own origin, so a
  // fetch here is first-party and carries the session cookie. We return each
  // image as a data URL the panel can drop straight into <img> / FormData.

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error("read failed"));
      r.readAsDataURL(blob);
    });
  }

  async function fetchOneImage(item, preferFullRes) {
    const order = preferFullRes
      ? [item.fullResUrl, item.thumbnailUrl]
      : [item.thumbnailUrl, item.fullResUrl];
    for (const url of order.filter(Boolean)) {
      try {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) continue;
        const blob = await resp.blob();
        if (blob.size > 0) {
          return { id: item.id, dataUrl: await blobToDataUrl(blob), url };
        }
      } catch (e) {
        // try the next candidate URL
      }
    }
    return { id: item.id, dataUrl: null, url: null };
  }

  async function fetchImagesInPage(items, preferFullRes) {
    const CONCURRENCY = 5;
    const out = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fetchOneImage(items[i], preferFullRes);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker)
    );
    return out;
  }

  // ---------- applying an answer back to the page ----------

  function fireChange(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function applyAnswer(fieldKey, value) {
    const ctrls = controlsFor(fieldKey);
    if (!ctrls.length) return { ok: false, error: "field not found: " + fieldKey };

    const first = ctrls[0];
    const tag = first.tagName;
    const type = (first.type || "").toLowerCase();

    // Radio - click the matching option so the site's show/hide handlers fire.
    if (type === "radio") {
      for (const r of ctrls) {
        if (norm(optionLabel(r)) === norm(value) || r.value === value) {
          if (!r.checked) r.click();
          return { ok: true, applied: value };
        }
      }
      return { ok: false, error: "option not found in radio group" };
    }

    // Checkbox list - check/uncheck so the checked set matches the desired labels.
    if (type === "checkbox") {
      const wanted = Array.isArray(value) ? value : String(value).split(/\s*[|,]\s*/);
      const want = new Set(wanted.map((s) => norm(s)));
      for (const cb of ctrls) {
        const should = want.has(norm(optionLabel(cb)));
        if (cb.checked !== should) cb.click();
      }
      return { ok: true, applied: value };
    }

    // Select
    if (tag === "SELECT") {
      for (const o of first.options) {
        if (norm(o.text) === norm(value) || o.value === value) {
          first.value = o.value;
          fireChange(first);
          return { ok: true, applied: value };
        }
      }
      return { ok: false, error: "option not found in select" };
    }

    // Textarea / text / date input
    if (tag === "TEXTAREA" || tag === "INPUT") {
      first.value = value;
      fireChange(first);
      return { ok: true, applied: value };
    }

    return { ok: false, error: "unhandled control for " + fieldKey };
  }

  // ---------- focus + highlight a question ----------

  function clearHighlight() {
    if (highlightedGroup) {
      highlightedGroup.classList.remove("ade-verifier-active-question");
      highlightedGroup = null;
    }
  }

  function focusQuestion(fieldKey) {
    const el = controlsFor(fieldKey)[0];
    if (!el) return { ok: false, error: "field not found: " + fieldKey };

    const target = el.closest(".customFormElement") || el.closest("div") || el;

    ensureHighlightStyle();
    clearHighlight();
    target.classList.add("ade-verifier-active-question");
    highlightedGroup = target;
    target.scrollIntoView({ behavior: "smooth", block: "center" });

    return { ok: true };
  }

  // ---------- property address ----------
  // The modal header summary has <tr><th>Address</th><td><a onclick="mapDialog(...)">
  // 1706 BANNING RD<br>Norfolk, VA 23518</a></td></tr>.
  function scrapeAddress() {
    const ths = Array.from(document.querySelectorAll("th"));
    for (const th of ths) {
      if (text(th).toLowerCase() === "address") {
        const td = th.parentElement ? th.parentElement.querySelector("td") : null;
        if (td) {
          const a = td.querySelector("a") || td;
          // The address is two lines split by <br> ("1706 BANNING RD" / "Norfolk,
          // VA 23518"); turn the break into ", " so they don't run together.
          const clone = a.cloneNode(true);
          clone.querySelectorAll("br").forEach((br) => br.replaceWith(", "));
          const t = text(clone).replace(/\s*,\s*,/g, ",");
          if (t) return t;
        }
      }
    }
    return null;
  }

  // ---------- detection ----------

  function detect() {
    const root = formRoot();
    const supported = !!root;
    const { sections } = scrapeQuestions();
    const questionCount = sections.reduce((n, s) => n + s.questions.length, 0);
    const photoCount = scrapePhotos().length;
    return {
      ok: true,
      supported,
      jobId: inspectionId(), // reused as the inspection id throughout the panel
      url: location.href,
      address: scrapeAddress(),
      questionCount,
      photoCount,
    };
  }

  // ---------- message handling ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "DETECT") {
      sendResponse(detect());
      return true;
    }

    if (msg.type === "SCRAPE") {
      const data = {
        jobId: inspectionId(),
        url: location.href,
        address: scrapeAddress(),
        ...scrapeQuestions(),
        photos: scrapePhotos(),
      };
      sendResponse({ ok: true, data });
      return true;
    }

    if (msg.type === "FETCH_IMAGES") {
      fetchImagesInPage(msg.items || [], !!msg.preferFullRes)
        .then((images) => sendResponse({ ok: true, images }))
        .catch((e) => sendResponse({ ok: false, error: e.message, images: [] }));
      return true; // async response
    }

    if (msg.type === "APPLY_ANSWER") {
      sendResponse(applyAnswer(msg.fieldKey, msg.value));
      return true;
    }

    if (msg.type === "FOCUS_QUESTION") {
      sendResponse(focusQuestion(msg.fieldKey));
      return true;
    }

    if (msg.type === "CLEAR_HIGHLIGHT") {
      clearHighlight();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === "SHOW_IMAGE_MODAL") {
      try {
        if (window.EZ_IMAGE_MODAL && typeof window.EZ_IMAGE_MODAL.show === "function") {
          window.EZ_IMAGE_MODAL.show(msg.images || [], msg.index || 0);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "image viewer not loaded" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return true;
    }

    if (msg.type === "PING") {
      sendResponse({ ok: true, pong: true });
      return true;
    }
  });

  // ---------- announce readiness (auto-detect) ----------
  // The inspection form is a modal opened without a page load, so the panel's
  // tab-based detection won't fire. Watch the DOM and announce ADE_PAGE_READY
  // whenever a NEW inspection modal appears (a different inspection id), so the
  // panel re-detects automatically.

  let lastAnnounced = null;
  function maybeAnnounce() {
    if (!formRoot()) {
      lastAnnounced = null; // modal closed - allow re-announce when it reopens
      return;
    }
    const id = inspectionId();
    if (!id || id === lastAnnounced) return;
    lastAnnounced = id;
    try {
      chrome.runtime.sendMessage({ type: "ADE_PAGE_READY", jobId: id, url: location.href });
    } catch (e) {
      // No receiver (panel closed) - harmless.
    }
  }

  const obs = new MutationObserver(() => maybeAnnounce());
  obs.observe(document.documentElement, { childList: true, subtree: true });
  maybeAnnounce();
})();
