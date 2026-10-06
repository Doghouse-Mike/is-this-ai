// Builds the evidence report PDF in the browser with pdf-lib (global PDFLib).
// Nothing is uploaded: the PDF is assembled in memory and handed to the
// browser's download.

import { C2PA_WEB_VERSION } from "./analyse.js";

const { PDFDocument, StandardFonts, rgb } = window.PDFLib;

export const VERDICTS = {
  ai: { label: "AI-GENERATED", colour: [0.706, 0.137, 0.094] },
  altered: { label: "ALTERED AFTER SIGNING", colour: [0.706, 0.137, 0.094] },
  edited: { label: "EDITED", colour: [0.71, 0.278, 0.031] },
  capture: { label: "CAMERA CAPTURE", colour: [0.024, 0.463, 0.278] },
  inconclusive: { label: "INCONCLUSIVE", colour: [0.278, 0.329, 0.404] },
};
const SEV_COLOUR = {
  ai: [0.706, 0.137, 0.094], edit: [0.71, 0.278, 0.031],
  capture: [0.024, 0.463, 0.278], info: [0.4, 0.44, 0.52],
};

// Standard PDF fonts only encode WinAnsi; map common extras and drop the rest.
const WINANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
function winAnsi(s) {
  return String(s)
    .replace(/→/g, "->").replace(/×/g, "x").replace(/[‐‑]/g, "-")
    .replace(/[^\x20-\x7e\xa0-\xff\n]/g, (c) => (WINANSI_EXTRA.includes(c) ? c : "?"));
}

