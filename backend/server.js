// server.js - stub backend for the Inspector ADE AI Verifier extension.
// Runs on port 3001 so it can sit alongside the EZ backend (3000) at the same time.
//
// Accepts multipart/form-data:
//   - field "payload": JSON string { jobId, work_code, url, sections:[...], photos:[{id,category}] }
//   - field "images" (repeated): the binary image files. Each file is named
//     "<id>.<ext>" (id = the photo's image id), so the bytes map back to the
//     matching photos[].id. (Multer captures every file regardless of field.)
//
// Returns JSON:
//   { result_id, answers: [ { questionId, aiAnswer,
//                             referenceImages: [ { id, category } ] } ] }
//   - result_id ties a later POST /api/ade/feedback back to this run.
//   - referenceImages cites the photos used as evidence (image id + category);
//     the extension rebuilds the image URL from the id, so no url is sent.
//   - confidence / reasoning are optional; this mock includes sample values.
//
// Feedback: POST /api/ade/feedback
//   { result_id, jobId, feedback: [ { questionId, decision, finalAnswer, ... } ] }
//   -> { ok: true }
//
// Every request is logged for debugging: INPUT json -> ./logs/input/, OUTPUT
// json -> ./logs/output/, feedback -> ./logs/feedback/, under a matching
// timestamped filename.
//
// Right now the "AI" is a mock: it alternates, so roughly HALF the answers differ
// from the page (a different option is chosen) and half match - handy for testing
// the review queue, the end-of-sync summary, and the keyboard flow. Replace
// mockVerify() with a real model call later (see the comment block).

import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "uploads");
const INPUT_DIR = path.join(__dirname, "logs", "input");
const OUTPUT_DIR = path.join(__dirname, "logs", "output");
const FEEDBACK_DIR = path.join(__dirname, "logs", "feedback");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(INPUT_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(FEEDBACK_DIR, { recursive: true });

// Build a filesystem-safe, timestamped base name shared by a request's input
// and output logs, e.g. "2026-06-29T14-30-05-123Z__job-330882809__a1b2".
function logBaseName(jobId) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const job = String(jobId || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  const rand = Math.random().toString(36).slice(2, 6); // avoid same-ms collisions
  return `${ts}__job-${job}__${rand}`;
}

function writeLog(dir, base, data) {
  try {
    fs.writeFileSync(path.join(dir, base + ".json"), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Failed to write log to", dir, "-", e.message);
  }
}

// Multer: store files on disk so you can inspect what the extension sent.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "__" + file.fieldname + "__" + safe);
  },
});
// upload.any() accepts every file field (photo_0, photo_1, ...) regardless of name.
const upload = multer({ storage });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" })); // for the JSON /feedback body

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/ade/verify", upload.any(), async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch (e) {
    return res.status(400).json({ error: "Invalid or missing 'payload' JSON field." });
  }

  const files = req.files || [];
  console.log("\n=== /verify ===");
  console.log("Job:", payload.jobId);
  console.log("Sections:", payload.sections.length);
  console.log("Photos in payload:", payload.photos.length, "| Files received:", files.length);
  for (const f of files) {
    console.log(`  file ${f.fieldname} -> ${f.filename} (${f.size} bytes)`);
  }

  // Question breakdown by type - so you can confirm dropdowns (selects) now
  // arrive, and that each one carries its extracted current answer.
  const allQuestions = (payload.sections || []).flatMap((s) => s.questions || []);
  const typeCounts = allQuestions.reduce((m, q) => {
    m[q.type] = (m[q.type] || 0) + 1;
    return m;
  }, {});
  console.log("Questions:", allQuestions.length, "|", JSON.stringify(typeCounts));
  for (const q of allQuestions.filter((q) => q.type === "select")) {
    console.log(`  select "${q.text}" -> current: ${JSON.stringify(q.currentAnswer)} (${(q.options || []).length} options)`);
  }

  // ── Log the INPUT json (payload + file metadata) ──────────────────────────
  const base = logBaseName(payload.jobId);
  writeLog(INPUT_DIR, base, {
    receivedAt: new Date().toISOString(),
    jobId: payload.jobId,
    files: files.map((f) => ({ field: f.fieldname, filename: f.filename, size: f.size })),
    payload,
  });

  // Map each uploaded file to its image id. The upload filename is "<id>.<ext>",
  // so the id is the filename without its extension. This is how a photo's bytes
  // are matched back to its { id, category } entry in payload.photos.
  const photoFiles = {};
  for (const f of files) {
    const id = String(f.originalname).replace(/\.[^.]*$/, "");
    photoFiles[id] = path.join(UPLOAD_DIR, f.filename);
  }

  const responseBody = {
    result_id: base, // ties a later /feedback POST back to this run + its logs
    answers: await mockVerify(payload, photoFiles),
  };

  // ── Log the OUTPUT json (the exact response we send back) ─────────────────
  writeLog(OUTPUT_DIR, base, {
    sentAt: new Date().toISOString(),
    jobId: payload.jobId,
    response: responseBody,
  });
  console.log(`  logged: logs/input/${base}.json + logs/output/${base}.json`);

  res.json(responseBody);
});

