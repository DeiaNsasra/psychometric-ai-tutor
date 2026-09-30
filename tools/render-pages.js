// Renders every course PDF page to a JPEG (rendered/<file>/<page>.jpg). The server sends these
// images instead of PDF pages: the PDFs' Arabic text layer is garbled, so as PDFs each page is
// billed for an image plus useless text; a 1100px image alone costs about half.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const HEIGHT = "1100";
const QUALITY = "0.75";
if (!fs.existsSync("tools/render")) execFileSync("swiftc", ["-O", "tools/render.swift", "-o", "tools/render"], { stdio: "inherit" });
for (const file of fs.readdirSync("materials").filter((f) => /\.pdf$/i.test(f)).sort()) {
  const out = path.join("rendered", file.replace(/\.pdf$/i, ""));
  console.log(file);
  execFileSync("tools/render", [path.join("materials", file), out, HEIGHT, QUALITY], { stdio: "inherit" });
}
