#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'API still up / API还没挂 installer' \
    'Stop SillyTavern and any automatic restart script first.' \
    'Usage: bash install.sh --target /path/to/SillyTavern [--config config/config.yaml]' \
    'Requires Node.js >= 20.3, curl and unzip. Installs both plugin components.'
}
target=''
config_args=()
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --target) target="${2:?Missing --target path}"; shift 2 ;;
    --config) config_args=(--config "${2:?Missing --config path}"); shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage; exit 1 ;;
  esac
done
[[ -n "$target" ]] || { usage; exit 1; }
for dependency in node curl unzip; do
  command -v "$dependency" >/dev/null || { printf 'Missing dependency: %s\n' "$dependency" >&2; exit 1; }
done
target=$(cd -- "$target" && pwd -P)
node - "$target" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || major === 20 && minor < 3) throw Error('Node.js 20.3 or newer is required');
const root = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.name !== 'sillytavern' || !fs.existsSync(path.join(root, 'server.js'))) throw Error('Target is not a SillyTavern directory');
NODE

work=$(mktemp -d "${TMPDIR:-/tmp}/api-still-up.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
base=${SF_RELEASE_BASE:-https://github.com/tiewangba2020/SillyTavern-SilentFailover/releases}
curl -fL --connect-timeout 20 --max-time 180 --retry 2 "$base/latest/download/silent-failover-update.json" -o "$work/update.json"
version=$(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); if(!/^\d+\.\d+\.\d+$/.test(j.version))throw Error("Invalid release version");process.stdout.write(j.version)' "$work/update.json")
archive="SillyTavern-SilentFailover-v$version.zip"
curl -fL --connect-timeout 20 --max-time 180 --retry 2 "$base/download/v$version/$archive" -o "$work/$archive"
curl -fL --connect-timeout 20 --max-time 60 --retry 2 "$base/download/v$version/SHA256SUMS-$version" -o "$work/checksums"
node - "$work/$archive" "$work/checksums" "$archive" <<'NODE'
const fs = require('node:fs'), crypto = require('node:crypto');
const [zip, sums, name] = process.argv.slice(2);
const line = fs.readFileSync(sums, 'utf8').split(/\r?\n/).map(x => x.trim().split(/\s+/)).find(x => x[1] === name);
const hash = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
if (!line || !/^[a-f\d]{64}$/i.test(line[0]) || hash !== line[0].toLowerCase()) throw Error('Release checksum mismatch; installation cancelled');
NODE
unzip -q "$work/$archive" -d "$work/package"
node "$work/package/install.mjs" --target "$target" "${config_args[@]}"
printf '%s\n' 'Installation complete. Restart SillyTavern, then refresh its webpage.'
