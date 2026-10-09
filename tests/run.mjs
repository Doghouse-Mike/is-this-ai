// Regression test: serve the site, load every fixture in headless Chromium,
// and check each verdict against tests/expected.json. Also fails if the page
// makes any request outside its own origin, trips the CSP, or can't produce
// a PDF report.
//
//   npm test            (fixtures live in tests/fixtures/, which is git-ignored:
//                        they are real customer images and must stay local)

import http from "node:http";
import { readFile, readdir, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "tests/fixtures");
const outDir = path.join(root, "tests/out");
const expected = JSON.parse(await readFile(path.join(root, "tests/expected.json"), "utf8"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".json": "application/json", ".pem": "text/plain", ".cfg": "text/plain" };

const server = http.createServer(async (req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  const file = p.endsWith("/") ? path.join(p, "index.html") : p;
  if (!file.startsWith(root) || file.startsWith(fixtures) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  res.end(await readFile(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  args: ["--headless=new"],
});
const failures = [];
try {
  const page = await browser.newPage();
  const foreign = new Set();
  page.on("request", (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith("blob:") && !r.url().startsWith("data:")) foreign.add(r.url()); });
  page.on("console", (m) => { if (/Refused to|Content Security Policy/i.test(m.text())) failures.push(`CSP: ${m.text()}`); });
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: outDir });

  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => document.getElementById("statusNote").textContent.startsWith("Ready"), { timeout: 60000 });

  const names = (await readdir(fixtures)).filter((n) => n in expected).sort();
  const missing = Object.keys(expected).filter((n) => !names.includes(n));
  if (missing.length) console.log(`(skipping ${missing.length} fixture(s) not present locally: ${missing.join(", ")})`);

  const input = await page.$("#fileInput");
  await input.uploadFile(...names.map((n) => path.join(fixtures, n)));
  await page.waitForFunction((n) => [...document.querySelectorAll(".result")].filter((c) => c.dataset.verdict !== "pending").length === n,
    { timeout: 120000 }, names.length);

  const got = await page.$$eval(".result", (cards) => cards.map((c) => ({
    name: c.querySelector(".result-name").textContent, verdict: c.dataset.verdict,
    headline: c.querySelector(".verdict .head")?.textContent || c.querySelector(".result-status")?.textContent,
    links: [...c.querySelectorAll(".next a")].map((a) => new URL(a.href).hostname),
  })));
  for (const g of got) {
    const ok = g.verdict === expected[g.name];
    console.log(`${ok ? "ok  " : "FAIL"} ${g.name.padEnd(36)} ${g.verdict.padEnd(13)} ${g.headline}`);
    if (!ok) failures.push(`${g.name}: expected ${expected[g.name]}, got ${g.verdict}`);
  }

  // Next-step links: SynthID wherever credentials don't settle it, never for
  // a signed camera capture.
  const before = failures.length;
  const SYNTHID = { "door-slack.png": true, "door-original.png": true, "chatgpt-stripped.png": true, "pixel.jpg": false };
  for (const [name, want] of Object.entries(SYNTHID)) {
    const g = got.find((x) => x.name === name);
    if (!g) continue;
    const has = g.links.includes("synthid.com");
    if (has !== want) failures.push(`${name}: SynthID link ${want ? "missing" : "unexpected"} (links: ${g.links.join(", ")})`);
  }
  if (failures.length === before) console.log("ok   next-step links checked");

  // PDF: download the first card's report and check it reads back.
  await page.click(".result .actions button");
  const deadline = Date.now() + 15000;
  let pdf;
  while (Date.now() < deadline && !(pdf = (await readdir(outDir)).find((f) => f.endsWith(".pdf")))) await new Promise((r) => setTimeout(r, 200));
  if (!pdf) failures.push("PDF report was not downloaded");
  else {
    const text = execFileSync("pdftotext", [path.join(outDir, pdf), "-"]).toString();
    for (const want of ["Image provenance report", "Findings", "SHA-256", "Method and limits"]) {
      if (!text.includes(want)) failures.push(`PDF missing "${want}"`);
    }
    console.log(`ok   PDF report ${pdf} (${text.split("\n").length} lines)`);
  }

  if (foreign.size) failures.push(`requests left the site: ${[...foreign].join(", ")}`);
  else console.log("ok   no requests outside the site's own origin");
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
