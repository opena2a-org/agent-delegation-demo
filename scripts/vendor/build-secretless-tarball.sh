#!/usr/bin/env bash
# Rebuild the vendored secretless-ai tarball from a pinned commit.
#
# Usage: scripts/vendor/build-secretless-tarball.sh <40 hex commit> [<output dir>]
#
# Runs the pinned build commands in a scratch clone with a scratch HOME, so no
# file under the real home directory is read or written by the build. The
# version field is labelled <version>-unreleased.g<leading 12 hex> before the
# build, so npm ls and the lockfile never name a released version.
set -euo pipefail

PIN="${1:?usage: $0 <40 hex commit> [<output dir>]}"
OUT="${2:-}"
if ! [[ "$PIN" =~ ^[0-9a-f]{40}$ ]]; then
  echo "commit must be 40 lowercase hex characters" >&2
  exit 2
fi

B="$(mktemp -d)"
mkdir -p "$B/home"
# The npm cache is the scratch directory's own: no npm_config_ value is read
# from the caller's environment.
CACHE="$B/npm-cache"
run() {
  env -i PATH="$PATH" HOME="$B/home" LANG=C TZ=UTC DO_NOT_TRACK=1 OPENA2A_TELEMETRY=off \
    npm_config_cache="$CACHE" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false "$@"
}

run git clone -q https://github.com/opena2a-org/secretless-ai.git "$B/sls"
run git -C "$B/sls" checkout -q --detach "$PIN"
cd "$B/sls"
VERSION="$(run node -p "require('./package.json').version")-unreleased.g$(git rev-parse --short=12 HEAD)"
run npm version "$VERSION" --no-git-tag-version >/dev/null
echo "status after the label (expect package.json and package-lock.json, nothing else):"
git status --porcelain
run npm ci --ignore-scripts --omit=optional >/dev/null
run npm run build >/dev/null
run npm pack --ignore-scripts >/dev/null
TGZ="secretless-ai-${VERSION}.tgz"
echo "node $(run node -v), npm $(run npm -v)"
shasum -a 256 "$TGZ"
if [ -n "$OUT" ]; then
  cp "$TGZ" "$OUT/"
  echo "copied to $OUT/$TGZ"
fi
echo "scratch: $B"