export async function buildReportPdf(r, trust) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Image provenance report - ${r.name}`);
  doc.setProducer("Is this AI? (in-browser)");
  doc.setCreator("Is this AI?");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const W = 595.28, H = 841.89, M = 50, CW = W - 2 * M;
  const ink = rgb(0.063, 0.094, 0.157), muted = rgb(0.4, 0.44, 0.52), line = rgb(0.9, 0.91, 0.93);
  let page = doc.addPage([W, H]);
  let y = H - M;

  const ensure = (h) => {
    if (y - h < M) { page = doc.addPage([W, H]); y = H - M; }
  };
  const wrap = (text, f, size, width) => {
    const out = [];
    for (const para of winAnsi(text).split("\n")) {
      let cur = "";
      for (const word of para.split(/\s+/)) {
        // Hard-break tokens wider than the line (hashes, long file names).
        let w = word;
        while (f.widthOfTextAtSize(w, size) > width) {
          let n = w.length;
          while (n > 1 && f.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
          if (cur) { out.push(cur); cur = ""; }
          out.push(w.slice(0, n));
          w = w.slice(n);
        }
        const next = cur ? `${cur} ${w}` : w;
        if (f.widthOfTextAtSize(next, size) > width && cur) { out.push(cur); cur = w; } else cur = next;
      }
      out.push(cur);
    }
    return out;
  };
  const text = (s, { f = font, size = 10, colour = ink, x = M, width = CW, gap = 3 } = {}) => {
    const lh = size * 1.35;
    for (const l of wrap(s, f, size, width)) {
      ensure(lh);
      page.drawText(l, { x, y: y - size, size, font: f, color: colour });
      y -= lh;
    }
    y -= gap;
  };
  const heading = (s) => {
    ensure(40);
    y -= 12;
    text(s, { f: bold, size: 12, gap: 2 });
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: line });
    y -= 8;
  };
  const table = (rows, { keyWidth = 120, valueFont = font } = {}) => {
    for (const [k, v] of rows) {
      const kl = wrap(k, font, 9, keyWidth - 8);
      const vl = wrap(v, valueFont, 9, CW - keyWidth);
      const h = Math.max(kl.length, vl.length) * 12.2 + 4;
      ensure(h);
      kl.forEach((l, i) => page.drawText(l, { x: M, y: y - 9 - i * 12.2, size: 9, font, color: muted }));
      vl.forEach((l, i) => page.drawText(l, { x: M + keyWidth, y: y - 9 - i * 12.2, size: 9, font: valueFont, color: ink }));
      y -= h;
      page.drawLine({ start: { x: M, y: y + 1 }, end: { x: W - M, y: y + 1 }, thickness: 0.4, color: line });
      y -= 3;
    }
  };

  // Title
  text("Image provenance report", { f: bold, size: 18, gap: 2 });
  text(`${r.name}  -  examined ${r.examined.toISOString().replace("T", " ").slice(0, 16)} UTC`, { size: 9, colour: muted, gap: 10 });

  // Verdict box
  const v = VERDICTS[r.verdict];
  const vc = rgb(...v.colour);
  const headLines = wrap(r.headline, bold, 13, CW - 28);
  const boxH = 30 + headLines.length * 17;
  ensure(boxH + 10);
  page.drawRectangle({ x: M, y: y - boxH, width: CW, height: boxH, borderColor: vc, borderWidth: 1.5,
    color: rgb(1 - (1 - v.colour[0]) * 0.06, 1 - (1 - v.colour[1]) * 0.06, 1 - (1 - v.colour[2]) * 0.06) });
  page.drawText(v.label, { x: M + 14, y: y - 18, size: 9, font: bold, color: vc });
  headLines.forEach((l, i) => page.drawText(l, { x: M + 14, y: y - 36 - i * 17, size: 13, font: bold, color: ink }));
  y -= boxH + 14;

  // Thumbnail
  if (r.thumb) {
    const img = await doc.embedJpg(await r.thumb.blob.arrayBuffer());
    const maxW = CW * 0.6, maxH = 300;
    const s = Math.min(maxW / img.width, maxH / img.height, 1);
    ensure(img.height * s + 20);
    page.drawImage(img, { x: M, y: y - img.height * s, width: img.width * s, height: img.height * s });
    y -= img.height * s + 4;
    text(`Image examined: ${r.name}`, { size: 8, colour: muted, gap: 6 });
  }

  heading("Findings");
  for (const [sev, title, body] of r.findings) {
    ensure(30);
    page.drawCircle({ x: M + 3, y: y - 6, size: 2.6, color: rgb(...SEV_COLOUR[sev]) });
    text(title, { f: bold, size: 10, x: M + 14, width: CW - 14, gap: 1 });
    text(body, { size: 9.5, x: M + 14, width: CW - 14, colour: rgb(0.2, 0.25, 0.33), gap: 7 });
  }

  if (r.c2pa?.steps.length) {
    heading("Recorded history (from the signed manifest)");
    table(r.c2pa.steps.map((s) => [
      s.when ? s.when.slice(0, 19).replace("T", " ") + " UTC" : "-",
      [s.action, s.agent && `tool: ${s.agent}`, s.source && `source: ${s.source}`].filter(Boolean).join("  |  "),
    ]), { keyWidth: 130 });
    if (r.c2pa.allActions === false) {
      text("The signer marks this list as possibly incomplete (allActionsIncluded: false), which is normal for AI services.", { size: 8.5, colour: muted });
    }
  }

  if (r.c2pa) {
    heading("Content Credentials signature");
    table([
      ["Validation result", r.c2pa.state], ["Signed by", r.c2pa.signer], ["Certificate", r.c2pa.signerCn || "-"],
      ["Signed at", r.c2pa.signed || "-"], ["Claim generator", r.c2pa.generator || "-"],
      ["Failures", r.c2pa.failures.join(", ") || "none"],
    ]);
  }

  heading("Further checks (online)");
  for (const f of r.further) {
    text(f.title + (f.url ? `  -  ${f.url}` : ""), { f: bold, size: 9.5, gap: 1 });
    text(f.text, { size: 9, colour: rgb(0.2, 0.25, 0.33), gap: 6 });
  }
  text("These services receive a copy of any image you upload to them.", { size: 8.5, colour: muted });

  heading("File examined");
  const rows = [
    ["File name", r.name], ["SHA-256", r.sha256], ["Size", `${r.size.toLocaleString("en-GB")} bytes`],
    ["Format", r.format], ["Dimensions", r.dims ? `${r.dims[0]} x ${r.dims[1]} px` : "-"],
    ...Object.entries(r.camera).map(([k, val]) => [`EXIF ${k}`, val]),
  ];
  table(rows, { valueFont: mono });

  heading("Method and limits");
  text(`Content Credentials (C2PA) were read and cryptographically verified in the browser with c2pa-web ${C2PA_WEB_VERSION} (the Content Authenticity Initiative's WebAssembly build of c2pa-rs) against the C2PA conformance trust list (checked ${trust.checked}, last changed ${trust.changed}). A valid, trusted signature with a matching data hash means the record was issued by the named signer and the image is unchanged since. Anyone can re-check this independently by uploading the same file to contentcredentials.org/verify.`, { size: 8.5, colour: muted });
  text("File metadata (EXIF, XMP, PNG text) was also inspected; it is unsigned and supporting only. Missing metadata is never treated as evidence on its own. Invisible watermarks such as SynthID cannot be checked offline, and no pixel-level forensics were performed.", { size: 8.5, colour: muted });
  text("The analysis ran entirely in the examiner's web browser: the image was not uploaded or stored anywhere. The SHA-256 above identifies the exact file examined; keep the original alongside this report.", { size: 8.5, colour: muted });

  return doc.save();
}
