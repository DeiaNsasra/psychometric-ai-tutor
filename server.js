import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import { accountRoutes, isAdmin, loadUser, recordUsage, refundQuestion, requireUser, reserveQuestion, stripeWebhook } from "./accounts.js";

// Minimal .env loader (Node 20 has no --env-file-if-exists).
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// Tunable per deployment (and by the cost eval in tools/eval.js).
// Defaults chosen by the cost eval (eval/run.js, 2026-09-30): Opus picks the pages, Sonnet writes
// the answer, up to 12 pages — 18/18 correct at ~$0.07 per question vs ~$0.32 for all-Opus PDFs.
const MODEL = process.env.MODEL || "claude-sonnet-5";
const ROUTER_MODEL = process.env.ROUTER_MODEL || "claude-opus-5";
// "image": course pages go as pre-rendered 1100px JPEGs (rendered/, built by tools/render-pages.js).
// "pdf": pages cut from the PDFs. Images cost about half: the PDFs' garbled text layer is billed too.
const PAGE_FORMAT = process.env.PAGE_FORMAT || (fs.existsSync("rendered") ? "image" : "pdf");
const MATERIALS_DIR = "materials";
const MAX_PAGES_PER_TURN = Number(process.env.MAX_PAGES_PER_TURN) || 12; // pages the router may pick for one question
const MAX_PAGES_TOTAL = 80; // pages attached across the whole conversation
const SYSTEM_PROMPT = fs.readFileSync("system-prompt.md", "utf8");
const NO_ANSWER = "لا توجد إجابة في المواد المرفقة.";
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGES = 4;
const IMAGE_ONLY_TEXT = "هذه صورة سؤال. حلّه لي.";
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

const client = new Anthropic();

// ---------- Materials index ----------
// index.json is produced by `npm run index` (build-index.js): per file, runs of pages
// with a snippet of each run's first page.
const index = fs.existsSync("index.json") ? JSON.parse(fs.readFileSync("index.json", "utf8")) : [];
if (!index.length) console.warn("index.json is missing or empty. Run: npm run index");

// dictionary-index.json is produced by `npm run index:dictionary`: every numbered entry
// of القاموس المحيط ({num, root, file, page}), in the dictionary's own (alphabetical) order.
const DICT_DIR = "dictionary";
const dictionary = fs.existsSync("dictionary-index.json")
  ? JSON.parse(fs.readFileSync("dictionary-index.json", "utf8"))
  : [];
if (!dictionary.length) console.warn("dictionary-index.json is missing. Run: npm run index:dictionary");
const MAX_ROOTS = 6;

// Fold spelling variants so roots compare in the dictionary's order (hamza forms sort as alef).
function normRoot(s) {
  return String(s)
    .replace(/[\u064B-\u0652\u0640\s]/g, "")
    .replace(/[أإآٱءؤئ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}
// The indexer fixes each entry's first letter from the page's chapter header; later letters
// may still be misread, which the near-match window in lookupRoot absorbs.
const dictKeys = dictionary.map((e) => normRoot(e.root));
// Each first letter's chapter = its largest cluster of entries, ignoring strays that a
// misread letter put elsewhere. Values are [start, end) indexes into dictKeys.
const chapterRange = {};
{
  const byLetter = {};
  dictKeys.forEach((k, i) => (byLetter[k[0]] ||= []).push(i));
  for (const [letter, idx] of Object.entries(byLetter)) {
    let best = [idx[0], idx[0]], cur = [idx[0], idx[0]];
    for (const i of idx.slice(1)) {
      if (i - cur[1] > 20) cur = [i, i];
      else cur[1] = i;
      if (cur[1] - cur[0] > best[1] - best[0]) best = [...cur];
    }
    chapterRange[letter] = [best[0], best[1] + 1];
  }
}
const dictMaxPage = {};
for (const e of dictionary) dictMaxPage[e.file] = Math.max(dictMaxPage[e.file] || 0, e.page);

// Letters OCR confuses, for scoring near matches.
const SHAPES = ["ا", "بتثنيى", "جحخ", "دذ", "رز", "سش", "صض", "طظ", "عغ", "فق", "هة"];
const shape = (c) => SHAPES.find((g) => g.includes(c)) || c;

// Distance between a query root and an entry: 1 per letter differing only in dots,
// 2 per other differing letter. Different lengths are not comparable.
function mismatch(a, b) {
  if (a.length !== b.length) return Infinity;
  let cost = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) cost += shape(a[i]) === shape(b[i]) ? 1 : 2;
  }
  return cost;
}

