# Vendored and pinned upstream code

Nothing in this directory is edited. Fixes go to the upstream repository, and
a new pin replaces the file here. `vendor/pins.json` holds the same values in
machine readable form; the demo reads its pins from there at start.

## Reference Node.js verifier from aap-conformance

| Field | Value |
|---|---|
| Repository | https://github.com/opena2a-standards/aap-conformance |
| Commit | `a4ab3d9e27bf1a0a3edd8029e0cfca5e0549d078` |
| Path upstream | `verifiers/node/verify.mjs` |
| Path here | `vendor/aap-conformance/a4ab3d9e27bf/verify.mjs` |
| Git blob id | `2794b20638b1bb4ff6ff196f52efa11ef795bbb9` |
| sha256 | `2cd68050f1f6d45ac74935b58dfe7b4a53932e3c2ec09d65bcf8a21edeef0f67` |
| License | Apache-2.0, `vendor/aap-conformance/a4ab3d9e27bf/LICENSE` (the repository has no NOTICE file) |
| Dependency | `@noble/post-quantum` 0.6.1, the version the repository's package.json names at this commit |

Reproduce: `git -C <aap-conformance clone> rev-parse a4ab3d9e27bf1a0a3edd8029e0cfca5e0549d078:verifiers/node/verify.mjs`
prints the blob id above, and `git hash-object vendor/aap-conformance/a4ab3d9e27bf/verify.mjs` prints the same.

## secretless-ai, unreleased build

| Field | Value |
|---|---|
| Repository | https://github.com/opena2a-org/secretless-ai |
| Commit | `0b25f7451f41482d247148347cdd242aa02770a4` |
| Version label | `0.23.1-unreleased.g0b25f7451f41` |
| File | `vendor/secretless-ai-0.23.1-unreleased.g0b25f7451f41.tgz` |
| sha256 | `7add7fd7ae52aa339656ed3a27d3b5aa53285f5d8a82ae0540cabf21c1230388` |
| Per file sha256 of the unpacked package | `vendor/secretless-ai-0.23.1-unreleased.g0b25f7451f41.files.sha256` (547 files) |
| Built with | Node.js v26.12.0, npm 11.20.0, macOS |
| Imported module | `secretless-ai/dist/broker/index.js`, and no other module of the package |

This is an unreleased build of secretless-ai at commit 0b25f7451f41; npm does
not serve these bytes, and the file carries no provenance attestation.

Rebuild: `scripts/vendor/build-secretless-tarball.sh 0b25f7451f41482d247148347cdd242aa02770a4`.
It runs these commands in a scratch clone with a scratch HOME and a scratch npm cache:

```
git clone -q https://github.com/opena2a-org/secretless-ai.git "$B/sls" && git -C "$B/sls" checkout -q --detach "$P"
cd "$B/sls" && npm version "$(node -p "require('./package.json').version")-unreleased.g$(git rev-parse --short=12 HEAD)" --no-git-tag-version
npm ci --ignore-scripts --omit=optional && npm run build && npm pack --ignore-scripts && shasum -a 256 secretless-ai-*.tgz
```

Tar metadata can differ between machines; the per file manifest is the
comparison that must be equal.

## Agent credentials

`fixtures/agents/*.atx.json` were produced by the atx-conformance fixture
generator at commit `20355a14863788209871fca5ee8109c1e23a58c7`, signed under
its published test vector `vectors/issuer-secondary.json`. See
`fixtures/README.md` and `scripts/agent-credentials/regenerate.sh`. The same
run produces `test/fixtures/atx-lifetime/*.atx.json`, the two credentials of
the verifier lifetime check; `vendor/pins.json` records the sha256 of all four.
