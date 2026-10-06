#!/bin/sh
# Refresh the bundled C2PA trust list and EKU config. Run from the repo root,
# check `git diff`, run `npm test`, then commit. The site never fetches these
# at runtime: they are served from trust/ so no request leaves the site.
set -eu
curl -fsSL https://raw.githubusercontent.com/c2pa-org/conformance-public/main/trust-list/C2PA-TRUST-LIST.pem -o trust/C2PA-TRUST-LIST.pem.new
grep -q 'BEGIN CERTIFICATE' trust/C2PA-TRUST-LIST.pem.new
mv trust/C2PA-TRUST-LIST.pem.new trust/C2PA-TRUST-LIST.pem
curl -fsSL https://raw.githubusercontent.com/contentauth/c2pa-rs/main/sdk/src/crypto/cose/valid_eku_oids.cfg -o trust/valid_eku_oids.cfg
printf '{\n  "fetched": "%s",\n  "source": "https://github.com/c2pa-org/conformance-public/tree/main/trust-list"\n}\n' "$(date +%F)" > trust/meta.json
echo "Updated trust list: $(grep -c 'BEGIN CERTIFICATE' trust/C2PA-TRUST-LIST.pem) certificates"
