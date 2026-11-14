# Mission-Bound Authorization: vectors and fixtures

This directory holds the bank demo's evidence for
[draft-mcguinness-oauth-mission-02](https://datatracker.ietf.org/doc/html/draft-mcguinness-oauth-mission-02):
the six integrity anchor vectors of its Appendix D, reproduced in Go and in
Python, and fixtures for the bank's payment API and for its derivation rule.
The bank's rules are in `src/bank/mission.mjs`. The fixtures are evidence
from a second implementation; their home and their mapping to the draft
author's requirement IDs are not decided.

## Run the checks

```sh
cd conformance/mission/go && GOTOOLCHAIN=local go test -count=1 -v ./...
python3 -B -I -m unittest discover -v -s conformance/mission/python -t conformance/mission/python
node --test --test-concurrency=1 test/mission-rules.test.mjs test/mission-payment-api.test.mjs
```

The Go and Python checks use their standard libraries and nothing else. The
two Node.js files run inside `npm test` with the rest of the suite.

## What is here

| Path | What it holds |
|---|---|
| `vectors/appendix-d-integrity-anchors.json` | The six Appendix D vectors: the value the draft displays, and the canonical bytes and anchor it prints. Also the parse-time refusals of Section 6.3.3 and an unknown algorithm prefix. |
| `vectors/jcs-number-serialization.json` | ECMAScript number forms, as Node.js printed them, for doubles the vectors do not reach (RFC 8785 Section 3.2.2.3). |
| `go/`, `python/` | The anchor construction of Section 6.3.1 and its checks. |
| `fixtures/` | 66 fixtures: 36 for the payment API, 30 for the derivation rule. |
| `MANIFEST.sha256` | The sha256 of every fixture file. |
| `schemas/mission-fixture-v1.schema.json` | The fixture layout. |
| `conformance.json` | The draft revision, the companion commit, the implementations, and what the fixtures do not cover. |

## Fixture layout

Each fixture follows the layout of the atx-conformance fixtures: `name`,
`description`, `requirement`, `spec`, `keypairRefs` (empty: no key is
involved), `verifierState`, `expected`, and the object under test.

- A payment API fixture (`request`) carries the access token record the
  payment API redeems and the HTTP operation. The test serves the payment API
  on 127.0.0.1, gives the bank a consent that allows the payment, and holds
  the response to `expected`: the status, the `WWW-Authenticate` value of a
  refusal, the category and reason the bank records, and no ledger row for a
  refusal.
- A derivation fixture (`derivation`) carries the requested
  `authorization_details`. The test holds the decision of `deriveUnderMission`
  in `src/bank/mission.mjs` to `expected`: derived, or refused with its OAuth
  error and category. The bank's token service does not call
  `deriveUnderMission`.

## The rules the fixtures hold

| Case | Payment API answer |
|---|---|
| The Mission is revoked, expired (stored, or the decision time at or after `expires_at`), unknown, or in a state other than `active` | 401, `Bearer error="invalid_token"` |
| The Mission issuer is not the bank, or is not the token's `iss`; the payment API is not in `aud` | 401, `Bearer error="invalid_token"` |
| The `mission` member is not an object with a string `id` and a string `issuer`, or the Mission record has no valid RFC 3339 `expires_at` (a day its month does not have included) | 401, `Bearer error="invalid_token"` |
| No single carried entry authorizes the whole request | 403, `Bearer error="insufficient_scope", mission_denial="insufficient_authority"` |
| An applicable entry carries a member or constraint the bank cannot enforce, and no other entry authorizes the request | 403, `Bearer error="insufficient_scope", mission_denial="constraint_unrecognized"` |
| The payment API has no Mission records to resolve against | 503, and the token is not reported invalid |

A refusal's reason stays in the bank's records. A token without a `mission`
member is decided as before, by the consent check alone, and the consent
check runs after the Mission rules admit a request.

The derivation rule is `deriveUnderMission` in `src/bank/mission.mjs`, which
the bank's token service does not call: the derivation fixtures hold the rule
itself. Under it, a derivation under a Mission that is not active is refused
with `invalid_request`, and a requested entry that is not a subset of an
Authority Set entry with `invalid_authorization_details` (Sections 5.4 and
11). For `mission_resource_access` the subset relation is the one
draft-mcguinness-oauth-mission-resource-access defines; the bank implements
the exact resource match, literal and family actions, `max_amount` in decimal
value space, and `delegation` that is never broader than its parent's.
