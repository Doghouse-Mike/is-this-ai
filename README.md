# Is this AI?

A tiny static web app: drop in an image (say, a "photo" a customer sent to
dispute a delivery) and find out whether it was AI-generated or edited, with
a PDF report to attach to the case.

Everything runs client-side in the browser. No server, no upload, no
analytics, nothing saved: the image is read into the tab's memory, analysed,
and forgotten when you remove it or close the tab. The only thing that ever
leaves the page is the PDF you choose to download. A Content Security Policy
(`connect-src 'self'`) enforces this, so even a bug can't send an image
anywhere.

## Using it

Open the hosted page (or serve this folder locally: see below), then drop one
or more images on it. Each image gets:

- a verdict (AI-generated / altered / edited / camera capture / inconclusive)
  and the plain-English reasoning behind it;
- the signed history and signature details, when the file has Content
  Credentials;
- one-click links to the online checks that apply (Google's SynthID Detector,
  OpenAI's verifier, Content Credentials Verify). Those services do receive a copy
  of anything you upload to them, so that step is always manual;
- **Download PDF report**: the same findings plus the file's SHA-256, so the
  report can be tied to the exact file examined.

**Always check the file exactly as the customer sent it.** Slack, WhatsApp and
most email clients strip Content Credentials, which turns a provable
"AI-generated" into "inconclusive".

## How it decides

Evidence, strongest first:

1. **C2PA Content Credentials**, cryptographically verified with
   [`c2pa-web`](https://github.com/contentauth/c2pa-js) (the Content
   Authenticity Initiative's WebAssembly build of `c2pa-rs`, the same code as
   `c2patool`) against the official C2PA trust list. A trusted signature plus
   a matching data hash means the named signer (e.g. OpenAI) issued the record
   and the pixels haven't changed since. ChatGPT, Google Pixel cameras and
   others sign their output.
2. **Unsigned metadata markers**: IPTC source types, Apple Photos "Clean Up"
   records, generator names, and editing software named in
   `CreatorTool`/`Software` fields. Supporting evidence only.
3. **Camera EXIF**: supports a real capture when present; absence proves
   nothing.

Missing evidence is never treated as proof either way: no metadata is
"inconclusive", not "genuine".

### False positives this deliberately avoids

Found by running the local version over 1,000 real images:

- Apple, Samsung and others write Adobe's XMP `photoshop:` namespace and a
  "Photoshop 3.0" IPTC block without Photoshop being involved. An editor only
  counts when named as the producing software.
- Short generator names (`xai`, `grok`, `flux`) occur by chance in compressed
  pixel data and embedded JPEG thumbnails. Markers are only matched against
  readable text metadata (XMP packets, PNG text chunks, EXIF strings).

### Things it can't do

- **SynthID** has no offline detector. Google's public SynthID Detector
  (synthid.com, open to everyone since 7 October 2026, sign-in required)
  covers Google, OpenAI, NVIDIA and Kakao AI tools, so the page links to it
  rather than checking itself: that would mean uploading the image.
- No pixel-level forensics. An image with no metadata is "inconclusive".

## Trust list

The C2PA trust list (`trust/C2PA-TRUST-LIST.pem`) and the allowed certificate
EKUs (`trust/valid_eku_oids.cfg`) are bundled and served from this site, so
nothing is fetched from third parties at runtime.

They refresh themselves: `.github/workflows/refresh-trust.yml` runs
`scripts/update-trust.sh` every Monday and commits any change, which
redeploys the site. Before committing it checks that every certificate
parses, that the list hasn't shrunk by more than 20%, and that the EKU file
still allows C2PA and document-signing certificates. If a check fails,
nothing is committed and the run fails (GitHub emails the repo owner).

`trust/meta.json` records when the list last **changed** and was last
**checked**; the page footer and PDF show both. "Checked" is bumped at least
monthly, which also keeps the schedule alive: GitHub switches scheduled
workflows off after 60 days without repo activity. To refresh by hand, use
**Actions → Refresh C2PA trust list → Run workflow**, or locally:

```sh
scripts/update-trust.sh && npm test
```

The EKU file matters: without it, `c2pa-web` rejects OpenAI's signing
certificate as "missing required EKU" and reports ChatGPT images as
**Invalid** rather than **Trusted**.

## Ad blockers

uBlock Origin's default lists block URLs that look like analytics, and they
blocked this site's analysis module when it was called `analyse.js`, leaving
the page stuck on "Loading verifier...". It's now `provenance.js`. Keep file
names away from words like *analytics*, *analyse*, *track*, *stats*, *beacon*
and *pixel*. The modules are loaded so that a blocked file shows an error
straight away instead of hanging.

## Running and testing locally

Any static file server works (the WebAssembly binary needs to be served as
`application/wasm`), e.g. `python3 -m http.server`.

`npm install && npm test` loads every image in `tests/fixtures/` in headless
Chromium and checks the verdicts against `tests/expected.json`. It also fails
if the page requests anything outside its own origin, trips the CSP, or can't
produce a PDF. The fixtures are real customer images, so `tests/fixtures/` is
git-ignored and stays on the machine that ran the original investigation.

## Vendored libraries

No build step: everything in `vendor/` is checked in.

- `c2pa-web` 0.15.3 (MIT, Adobe), with one edit: its bare `import "highgain"`
  is rewritten to `../highgain/index.js`, so no import map (and no inline
  script under the CSP) is needed. The unused worker file and type
  definitions were removed.
- `highgain` 0.1.0 (ISC), the worker RPC helper that `c2pa-web` uses.
- `exifr` 7.1.3 (MIT), the full ESM build, for EXIF.
- `pdf-lib` (MIT), for the report PDF (same copy as invoice-vat-stamper).

`.github/workflows/check-c2pa-web.yml` checks npm on the 1st of each month
and opens a GitHub issue (once per version) with these steps when a newer
`c2pa-web` is out. It never upgrades by itself.

To upgrade `c2pa-web`, copy the new `dist/` in, re-apply the `highgain` import
rewrite, update `C2PA_WEB_VERSION` in `js/provenance.js`, and run `npm test`.
