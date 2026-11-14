# Delegation chain fixtures

Every customer, account, payee and payment in this demo is fictional. Account
identifiers carry a DEMO marker and every domain ends in `.test`.

Each file is one case of an Agent Delegation Chain as
[draft-asor-wimse-agent-delegation-chain-03](https://datatracker.ietf.org/doc/html/draft-asor-wimse-agent-delegation-chain-03)
defines it: a chain `DT_0 ... DT_n` of compact JWS tokens, the verifier state
to check it under, and the outcome a verifier holding the chain and no request
must reach. `dc-compact-valid-two-hop.json` is a valid chain of two hops; each
other file changes that chain in one place and names the outcome of the draft's
Table 2 a verifier must give, at the step of its section 6 where the change is
caught.

## Layout

The fields follow the fixture layout of aap-conformance:

| Field | Value |
|---|---|
| `name` | `draft-asor-wimse-agent-delegation-chain-03/<file name>` |
| `fixtureType` | `dc`, a delegation chain |
| `tokenForm` | `compact` |
| `spec` | the draft sections the case exercises |
| `verifierState` | `clockNumericDate`, the clock in seconds; `acceptedAlgorithms`, the verifier's local list of step 1; `keys`, the trusted root keys, each with its `kid`, the `alg` the verifier configures for it and its public JWK |
| `chain` | the tokens, `DT_0` at index 0 |
| `expected` | `verifyResult` `ACCEPT` or `REJECT`; for `REJECT`, `rejectCategory` (a Table 2 name), `step` (`parse` or a step number of section 6) and `index` (the token where the check fails); for `ACCEPT`, `stepsNotPerformed`, `[6, 8]`, and `unknownConstraintTypes` where the leaf carries a constraint type no verifier here implements |

`ACCEPT` means the chain is valid under steps 1 to 5 and 7. Steps 6 and 8 need
the request, so a verifier that holds the chain alone does not run them, and
section 6.1 of the draft says it must not report the chain as authorizing an
action.

## What the cases take as given

The draft's text leaves these to an implementation; the cases take them as
`src/bank/delegation-chain.mjs` does:

- Step 1 names the key `DT_0` verifies under, a trusted root key, and names no
  key for a child. Here a child `DT_i` is signed by the holder of `DT_{i-1}`: its
  protected header carries the signing key as `jwk`, and that key's RFC 7638
  thumbprint must equal `DT_{i-1}.cnf.jkt`.
- Every token carries `del_max_depth`, so no case depends on what a child that
  omits it means.
- No token carries a `status` claim.

## Keys

`scripts/delegation-chain/generate-fixtures.mjs` writes every file here from
`scripts/delegation-chain/cases.mjs`. Each run makes a new Ed25519 key pair
for the root and for each agent, signs the tokens, and keeps the private keys
in its own process; the files carry public keys and signed tokens, so a new
run writes new bytes with the same outcomes. No private key is committed.

## Check

`node --test test/delegation-chain.test.mjs` checks every file here with the
bank's broker, and checks the same cases minted again under new keys.
`node scripts/delegation-chain/verify.mjs fixtures/delegation-chain/*.json`
prints the broker's result for each file next to the expected one.
