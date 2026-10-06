// UI: pick images, analyse each in turn, render a result card per image.
// Images and results live only in this tab's memory. Nothing is logged,
// stored or sent anywhere; "Clear" and closing the tab discard everything.

import { analyse, initVerifier } from "./analyse.js";
import { buildReportPdf, VERDICTS } from "./report-pdf.js";

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const results = document.getElementById("results");
const statusNote = document.getElementById("statusNote");
const clearBtn = document.getElementById("clearBtn");
const trustDate = document.getElementById("trustDate");

let trust = { changed: "?", checked: "?" };
let queue = Promise.resolve();
const objectUrls = new Set();

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

// The verifier normally starts in well under a second. If it hasn't after 20s
// it is almost always a browser extension blocking its worker, or a page
// half-loaded mid-deploy; say so rather than sit on "Loading" forever. If it
// does start later, the success handler below clears the warning.
const slowTimer = setTimeout(() => {
  statusNote.textContent = "The verifier hasn't started. Try reloading (Ctrl+Shift+R). If it still won't load, a browser extension may be blocking it: try a private window, or turn off ad/tracker blockers for this site.";
  statusNote.classList.add("err");
}, 20000);

const ready = initVerifier()
  .then(([, ctx]) => {
    trust = ctx.trust;
    trustDate.textContent = `Trust list checked ${trust.checked}, last changed ${trust.changed}.`;
    statusNote.textContent = "Ready. Images stay on this device.";
    statusNote.classList.remove("err");
  })
  .catch((e) => {
    statusNote.textContent = `The verifier failed to load (${e.message}). Content Credentials can't be checked in this browser.`;
    statusNote.classList.add("err");
  })
  .finally(() => clearTimeout(slowTimer));

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function table(rows, mono = false) {
  return el("table", {}, rows.map(([k, v]) => el("tr", {}, el("th", {}, k), el("td", {}, mono ? el("code", {}, v) : v))));
}

function renderResult(card, r) {
  card.replaceChildren();
  const v = VERDICTS[r.verdict];
  card.append(
    el("div", { class: "result-head" }, el("span", { class: "result-name" }, r.name)),
    el("div", { class: `verdict ${r.verdict}` }, el("div", { class: "tag" }, v.label), el("div", { class: "head" }, r.headline)),
  );
  if (r.thumb) {
    const url = URL.createObjectURL(r.thumb.blob);
    objectUrls.add(url);
    card.append(el("img", { class: "thumb", src: url, alt: `Preview of ${r.name}` }));
  }

  card.append(el("h3", {}, "Findings"), el("ul", { class: "findings" },
    r.findings.map(([sev, title, body]) => el("li", {}, el("span", { class: `dot ${sev}` }), el("div", {}, el("b", {}, title), el("p", {}, body))))));

  if (r.c2pa?.steps.length) {
    card.append(el("h3", {}, "Recorded history"), table(r.c2pa.steps.map((s) => [
      s.when ? s.when.slice(0, 19).replace("T", " ") : "-",
      [s.action, s.agent && `tool: ${s.agent}`, s.source].filter(Boolean).join(" · "),
    ])));
  }
  if (r.c2pa) {
    card.append(el("h3", {}, "Content Credentials signature"), table([
      ["Validation", r.c2pa.state], ["Signed by", r.c2pa.signer], ["Certificate", r.c2pa.signerCn || "-"],
      ["Signed at", r.c2pa.signed || "-"], ["Failures", r.c2pa.failures.join(", ") || "none"],
    ]));
  }

  card.append(el("h3", {}, "Next steps"), el("div", { class: "next" }, r.further.map((f) => f.url
    ? el("a", { href: f.url, target: "_blank", rel: "noopener noreferrer" }, el("b", {}, f.title), el("span", {}, f.text))
    : el("div", {}, el("b", {}, f.title), el("span", {}, f.text)))));
  if (r.further.some((f) => f.url)) {
    card.append(el("p", { class: "note" }, "Links open the service in a new tab; drag the same file in there. Those services do receive a copy of anything you upload to them."));
  }

  card.append(el("h3", {}, "File"), table([
    ["Name", r.name], ["SHA-256", r.sha256], ["Size", `${r.size.toLocaleString("en-GB")} bytes`],
    ["Format", r.format], ["Dimensions", r.dims ? `${r.dims[0]} × ${r.dims[1]} px` : "-"],
    ...Object.entries(r.camera).map(([k, val]) => [`EXIF ${k}`, val]),
  ], true));

  const pdfBtn = el("button", {}, "Download PDF report");
  pdfBtn.addEventListener("click", async () => {
    pdfBtn.disabled = true;
    try {
      download(await buildReportPdf(r, trust), `${r.name.replace(/\.[^.]+$/, "")}-provenance-report.pdf`);
    } catch (e) {
      pdfBtn.textContent = `PDF failed: ${e.message}`;
    } finally {
      pdfBtn.disabled = false;
    }
  });
  const removeBtn = el("button", { class: "secondary" }, "Remove");
  removeBtn.addEventListener("click", () => {
    card.querySelectorAll("img").forEach((img) => { URL.revokeObjectURL(img.src); objectUrls.delete(img.src); });
    card.remove();
    clearBtn.hidden = !results.children.length;
  });
  card.append(el("div", { class: "actions" }, pdfBtn, removeBtn));
}

function addFiles(list) {
  for (const file of list) {
    const card = el("div", { class: "panel result", "data-verdict": "pending" },
      el("div", { class: "result-head" }, el("span", { class: "result-name" }, file.name), el("span", { class: "result-status" }, "queued")));
    results.append(card);
    clearBtn.hidden = false;
    queue = queue.then(async () => {
      await ready;
      if (!card.isConnected) return;
      card.querySelector(".result-status").textContent = "checking...";
      try {
        const r = await analyse(file);
        if (!card.isConnected) return;
        renderResult(card, r);
        card.dataset.verdict = r.verdict;
      } catch (e) {
        card.querySelector(".result-status").textContent = `failed: ${e.message}`;
        card.dataset.verdict = "error";
      }
    });
  }
  fileInput.value = "";
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", (e) => addFiles(e.target.files));
for (const evt of ["dragenter", "dragover"]) dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
for (const evt of ["dragleave", "drop"]) dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); });
dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
// A file dropped outside the drop zone would otherwise be opened by the browser.
for (const evt of ["dragover", "drop"]) window.addEventListener(evt, (e) => e.preventDefault());

clearBtn.addEventListener("click", () => {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  results.replaceChildren();
  clearBtn.hidden = true;
});