// Find the page(s) holding a root's entry: locate its alphabetical position, then take the
// closest spelling within a few entries of that spot to absorb OCR misreads.
function lookupRoot(root) {
  const key = normRoot(root);
  if (key.length < 2 || !dictionary.length) return null;
  // Alphabetical position of the key within its first letter's chapter. A plain binary search
  // is thrown off by a single misread entry, so pick the split point with the fewest entries on
  // the wrong side of it (entries before it that sort after the key, and vice versa).
  const [first, last] = chapterRange[key[0]] || [0, dictKeys.length];
  let cost = 0;
  for (let i = first; i < last; i++) if (dictKeys[i] < key) cost++;
  let lo = first, bestSplit = cost;
  for (let p = first; p < last; p++) {
    if (dictKeys[p] < key) cost--;
    else if (dictKeys[p] > key) cost++;
    if (cost < bestSplit) { bestSplit = cost; lo = p + 1; }
  }
  let best = Math.max(lo - 1, 0), bestCost = 3; // accept at most one real misread letter
  for (let i = Math.max(0, lo - 6); i <= Math.min(dictKeys.length - 1, lo + 6); i++) {
    const cost = mismatch(key, dictKeys[i]);
    if (cost < bestCost || (cost === bestCost && cost < 3 && Math.abs(i - lo) < Math.abs(best - lo))) {
      best = i;
      bestCost = cost;
    }
  }
  const from = dictionary[best];
  const to = dictionary[Math.min(best + 1, dictionary.length - 1)];
  const file = `${DICT_DIR}/${from.file}`;
  let start = from.page;
  let end = to.file === from.file ? Math.min(Math.max(to.page, from.page), from.page + 2) : from.page;
  // Not an exact match: the entry may be misread, so also give the pages around it.
  if (bestCost > 0) {
    start = Math.max(1, start - 1);
    end = Math.min(end + 1, dictMaxPage[from.file]);
  }
  return { file, start, end, root };
}

const INDEX_TEXT = index
  .map((f, i) => {
    const lines = f.sections.map((s) => `  p${s.start}${s.end > s.start ? `-${s.end}` : ""}: ${s.snippet}`);
    return `[F${i}] ${f.file} (${f.pages} pages)\n${lines.join("\n")}`;
  })
  .join("\n\n");

const ROUTER_SYSTEM = `You pick which pages of a psychometric-exam course library a tutor needs to answer a student's latest message.

The library index lists each file as [F<n>] followed by page runs. Each run shows its PDF page numbers and the start of its first page's text (running header: book name, printed page number, topic). The text layer is imperfect Arabic: some letters are swapped or dropped (for example "تفكري كممي" means "تفكير كلامي", "جرب" means "جبر", "هندسة" may appear as "ﻫﻨﺪﺳﺔ"). Read through that.

The student may attach photos of a question (from a course book or an exam). Read the question in the photo to decide its topic and type.

Rules:
- Return up to ${MAX_PAGES_PER_TURN} pages in total. Prefer the explanation/method pages for the topic (مبادئ، كيف نحل، طرق الحل) plus the most relevant worked examples or solution pages.
- For a question the student wants solved, pick the chapter that teaches that question type and its method.
- For practice requests, pick question pages of that topic together with their solution pages (حلول / الإجابة صحيحة).
- For written expression (تعبير كتابي) essays or topics, include the recommended-structure file and the written-expression chapter.
- For geometry, the geometry shortcuts file is small and often useful.
- If the latest message is a follow-up that the already-attached pages cover, return an empty list.
- If nothing in the library relates to the message (a greeting, an unrelated topic), return an empty list.
- file is the number after F. start and end are PDF page numbers from the index, inclusive.
${dictionary.length ? `
The library also includes the dictionary القاموس المحيط, which is the reference for Arabic word meanings (معاني الكلمات، مقابلات، مرادفات، أضداد). It is not in the index above. To look words up, put their Arabic roots in "roots" (bare letters, no diacritics, for example "كمن" for "كامن", "ظهر" for "ظاهر"). Include roots whenever the answer depends on what an Arabic word means, up to ${MAX_ROOTS} roots. Otherwise leave "roots" empty.` : ""}`;

