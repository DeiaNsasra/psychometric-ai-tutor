// Builds index.json: one short text snippet per PDF page, grouped into runs of
// pages that share the same running header. The chat server gives this index to
// a router call that picks which pages to send with each question.
import fs from "fs";
import path from "path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const MATERIALS_DIR = "materials";

// PDF text layers here use Arabic presentation forms; NFKC maps them back to base letters.
function clean(s) {
  return s.normalize("NFKC").replace(/[ـً-ٟ]/g, "").replace(/[^\S\n]+/g, " ").trim();
}

const MAX_RUN = 12; // split long runs so the router can pick part of a chapter

// Topic key: the running header is "<book> - <page no.> - <topic> ...". Take the two
// words after the page number, so consecutive pages of the same topic group together.
function topicKey(snippet) {
  const m = snippet.match(/^.{0,40}?\d+\s*-?\s*(.*)$/);
  const rest = (m ? m[1] : snippet).replace(/[\d\-–.()]+/g, " ").trim();
  return rest.split(/\s+/).slice(0, 2).join(" ");
}

const files = fs.readdirSync(MATERIALS_DIR).filter((f) => /\.pdf$/i.test(f)).sort();
const index = [];
for (const file of files) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(path.join(MATERIALS_DIR, file))),
    verbosity: 0,
  }).promise;
  const runs = [];
  let empty = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const text = clean(tc.items.map((i) => i.str).join(" "));
    if (!text) empty++;
    const snippet = text.slice(0, 90);
    const key = topicKey(snippet);
    const last = runs[runs.length - 1];
    if (last && last.key === key && p - last.start < MAX_RUN) last.end = p;
    else runs.push({ key, start: p, end: p, snippet });
  }
  index.push({
    file,
    pages: doc.numPages,
    sections: runs
      // English is out of scope for now (quantitative and verbal only); drop the course
      // book's English chapter, whose running header starts with the (garbled) word "إنجليزية".
      .filter((r) => !/^(إجنليزية|إنجليزية)/.test(r.snippet))
      .map(({ start, end, snippet }) => ({ start, end, snippet })),
  });
  console.log(`${file}: ${doc.numPages} pages, ${runs.length} sections${empty ? `, ${empty} pages without text` : ""}`);
}
fs.writeFileSync("index.json", JSON.stringify(index, null, 1));
