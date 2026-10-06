#!/bin/sh
# Refresh the bundled C2PA trust list and EKU config, after sanity checks.
# Run from the repo root. Used weekly by .github/workflows/refresh-trust.yml;
# locally, follow with `npm test` before committing.
#
# trust/meta.json records "changed" (content last differed) and "checked"
# (last successful check). "checked" is only bumped when something changed or
# it is 25+ days old, so the workflow commits roughly monthly at minimum:
# GitHub disables scheduled workflows after 60 days without repo activity.
#
# The site never fetches these at runtime; they're served from trust/.
set -eu

ANCHORS_URL=https://raw.githubusercontent.com/c2pa-org/conformance-public/main/trust-list/C2PA-TRUST-LIST.pem
EKU_URL=https://raw.githubusercontent.com/contentauth/c2pa-rs/main/sdk/src/crypto/cose/valid_eku_oids.cfg

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$ANCHORS_URL" -o "$tmp/anchors.pem"
curl -fsSL "$EKU_URL" -o "$tmp/ekus.cfg"

count_certs() {
  openssl crl2pkcs7 -nocrl -certfile "$1" | openssl pkcs7 -print_certs -noout | grep -c '^subject='
}

# Every certificate must parse, and the list must not shrink sharply: a
# truncated download or upstream accident would make real signers "untrusted".
new=$(count_certs "$tmp/anchors.pem")
old=$(count_certs trust/C2PA-TRUST-LIST.pem 2>/dev/null || echo 0)
declared=$(grep -c 'BEGIN CERTIFICATE' "$tmp/anchors.pem")
[ "$new" -eq "$declared" ] || { echo "trust list: only $new of $declared certificates parse" >&2; exit 1; }
[ "$new" -ge 10 ] || { echo "trust list: only $new certificates" >&2; exit 1; }
[ "$new" -ge $((old * 8 / 10)) ] || { echo "trust list: shrank from $old to $new certificates" >&2; exit 1; }

# Without these EKUs, OpenAI (C2PA signing) and document-signing certificates
# fail validation and ChatGPT images show as Invalid instead of Trusted.
for oid in 1.3.6.1.4.1.62558.2.1 1.3.6.1.5.5.7.3.36; do
  grep -qx "$oid" "$tmp/ekus.cfg" || { echo "EKU config: missing $oid" >&2; exit 1; }
done

changed=0
cmp -s "$tmp/anchors.pem" trust/C2PA-TRUST-LIST.pem || changed=1
cmp -s "$tmp/ekus.cfg" trust/valid_eku_oids.cfg || changed=1
if [ "$changed" -eq 1 ]; then
  cp "$tmp/anchors.pem" trust/C2PA-TRUST-LIST.pem
  cp "$tmp/ekus.cfg" trust/valid_eku_oids.cfg
fi

python3 - "$changed" <<'EOF'
import datetime, json, sys
path = "trust/meta.json"
meta = json.load(open(path))
today = datetime.date.today()
changed = sys.argv[1] == "1"
checked = datetime.date.fromisoformat(meta.get("checked", meta.get("changed", "2000-01-01")))
if changed:
    meta["changed"] = today.isoformat()
if changed or (today - checked).days >= 25:
    meta["checked"] = today.isoformat()
meta.pop("fetched", None)
meta["source"] = "https://github.com/c2pa-org/conformance-public/tree/main/trust-list"
json.dump(meta, open(path, "w"), indent=2)
open(path, "a").write("\n")
EOF

echo "trust list: $new certificates ($( [ "$changed" -eq 1 ] && echo updated || echo unchanged ))"