const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "integer" },
          start: { type: "integer" },
          end: { type: "integer" },
        },
        required: ["file", "start", "end"],
        additionalProperties: false,
      },
    },
    roots: { type: "array", items: { type: "string" } },
  },
  required: ["sections", "roots"],
  additionalProperties: false,
};

// Validate and clamp the router's picks to real pages, within the per-turn budget.
function cleanRefs(sections) {
  const refs = [];
  let budget = MAX_PAGES_PER_TURN;
  for (const s of sections) {
    const f = index[s.file];
    if (!f || budget <= 0) continue;
    const start = Math.max(1, Math.min(s.start, s.end));
    const end = Math.min(f.pages, Math.max(s.start, s.end), start + budget - 1);
    if (start > end) continue;
    refs.push({ file: f.file, start, end });
    budget -= end - start + 1;
  }
  return refs;
}

const fmtRef = (r) => `${r.root ? `القاموس المحيط (${r.root})` : r.file} p${r.start}-${r.end}`;

// The student's own photos, labelled so they aren't confused with the attached book pages
// (a book page and a photographed question both have a "question 3").
const imageBlocks = (images) =>
  (images || []).length
    ? [
        { type: "text", text: "صورة أرسلها الطالب (السؤال المطلوب موجود فيها، وليست من صفحات المواد المرفقة):" },
        ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })),
      ]
    : [];

async function routeQuestion(history, usageOut) {
  const recent = history.slice(-7);
  const attached = history.flatMap((m) => m.refs || []);
  const convo = recent
    .map((m) => `${m.role === "user" ? "Student" : "Tutor"}: ${String(m.text).slice(0, 2000)}`)
    .join("\n\n");
  const response = await client.beta.messages.create({
    model: ROUTER_MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: { type: "json_schema", schema: ROUTER_SCHEMA } },
    ...FALLBACK,
    system: [
      // The index is large and never changes while the server runs, so it goes first and is
      // cached on its own: the rules after it can change (page limit, dictionary) without
      // invalidating the cached index.
      { type: "text", text: `Library index:\n\n${INDEX_TEXT}`, cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: ROUTER_SYSTEM },
    ],
    messages: [
      {
        role: "user",
        content: [
          // Photos attached to the latest message, so the router can read the question itself.
          ...imageBlocks(history[history.length - 1].images),
          {
            type: "text",
            text:
              `Already attached earlier in this conversation: ${attached.length ? attached.map(fmtRef).join("; ") : "nothing"}\n\n` +
              `Conversation (latest message last):\n\n${convo}`,
          },
        ],
      },
    ],
  });
  usageOut?.push({ model: response.model, usage: response.usage });
  if (response.stop_reason !== "end_turn") return [];
  const text = response.content.find((b) => b.type === "text")?.text;
  try {
    const out = JSON.parse(text);
    const dictRefs = (out.roots || []).slice(0, MAX_ROOTS).map(lookupRoot).filter(Boolean);
    return [...cleanRefs(out.sections), ...dictRefs];
  } catch {
    return [];
  }
}

// ---------- Page extraction ----------
const pdfCache = new Map(); // file -> Promise<PDFDocument>
const pageCache = new Map(); // "file:start-end" -> base64 PDF

function loadPdf(file) {
  if (!pdfCache.has(file)) {
    pdfCache.set(file, PDFDocument.load(fs.readFileSync(path.join(MATERIALS_DIR, file)), { ignoreEncryption: true }));
  }
  return pdfCache.get(file);
}

async function extractPages({ file, start, end }) {
  const key = `${file}:${start}-${end}`;
  if (!pageCache.has(key)) {
    const src = await loadPdf(file);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i));
    pages.forEach((p) => out.addPage(p));
    // updateMetadata: false keeps the bytes identical across requests, so prompt caching hits.
    const bytes = await out.save({ updateMetadata: false });
    pageCache.set(key, Buffer.from(bytes).toString("base64"));
  }
  return pageCache.get(key);
}