// ── Feedback ────────────────────────────────────────────────────────────────
// The operator's Accept / Reject decisions, tied back to a verify run via
// result_id. One-shot save; logged to logs/feedback/. A real backend would
// persist these as a training / QA signal.
app.post("/api/ade/feedback", (req, res) => {
  const body = req.body || {};
  const base = logBaseName(body.jobId || body.result_id || "feedback");
  writeLog(FEEDBACK_DIR, base, { receivedAt: new Date().toISOString(), ...body });
  console.log(
    `\n=== /feedback === result_id=${body.result_id || "-"} ` +
    `items=${Array.isArray(body.feedback) ? body.feedback.length : 0}`
  );
  console.log(`  logged: logs/feedback/${base}.json`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// MOCK "AI". Replace with a real call.
//
// To use a real model (e.g. Anthropic), for each question:
//   1. Find relevant photos (match payload.photos[].category to the question).
//   2. Read the image bytes from photoFiles[photo.id] (keyed by image id - the
//      uploaded file is named "<id>.<ext>", so it maps back to payload.photos[].id).
//   3. Send the question text + images to the model, ask for the best answer
//      constrained to question.options.
//   4. Return { questionId, aiAnswer, confidence, reasoning, referenceImages }
//      where referenceImages lists the photos that informed the answer.
// ---------------------------------------------------------------------------
const norm = (v) => (v == null ? "" : String(v)).trim().toLowerCase();

// Guard so the mock never "suggests" a non-answer placeholder that a select's
// options might still carry (e.g. "- Select One -", "- choose label -").
const isPlaceholderOption = (label) => /^[-\s]*(select|choose|pick|please|--)\b|^-+\s*$/i.test(label || "");

async function mockVerify(payload, photoFiles) {
  const answers = [];

  // Photos sent in the payload, each { id, category }. A real model would pick
  // the ones relevant to each question; the mock rotates through them so every
  // card's "Reference photos" row has something. Only id + category go back -
  // the extension rebuilds the image URL from the id.
  const photos = payload.photos || [];
  const refImagesFor = (i) => {
    if (!photos.length) return [];
    const a = photos[i % photos.length];
    const b = photos[(i + 1) % photos.length];
    const picked = b && b !== a ? [a, b] : [a];
    return picked.map((p) => ({ id: p.id, category: p.category }));
  };

  // Demo: make roughly HALF the answers differ from the page so the review queue,
  // the end-of-sync summary (N to review / M matched) and the keyboard flow are
  // easy to test. We alternate: on every other question that has options to pick
  // from, choose a DIFFERENT option; the rest echo the current answer (a match).
  let qi = 0;
  for (const section of payload.sections) {
    for (const q of section.questions) {
      // Ignore any placeholder that slipped through so the mock only ever
      // proposes a real, selectable option (matters for dropdowns).
      const opts = (q.options || []).filter((o) => !isPlaceholderOption(o));
      let aiAnswer = q.currentAnswer; // default: agree with the page (a match)
      let reasoning = "Matches the answer already on the page.";

      // Checkbox lists hold a SET of answers; a single-option swap would be
      // nonsensical, so always echo them (they show as matched).
      const makeDifferent = qi % 2 === 0 && opts.length >= 2 && q.type !== "checkbox";
      if (makeDifferent) {
        // Pick the first option that isn't the current answer.
        const other = opts.find((o) => norm(o) !== norm(q.currentAnswer));
        if (other != null) {
          aiAnswer = other;
          reasoning = "The photos suggest a different answer than the page.";
        }
      }

      answers.push({
        questionId: q.id,
        aiAnswer,
        // Confidence varies a little so the helper line is visible while testing.
        confidence: makeDifferent ? 0.78 : 0.95,
        reasoning,
        referenceImages: refImagesFor(qi),
      });
      qi++;
    }
  }
  return answers;
}

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
  console.log(`Inspector ADE AI Verifier backend listening on http://localhost:${PORT}`);
  console.log(`Endpoint: POST http://localhost:${PORT}/api/ade/verify`);
});
