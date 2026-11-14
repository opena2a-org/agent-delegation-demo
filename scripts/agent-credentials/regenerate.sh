#!/usr/bin/env bash
# Regenerate fixtures/agents/*.atx.json, and the two credentials of the
# verifier lifetime check in test/fixtures/atx-lifetime/, with the
# atx-conformance generator.
#
# Usage: scripts/agent-credentials/regenerate.sh [<output dir> [<lifetime check output dir>]]
# Needs git, Go 1.22 or later and python3. Running the demo needs none of them.
# ATX_CONFORMANCE_SOURCE names another clone source (a local clone, say) and
# GOPROXY another module source (file://<module cache>/cache/download, say);
# the pinned commit and the go.sum check are the same either way.
#
# The generator is cloned at the pinned commit into a scratch directory; the
# overlay zz_demo_agents.go is the one file added. The script refuses to copy
# anything out unless the clone's status shows that file alone and the
# repository's own fixture immutability check passes.
set -euo pipefail

PIN=20355a14863788209871fca5ee8109c1e23a58c7
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$REPO/fixtures/agents}"
LIFE="${2:-$REPO/test/fixtures/atx-lifetime}"
SOURCE="${ATX_CONFORMANCE_SOURCE:-https://github.com/opena2a-standards/atx-conformance.git}"
PROXY="${GOPROXY:-https://proxy.golang.org,direct}"
B="$(mktemp -d)"

env -i PATH="$PATH" HOME="$B" git clone -q "$SOURCE" "$B/atx"
git -C "$B/atx" checkout -q --detach "$PIN"
cp "$HERE/zz_demo_agents.go" "$B/atx/scripts/generate-fixtures/"
mkdir -p "$B/out"
(cd "$B/atx/scripts/generate-fixtures" && env -i PATH="$PATH" HOME="$B" GOFLAGS=-mod=mod GOPROXY="$PROXY" GOPATH="$B/go" GOCACHE="$B/gocache" DEMO_AGENT_OUT="$B/out" go run .)
STATUS="$(git -C "$B/atx" status --porcelain)"
if [ "$STATUS" != "?? scripts/generate-fixtures/zz_demo_agents.go" ]; then
  echo "refused: the generator changed more than the overlay:" >&2
  echo "$STATUS" >&2
  exit 1
fi
(cd "$B/atx" && python3 -I scripts/check_fixture_immutability.py)
mkdir -p "$OUT" "$LIFE"
cp "$B/out/billpay-agent.atx.json" "$B/out/budget-agent.atx.json" "$OUT/"
cp "$B/out/lifetime-issued-8-days-before.atx.json" "$B/out/lifetime-issued-1-day-before.atx.json" "$LIFE/"
shasum -a 256 "$OUT/billpay-agent.atx.json" "$OUT/budget-agent.atx.json" "$LIFE/lifetime-issued-8-days-before.atx.json" "$LIFE/lifetime-issued-1-day-before.atx.json"
