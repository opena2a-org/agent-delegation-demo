# Fixtures

Every customer, account, payee and payment in this demo is fictional. Account
identifiers carry a DEMO marker and every domain ends in `.test`.

## Agent credentials (`agents/`)

| File | Agent ID | Capabilities |
|---|---|---|
| `billpay-agent.atx.json` | `demo_billpay_agent` | `payment:billpay` |
| `budget-agent.atx.json` | `demo_budget_agent` | `payment:read`, `payment:billpay` |

These are ATX 1.1 credentials signed with a **published test key**: the
atx-conformance vector `vectors/issuer-secondary.json` at commit
`20355a14863788209871fca5ee8109c1e23a58c7`
(https://github.com/opena2a-standards/atx-conformance). Its issuer is
`did:opena2a:authority:partner.example`, a name under the reserved `.example`
domain, and its seed is public in that repository, so anyone can sign a
credential with it. These credentials prove nothing outside this demo.
The issuer is a test issuer, not an authority OpenA2A runs.

They expire on 2099-12-31: they are long lived test fixtures, and the pinned
verifier checks `expiresAt` and nothing else about their age. The trust score, trust level and scan summary
fields are the generator's baseline test values, not results of any scan; the
demo never reads or shows them.

The budget agent's credential carries `payment:billpay` on purpose: its code
can attempt a payment, and the bank's own check, which binds each consent to
one agent, is what refuses it.

Regenerate with `scripts/agent-credentials/regenerate.sh` (needs git, Go and
python3; running the demo needs none of them). The script clones the generator
at the pinned commit into a scratch directory, adds one overlay file, checks
that nothing else changed and that the repository's fixture immutability check
passes, and copies the two files here. The same run writes the two
credentials of the verifier lifetime check to `test/fixtures/atx-lifetime/`:
identical except their issue time, and expired on any clock after
2026-05-24, so neither verifies in a run.

## Issuer trust section (`issuer/trust.json`)

One trusted issuer and one public key, `keyId`
`did:opena2a:authority:partner.example#key-1`, `publicKeyHex`
`2043fa51c3d9e4a21a535ccb38bdc4fb56083737d22059d69475e7e43c47f582`, copied from
the same vector. No private key material of any kind is in this repository.

## Delegation chain cases (`delegation-chain/`)

The cases the bank's broker checks an Agent Delegation Chain of
draft-asor-wimse-agent-delegation-chain-03 against, in the fixture layout of
aap-conformance: a valid chain of two hops and variants of it, each with the
outcome the draft's Table 2 names. `delegation-chain/README.md` describes
them. Their keys are made by `scripts/delegation-chain/generate-fixtures.mjs`
when it runs; the files carry public keys and signed tokens.

## Keys made at run time

The broker's token signing key, the audit log signing key, the broker token, the token service's access tokens and the password for the password path are made fresh for every run, inside a run directory outside this checkout, and deleted when the run stops. None is ever committed.
