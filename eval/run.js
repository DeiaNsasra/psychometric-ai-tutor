// Cost/quality eval: runs eval/questions.json through the real server under several setups,
// grades each final answer against the known option number, and reports accuracy and cost.
// Usage: node eval/run.js <config> [<config> ...]   (configs below). Spends real API money.
import fs from "fs";
import { spawn } from "child_process";
import Anthropic from "@anthropic-ai/sdk";

for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const CONFIGS = {
  baseline: { PAGE_FORMAT: "pdf", MAX_PAGES_PER_TURN: "30", MODEL: "claude-opus-5" },
  images: { PAGE_FORMAT: "image", MAX_PAGES_PER_TURN: "30", MODEL: "claude-opus-5" },
  "images-12": { PAGE_FORMAT: "image", MAX_PAGES_PER_TURN: "12", MODEL: "claude-opus-5" },
  "images-12-sonnet": { PAGE_FORMAT: "image", MAX_PAGES_PER_TURN: "12", MODEL: "claude-sonnet-5" },
  // Opus picks the pages, Sonnet writes the answer.
  "sonnet-answer": { PAGE_FORMAT: "image", MAX_PAGES_PER_TURN: "30", MODEL: "claude-sonnet-5", ROUTER_MODEL: "claude-opus-5" },
  "sonnet-answer-12": { PAGE_FORMAT: "image", MAX_PAGES_PER_TURN: "12", MODEL: "claude-sonnet-5", ROUTER_MODEL: "claude-opus-5" },
};

// "--only <prefix>" limits the run to questions whose id starts with the prefix.
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt > 0 ? process.argv.splice(onlyAt, 2)[1] : null;

const questions = JSON.parse(fs.readFileSync("eval/questions.json", "utf8")).filter((q) => !only || q.id.startsWith(only));
const client = new Anthropic();

async function ask(port, q) {
  const msg = { role: "user", text: q.text };
  if (q.image) msg.images = [{ media_type: "image/jpeg", data: fs.readFileSync(q.image).toString("base64") }];
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [msg] }),
  });
  let text = "", refs = [], cost = 0, error = null;
  for (const block of (await res.text()).split("\n\n")) {
    if (!block.startsWith("data: ")) continue;
    const d = JSON.parse(block.slice(6));
    if (d.text) text += d.text;
    if (d.refs) refs = d.refs;
    if (d.usage) cost = d.usage.cost;
    if (d.error) error = d.error;
  }
  return { text, refs, cost, error };
}

// Which option the tutor settled on, read by a small model (0 = no final choice).
async function grade(q, text) {
  if (!text) return 0;
  const r = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 50,
    output_config: {
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { choice: { type: "integer" } }, required: ["choice"], additionalProperties: false },
      },
    },
    messages: [{
      role: "user",
      content: `A tutor answered a multiple-choice question (options 1-4). Which option number did the tutor give as the final answer? Return 0 if the tutor gave no final option (for example it said the answer is not in the materials).\n\nQuestion:\n${q.text}\n\nTutor's answer:\n${text}`,
    }],
  });
  try { return JSON.parse(r.content.find((b) => b.type === "text").text).choice; } catch { return 0; }
}

async function startServer(env, port) {
  const proc = spawn("node", ["server.js"], { env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1", SITE_PASSWORD: "" }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => proc.stdout.on("data", (d) => String(d).includes("http://") && resolve()));
  return proc;
}

fs.mkdirSync("eval/results", { recursive: true });
let port = 4100;
for (const name of process.argv.slice(2)) {
  const env = CONFIGS[name];
  if (!env) throw new Error(`unknown config ${name}`);
  const server = await startServer(env, ++port);
  const rows = [];
  const queue = [...questions];
  // One question alone first, so the shared caches are written once rather than by three
  // parallel requests that all miss.
  const worker = (n) => async () => {
    while (queue.length) {
      const q = queue.shift();
      const r = await ask(port, q);
      const choice = await grade(q, r.text);
      const pages = r.refs.reduce((n, x) => n + x.end - x.start + 1, 0);
      rows.push({ id: q.id, expected: q.answer, choice, correct: choice === q.answer, cost: r.cost, pages, error: r.error, text: r.text });
      console.log(`[${name}] ${q.id}: ${choice === q.answer ? "✓" : "✗"} (chose ${choice}, expected ${q.answer}) $${r.cost.toFixed(3)} ${pages}p${r.error ? " ERROR " + r.error : ""}`);
      if (n === 1) break;
    }
  };
  await worker(1)();
  await Promise.all([1, 2, 3].map(() => worker(0)()));
  server.kill();
  rows.sort((a, b) => questions.findIndex((q) => q.id === a.id) - questions.findIndex((q) => q.id === b.id));
  fs.writeFileSync(`eval/results/${name}${only ? "-" + only : ""}.json`, JSON.stringify(rows, null, 1));
  const correct = rows.filter((r) => r.correct).length;
  const total = rows.reduce((s, r) => s + r.cost, 0);
  console.log(`== ${name}: ${correct}/${rows.length} correct, total $${total.toFixed(2)}, avg $${(total / rows.length).toFixed(3)} per question, avg ${(rows.reduce((s, r) => s + r.pages, 0) / rows.length).toFixed(1)} pages\n`);
}
