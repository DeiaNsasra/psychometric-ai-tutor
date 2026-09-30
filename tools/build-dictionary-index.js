// Builds dictionary-index.json from the scanned القاموس المحيط PDFs in materials/dictionary.
// The scans have no text layer, so this OCRs every page with macOS Vision (tools/ocr.swift)
// and records each numbered entry header ("٢٦١٩ - خنبث") with the page it appears on.
// Entries are numbered in the dictionary's alphabetical order, which the server's lookup relies on.
import fs from "fs";
import path from "path";
import { execFileSync, spawn } from "child_process";

const DIR = "materials/dictionary";
const OCR = "tools/ocr";
if (!fs.existsSync(OCR)) execFileSync("swiftc", ["-O", "tools/ocr.swift", "-o", OCR], { stdio: "inherit" });

const toWestern = (s) => s.replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
const HEAD = /^\s*([٠-٩0-9]{1,5})\s*[-–ـ]\s*([ء-يً-ْ\s]{2,12})$/;

function pageCount(file) {
  const out = execFileSync("mdls", ["-raw", "-name", "kMDItemNumberOfPages", file], { encoding: "utf8" });
  return Number(out) || 2000;
}

// OCR output is cached in .cache/ so re-running the index doesn't re-scan every page.
async function ocrFile(file) {
  const cache = path.join(".cache", `ocr-${path.basename(file)}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const pages = await runOcr(file);
  fs.mkdirSync(".cache", { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(pages));
  return pages;
}

function runOcr(file) {
  return new Promise((resolve, reject) => {
    const total = pageCount(file);
    const proc = spawn(OCR, [file, "1", String(total)]);
    const pages = [];
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        const page = JSON.parse(l);
        pages.push(page);
        if (page.page % 50 === 0) console.log(`${path.basename(file)}: ${page.page}/${total}`);
      }
    });
    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.on("close", (code) => (code === 0 ? resolve(pages) : reject(new Error(`ocr exited ${code}`))));
  });
}

// Chapter letters in dictionary order, keyed by how the running header names them ("حرف الحاء").
const CHAPTERS = [
  ["الف", "ا"], ["باء", "ب"], ["تاء", "ت"], ["ثاء", "ث"], ["جيم", "ج"], ["حاء", "ح"], ["خاء", "خ"],
  ["دال", "د"], ["ذال", "ذ"], ["راء", "ر"], ["زاي", "ز"], ["سين", "س"], ["شين", "ش"], ["صاد", "ص"],
  ["ضاد", "ض"], ["طاء", "ط"], ["ظاء", "ظ"], ["عين", "ع"], ["غين", "غ"], ["فاء", "ف"], ["قاف", "ق"],
  ["كاف", "ك"], ["لام", "ل"], ["ميم", "م"], ["نون", "ن"], ["هاء", "ه"], ["واو", "و"], ["ياء", "ي"],
];

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Chapter index named in a page's running header, or null if unreadable/ambiguous.
function headerChapter(lines) {
  for (const { t } of lines.slice(0, 5)) {
    const m = t.match(/حرف\s*ال([ء-يً-ْ]+)/);
    if (!m) continue;
    const name = m[1].replace(/[ً-ْ]/g, "").replace(/[أإآ]/g, "ا");
    const scored = CHAPTERS.map(([n], i) => [editDistance(name, n), i]).sort((x, y) => x[0] - y[0]);
    if (scored[0][0] <= 1 && scored[0][0] < scored[1][0]) return scored[0][1];
    return null;
  }
  return null;
}

// Give every page a chapter: the most common header reading among nearby pages, which
// smooths over misread or missing headers.
function pageChapters(pages) {
  const raw = pages.map((p) => headerChapter(p.lines));
  return raw.map((_, i) => {
    const counts = {};
    for (let j = Math.max(0, i - 4); j <= Math.min(raw.length - 1, i + 4); j++) {
      if (raw[j] !== null) counts[raw[j]] = (counts[raw[j]] || 0) + (j === i ? 1.5 : 1);
    }
    const top = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
    return top ? Number(top[0]) : null;
  });
}

const normFirst = (c) => (/[أإآءؤئ]/.test(c) ? "ا" : c);

const files = fs.readdirSync(DIR).filter((f) => /\.pdf$/i.test(f)).sort();
const entries = [];
for (const file of files) {
  const pages = await ocrFile(path.join(DIR, file));
  const chapters = pageChapters(pages);
  pages.forEach(({ page, lines }, pi) => {
    const chapter = chapters[pi];
    for (const { t } of lines) {
      const m = t.match(HEAD);
      if (!m) continue;
      let root = m[2].replace(/[ً-ْ\s]/g, "");
      if (root.length < 2 || root.length > 6) continue;
      // OCR often confuses dotted letters (ح/ج/خ). The page's chapter fixes the first letter,
      // unless the entry already starts the next chapter (a chapter can begin mid-page).
      if (chapter !== null) {
        const own = CHAPTERS.findIndex(([, l]) => l === normFirst(root[0]));
        if (own !== chapter + 1) root = CHAPTERS[chapter][1] + root.slice(1);
      }
      entries.push({ num: Number(toWestern(m[1])), root, file, page });
    }
  });
}

// Sort into dictionary order and drop misread numbers: an entry must sit on a page no
// earlier than the entry before it (pages increase through the files in name order).
const pos = (e) => files.indexOf(e.file) * 100000 + e.page;
entries.sort((a, b) => a.num - b.num || pos(a) - pos(b));
const clean = [];
const seen = new Set();
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  if (seen.has(e.num)) continue;
  const prev = clean[clean.length - 1];
  const next = entries[i + 1];
  // A misread number shows up out of place: its page is far from its neighbours' pages.
  if (prev && pos(e) < pos(prev)) continue;
  if (next && pos(next) < pos(e) - 3) continue;
  seen.add(e.num);
  clean.push(e);
}

fs.writeFileSync("dictionary-index.json", JSON.stringify(clean));
console.log(`Found ${entries.length} entry headers, kept ${clean.length}.`);