async function documentBlock(ref) {
  // Dictionary scans have no text layer, so as PDFs they already bill as images only.
  if (PAGE_FORMAT === "image" && !ref.root) {
    const dir = path.join("rendered", ref.file.replace(/\.pdf$/i, ""));
    const content = [];
    for (let p = ref.start; p <= ref.end; p++) {
      content.push({ type: "text", text: `${ref.file} — صفحة ${p} من الملف:` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(path.join(dir, `${p}.jpg`)).toString("base64") },
      });
    }
    return content;
  }
  return {
    type: "document",
    title: ref.root
      ? `القاموس المحيط — صفحات الجذر «${ref.root}»`
      : `${ref.file} — صفحات ${ref.start} إلى ${ref.end} من الملف`,
    source: { type: "base64", media_type: "application/pdf", data: await extractPages(ref) },
  };
}

// Keep the most recent turns' pages; drop older ones past the conversation budget.
function trimRefs(history) {
  let total = 0;
  const keep = new Array(history.length).fill(null).map(() => []);
  for (let i = history.length - 1; i >= 0; i--) {
    for (const r of history[i].refs || []) {
      const n = r.end - r.start + 1;
      if (total + n > MAX_PAGES_TOTAL) continue;
      total += n;
      keep[i].push(r);
    }
  }
  return keep;
}

// ---------- Cost ----------
// USD per million tokens (Claude pricing as of 2026-09). Cache writes bill 1.25x input for the
// 5-minute TTL and 2x for 1 hour; cache reads bill 0.1x.
const PRICES = {
  "claude-opus-5": [5, 25],
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};
function costUSD(model, u) {
  const [inp, out] = PRICES[Object.keys(PRICES).find((k) => model?.startsWith(k))] || PRICES["claude-opus-5"];
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return (
    (u.input_tokens * inp + w5 * inp * 1.25 + w1h * inp * 2 + (u.cache_read_input_tokens || 0) * inp * 0.1 + u.output_tokens * out) / 1e6
  );
}

// ---------- HTTP ----------
const app = express();
app.set("trust proxy", 1); // behind fly.io's proxy: req.ip is the visitor, cookies can be Secure

// Optional site-wide password gate, for a private test deployment before public launch. Uses the
// browser's own login prompt; any username works. Stripe's webhook is exempt.
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const sha = (s) => crypto.createHash("sha256").update(s).digest();
if (SITE_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === "/api/stripe/webhook") return next();
    const [scheme, encoded] = (req.headers.authorization || "").split(" ");
    const given = scheme === "Basic" ? Buffer.from(encoded || "", "base64").toString().split(":").slice(1).join(":") : "";
    if (crypto.timingSafeEqual(sha(given), sha(SITE_PASSWORD))) return next();
    res.set("WWW-Authenticate", 'Basic realm="psychometric", charset="UTF-8"').status(401).send("كلمة المرور مطلوبة");
  });
}

// Stripe signs the raw body, so the webhook must be mounted before express.json.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);
app.use(express.json({ limit: "25mb" })); // question photos ride along with the history
app.use(express.static("public"));
app.use(loadUser);
app.use(accountRoutes);

app.get("/api/materials", (_req, res) => {
  res.json({ files: index.map((f) => f.file) });
});

// Body: { messages: [{ role: "user" | "assistant", text: string, refs?: [{file,start,end}] }, ...] }
// refs on earlier user turns are the pages picked for them; the server picks refs for the
// latest turn. Responds with SSE events: {refs}, {text} deltas, then {done} or {error}.
app.post("/api/chat", requireUser, async (req, res) => {
  const history = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!history.length || history[history.length - 1].role !== "user") {
    return res.status(400).json({ error: "bad request" });
  }
  const known = new Map(index.map((f) => [f.file, f.pages]));
  for (const e of dictionary) {
    const file = `${DICT_DIR}/${e.file}`;
    known.set(file, Math.max(known.get(file) || 0, e.page + 2));
  }
  for (const m of history) {
    m.text = String(m.text || "");
    m.images = (Array.isArray(m.images) ? m.images : [])
      .filter((im) => m.role === "user" && IMAGE_TYPES.has(im?.media_type) && typeof im.data === "string")
      .slice(0, MAX_IMAGES);
    if (m.role === "user" && !m.text.trim() && m.images.length) m.text = IMAGE_ONLY_TEXT;
    m.refs = (Array.isArray(m.refs) ? m.refs : []).filter(
      (r) => known.has(r.file) && r.start >= 1 && r.end >= r.start && r.end <= known.get(r.file),
    );
  }

  // Each message spends one question; it's given back if no answer is delivered.
  // The site owner (ADMIN_EMAILS) asks without a limit; usage is still recorded.
  const metered = !isAdmin(req.user);
  if (metered && !reserveQuestion(req.user.id)) {
    return res.status(402).json({ error: "انتهت أسئلتك. اشترِ الباقة لتكمل.", code: "no_questions" });
  }
  let answered = false;
  res.on("close", () => { if (metered && !answered) refundQuestion(req.user.id); });

  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  if (!index.length) {
    send({ text: NO_ANSWER });
    send({ done: true });
    return res.end();
  }

  // res "close" (not req's, which fires once the body is read) means the browser went away.
  let aborted = false;
  res.on("close", () => (aborted = !res.writableEnded));

  try {
    send({ status: "searching" });
    const latest = history[history.length - 1];
    const calls = []; // {model, usage} per API call, for cost reporting
    latest.refs = await routeQuestion(history, calls);
    send({ refs: latest.refs });
    console.log("Pages:", latest.refs.map(fmtRef).join("; ") || "(none)");
    if (aborted) return res.end();

    const kept = trimRefs(history);
    const messages = await Promise.all(
      history.map(async (m, i) => {
        const pages = (await Promise.all(kept[i].map(documentBlock))).flat();
        // Cache breakpoint right after the first turn's pages: another student asking about the
        // same topic gets the same pages, so their request reuses this cached prefix.
        if (i === 0 && pages.length) pages[pages.length - 1] = { ...pages[pages.length - 1], cache_control: { type: "ephemeral" } };
        return { role: m.role, content: [...pages, ...imageBlocks(m.images), { type: "text", text: m.text }] };
      }),
    );

    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      cache_control: { type: "ephemeral" },
      ...FALLBACK,
      system: SYSTEM_PROMPT,
      messages,
    });
    res.on("close", () => aborted && stream.abort());

    stream.on("text", (text) => send({ text }));
    const final = await stream.finalMessage();
    const u = final.usage;
    calls.push({ model: final.model, usage: u });
    const cost = calls.reduce((sum, c) => sum + costUSD(c.model, c.usage), 0);
    send({ usage: { cost, calls } });
    recordUsage(req.user.id, cost);
    console.log(`Tokens: in ${u.input_tokens}, cache read ${u.cache_read_input_tokens}, cache write ${u.cache_creation_input_tokens}, out ${u.output_tokens}; cost $${cost.toFixed(4)}`);
    if (final.stop_reason === "refusal") {
      send({ error: "تعذّر الرد على هذا السؤال. جرّب صياغته بطريقة أخرى." });
    } else {
      answered = true;
      send({ done: true });
    }
  } catch (err) {
    if (aborted) return res.end();
    console.error(err);
    let msg = "حدث خطأ غير متوقع. حاول مرة أخرى.";
    if (err instanceof Anthropic.AuthenticationError || !process.env.ANTHROPIC_API_KEY) msg = "مفتاح الخدمة غير صحيح أو غير موجود. راجع ملف الإعدادات.";
    else if (err instanceof Anthropic.RateLimitError) msg = "الخدمة مشغولة حاليًا. انتظر قليلًا ثم حاول مرة أخرى.";
    else if (err instanceof Anthropic.BadRequestError) msg = "تعذّر إرسال الطلب. ابدأ محادثة جديدة وحاول مرة أخرى.";
    send({ error: msg });
  }
  res.end();
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1"; // the hosting service sets 0.0.0.0
if (HOST !== "127.0.0.1" && !process.env.PUBLIC_URL) {
  console.error("Set PUBLIC_URL (e.g. https://example.fly.dev) when running on a public address.");
  process.exit(1);
}
app.listen(PORT, HOST, () => console.log(`http://localhost:${PORT}`));
