# agent-delegation-demo

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

> **[OpenA2A](https://github.com/opena2a-org)**: [CLI](https://github.com/opena2a-org/opena2a) · [HackMyAgent](https://github.com/opena2a-org/hackmyagent) · [Secretless](https://github.com/opena2a-org/secretless-ai) · [AIM](https://github.com/opena2a-org/agent-identity-management) · [Browser Guard](https://github.com/opena2a-org/ai-browserguard) · [DVAA](https://github.com/opena2a-org/damn-vulnerable-ai-agent)

[Website](https://opena2a.org) · [Demos](https://opena2a.org/demos) · [Discord](https://discord.gg/uRZa3KXgEn)

This mock bank runs one agent two ways: with the password, and with a grant the bank checks on every payment.

- **Path A: shared password.** The customer gives the agent their username and password. The agent signs in as the customer.
- **Path B: delegated grant.** The customer approves a grant at the bank. The agent shows its own credential, and the bank checks each payment against the customer's limits.

## Run it yourself

Requirements: macOS, git, Node.js 22.12.0 or later and a browser. Checked on macOS 26.6.2 arm64 with Node.js 26.12.1 in Chrome 156.0.8078.48, 2026-10-24.

```sh
git clone https://github.com/opena2a-org/agent-delegation-demo
cd agent-delegation-demo
npm ci
npm start
```

What `npm start` prints (captured from agent-banking-delegation-demo at commit 2db40bb, 2026-10-30, on the scripted Example Bank fixture):

```text

> agent-banking-delegation-demo@0.1.0 start
> node bin/start.mjs

Agent banking delegation demo, build 2db40bb
Ready. Open http://127.0.0.1:7380/ in a browser.
Press Ctrl+C to stop.
```

The repository's `.npmrc` tells npm commands run in this directory to refuse a Node.js older than 22.12.0, to skip every package's install scripts and to leave out optional dependencies.

## The walkthrough

Every demo screen shown here was captured from this repository at commit [2db40bb](https://github.com/opena2a-org/agent-delegation-demo/commit/2db40bbca4a8c83267bcfc4e7a56fcc4e0f67282), 2026-10-30, on the scripted Example Bank fixture. The footer of each screen shows the same build.

![Same agent, same bills, two ways into the bank. This mock bank runs one agent two ways: with the password, and with a grant the bank checks on every payment.](docs/captures/00-overview.png)

Captured on 2026-10-30 from agent-banking-delegation-demo at commit 2db40bb against the scripted Example Bank fixture.

![With a grant, the bank blocks an unapproved payee. Path A: Paid the fake invoice. Path B: Payment blocked.](docs/captures/03-scenario-2-fake-invoice.png)

Captured on 2026-10-30 from agent-banking-delegation-demo at commit 2db40bb against the scripted Example Bank fixture.

![With a grant, the bank's record names the agent. Path A: No agent on record. Path B: Agent on record.](docs/captures/05-scenario-4-dispute.png)

Captured on 2026-10-30 from agent-banking-delegation-demo at commit 2db40bb against the scripted Example Bank fixture.

![Fake invoice chapter of the agent-banking-delegation-demo walkthrough, recorded at commit 2db40bb, 2026-10-30. With the password the fake invoice is paid; with the grant the bank refuses the unapproved payee.](docs/captures/walkthrough-fake-invoice.gif)

Recorded on 2026-10-30 from agent-banking-delegation-demo at commit 2db40bb against the scripted Example Bank fixture; the Fake invoice chapter of the walkthrough; waits shortened.

All nine screens, each with its caption: [docs/walkthrough.md](docs/walkthrough.md).

## The scenarios

### Setup: The bank sees the customer, or it sees the agent

With the password, the bank sees the customer. With the grant, it sees the agent and holds it to the customer's limits.

### Scenario 1 of 4: A normal bill gets paid either way

A normal water bill gets paid both ways, and the grant adds no step for the customer.

### Scenario 2 of 4: With a grant, the bank blocks an unapproved payee

Next, an invoice carries a hidden instruction, scripted for this demo, to pay a different account. With the password, the money goes. With the grant, the bank refuses, because that account isn't an approved payee.

### Scenario 3 of 4: With a grant, the bank stops one agent, not all

Now the customer wants the bill pay agent gone. A new password signs out both agents and the customer. With the grant, the bank revokes that one agent, and everything else keeps working.

### Scenario 4 of 4: With a grant, the bank's record names the agent

Then the customer disputes the water payment. The password leaves a login; the grant leaves a signed record naming the agent.

### Offline check: With OpenA2A unreachable, the bank still decides

Last, every OpenA2A service is blocked. The bank still makes the same four decisions, with no outbound connections.

The offline check runs the four grant path scenarios again inside a macOS sandbox profile that refuses every connection except those between the demo's own processes on this machine. Each demo process loads a counter that records every socket call before the call is made, and the screen shows the rerun's count. At the end of the rerun, two control connections run: one to 192.0.2.1, an address reserved for documentation (RFC 5737), and one to this machine's own network address, which must answer outside the sandbox immediately before the rerun. Each must be refused inside the sandbox and counted once. Otherwise the screen reads not measured and shows no number, as it also does when a process loads a native module or runs without the counter. The count covers the demo's own processes, not the browser or the page. The sentence about the password path appears when the same counter recorded no outbound attempt during the scenario runs, and is left out otherwise. Measured on macOS 26.6.2 arm64 at commit dd954b9, 2026-10-24; the sandbox profile is written for each run by `src/orchestrator/sandbox.mjs`, and the one written for that run has sha256 `8cf3a5b64c3b25c9f028ad605f3e21c75b6c30a637a2b63c90ad703f4c52f2ff`. Without the macOS sandbox, or when the demo already runs inside another sandbox, the check does not run, and the screen says why.

## Architecture

The Path B agent is given four things, in a directory of its own: its ATX credential, the grant name, the path of the broker's Unix socket, and a copy of the broker token (`broker.token`), the bearer value every request to the bank's broker carries in its `Authorization` header. The broker makes a new token at every start and every agent the bank connects gets the same one, so the token names no agent; the reference implementation doesn't authenticate each agent to the broker separately. On its own the token opens the broker's health and status routes and nothing that acts on an account. The agent is never given the customer's password, a token the bank's token service issues, or the short lived token the broker signs.

The bank's broker is an unreleased local build of the AAP reference implementation from `secretless-ai` at commit `0b25f7451f41482d247148347cdd242aa02770a4`: npm does not serve these bytes, and they carry no provenance attestation. [`vendor/VENDORED.md`](vendor/VENDORED.md) gives the commands that rebuild them.

The bank's token service checks the broker's token with the reference Node.js verifier from aap-conformance at commit `a4ab3d9e27bf1a0a3edd8029e0cfca5e0549d078`. The bank accepts a token when the verifier exits 0, prints `observed: ACCEPT` and reports one fixture passed. `vendor/VENDORED.md` names the copied file, its sha256 and its license; the copy is unmodified, and fixes go to aap-conformance.

The bank, its broker and the agents run as one user on one machine. File permissions keep other users of the machine out of the run's directories and away from the broker token, but they don't separate these processes from each other; on their own, they would let an agent read the bank's files. On macOS with `/usr/bin/sandbox-exec`, every scenario run, from `npm start`, `npm run scenarios` or the test suite, also runs the bank and each agent under its own sandbox profile, except the offline check's rerun, which runs every process under one shared profile. The grant path agent's profile refuses every TCP connection the agent opens and every read of the bank's directory, and the test suite checks both refusals in the same run. The agent reaches the broker over the Unix socket, with its own copy of the broker token. These refusals come from that profile, not from the socket, so they don't apply in the rerun. The password path agent's profile doesn't refuse reads of the bank's directory.

## Check each screen yourself

The stills and the recording are taken by `docs/demo/walkthrough.demo.mjs`, which starts the demo with `npm start`, drives it in Chrome with real clicks and writes a proof for each still. The proofs of stills 00 to 05 check the bank's state, read from the demo's API before and after the step, and those of 04 and 05 also check the run's records. The proof of 06 checks the offline check's result. The proof of 07 checks the page's contact address, and the proofs of 07 and 08 compare the page's text with the copy file the demo serves. To take the stills again from a clean clone, with no other `npm start` running:

```sh
node docs/demo/walkthrough.demo.mjs --stills --records <a directory outside the clone>
```

It rewrites the stills and the `npm start` capture under `docs/captures/` and writes each still's record and proof to `captures/` under the directory given. Each proof lists what was asserted and whether it held. The run exits 1 when an assertion fails, when the page makes a request that leaves 127.0.0.1, or when a file is over its size limit; it then keeps no output file, and `docs/captures/` and the directory given stay as they were. Ctrl+C stops the demo the run started, removes the run's own temporary directory and exits 130.

`--record` in place of `--stills` takes the recording. It needs `ffmpeg` and `ffprobe` on `PATH`, which encode the recording, and Playwright's own ffmpeg build, which records the browser, in the Playwright cache or in the directory `PLAYWRIGHT_BROWSERS_PATH` names. An `ffmpeg` on `PATH` does not stand in for Playwright's build. From the clone:

```sh
node scripts/install-playwright-ffmpeg.mjs
node docs/demo/walkthrough.demo.mjs --record --records <a directory outside the clone>
```

The install script fetches the build `npx playwright-core install ffmpeg` fetches, from the addresses the installed `playwright-core` names; on Node.js 26.12.1 that command stops partway through unpacking the archive and does not return. The script checks each file it unpacks against the archive's listing and puts the build in place when it exits 0 with `-version`. It writes in the Playwright cache, or under `PLAYWRIGHT_BROWSERS_PATH`, and nowhere else. Before it starts the demo, `--record` checks for the three and runs Playwright's build with `-version`. When one is missing, or the build does not exit 0, it prints the path or the name it looked for and exits 1 without writing or removing a file.

## Talk to us about an agent channel

If you run security at a bank, credit union or aggregator, email info@opena2a.org with "agent channel" in the subject. We'll walk you through the delegated flow against your own requirements. No pitch deck.

## Where this demo stands

- Example Bank is a mock bank. No real bank, account or credential is used.

- The agents and the scenarios are scripted, including the hidden line in scenario 2, so every run produces the same outcomes.

- This mock bank runs no one time code or device check on the password path.

- The consent record's field names are adapted from UK Open Banking variable recurring payment consents. It isn't an implementation of that standard.

- Your payees and limits live in the bank's consent record. AAP doesn't yet define a payee list or per payment and monthly amount limits.

  - [AAP, Section 4.1, Authorization Details](https://datatracker.ietf.org/doc/html/draft-fane-opena2a-aap-02#section-4.1)

  As in UK Open Banking variable recurring payment consents, the bank holds the per payment and per period limits and checks every payment against them.

  - [Domestic VRP consents - v4.0](https://openbankinguk.github.io/read-write-api-site3/v4.0/resources-and-data-models/vrp/domestic-vrp-consents.html)
  - [Domestic VRPS - v4.0](https://openbankinguk.github.io/read-write-api-site3/v4.0/resources-and-data-models/vrp/domestic-vrps.html)

- Your consent at the bank names the agent. The agent gets a grant name and a shared broker token that can't act alone, never your password or account token.

- This check is the demo bank's own code and policy, not the reference implementation.

- The bank's broker signs a short lived token naming the agent, the bank service and the consent; payees and limits stay in the bank's records.

  - [`AAP-BROKER-PROFILE.md`, Section 14, Implementation status](https://github.com/opena2a-standards/agent-authorization-protocol/blob/61ee86a0534204c857bfe826a6b7d5643ecacef3/AAP-BROKER-PROFILE.md#14-reference-implementation-informative)

- The bank's token service checks the broker's token with the reference Node.js verifier from aap-conformance at commit a4ab3d9e27bf.

- Test issuer, published key: agent credentials prove nothing outside this demo.

  Agent credentials are signed by a test issuer, `did:opena2a:authority:partner.example`, named under the reserved `.example` domain (RFC 2606). Its signing key is published with the `atx-conformance` test vectors, so anyone can sign a credential that passes this demo's check, and the credentials prove nothing outside this demo. The issuer is a test fixture, not an authority OpenA2A runs. The bank's broker trusts this one issuer and this one key; `fixtures/README.md` names the vector and its commit.

- Post quantum signatures are not verified in this demo (atx-verify 0.3.0).

- Bearer credential: a copy with the grant name is accepted as this agent. Proof of possession is specified in AAP, not yet in the reference implementation.

  In a deployment that follows ATX, the agent's credential is public by design: the ATX specification puts it in a header of each request the agent makes, in its A2A agent card and in its MCP server manifest, so getting a copy takes no access to the agent's machine. The bank's record names whose credential was used, not who used it.

  - [AAP, Section 4.3, Proof of Possession](https://datatracker.ietf.org/doc/html/draft-fane-opena2a-aap-02#section-4.3)
  - [AAP, Section 8.6, Presentation Is Not Possession](https://datatracker.ietf.org/doc/html/draft-fane-opena2a-aap-02#section-8.6)
  - [ATX, the Presentation row](https://github.com/opena2a-standards/atx-spec/blob/da5d2c9226863e962a47fcfab617bd5ca0246ad9/core.md#12-atx-lifecycle) and [the stolen credentials paragraph](https://github.com/opena2a-standards/atx-spec/blob/da5d2c9226863e962a47fcfab617bd5ca0246ad9/core.md#13-security-considerations)

  The reference verifier rejects an agent credential after its `expiresAt` time and checks nothing else about its age: it doesn't yet apply ATX's seven day limit from `issuedAt`, and it doesn't reject a credential dated in the future. This demo's agent credentials are long lived test fixtures, issued on 2026-05-23 with an `expiresAt` of 2099-12-31, so a verifier that applies ATX's limit rejects them as expired. A payment made with a copy is still checked against the customer's consent, its payees, limits and end date, and is refused once the consent is withdrawn.

  - [ATX, Section 1.3, Local verification algorithm, step 2](https://github.com/opena2a-standards/atx-spec/blob/da5d2c9226863e962a47fcfab617bd5ca0246ad9/core.md#13-local-verification-algorithm)

- Revoking withdrew your consent for this agent; your login and other agents are untouched. AAP's grant revocation list isn't in the reference implementation yet.

  - [AAP, Section 7.1, Revocation Propagation](https://datatracker.ietf.org/doc/html/draft-fane-opena2a-aap-02#section-7.1)

- The bank restarted its broker to remove this agent's grant; reloading without a restart isn't yet in the reference implementation.

  - [secretless-ai `src/broker/grant-config.ts`, lines 23 to 24](https://github.com/opena2a-org/secretless-ai/blob/0b25f7451f41482d247148347cdd242aa02770a4/src/broker/grant-config.ts#L23-L24)

- Signed with the bank broker's key for this run, the broker record isn't evidence against the bank. Payee, amount and bank decision come from the bank's ledger.

  The broker record is signed with a key the bank's broker creates for this run. The dispute view checks the record against the public key the bank captured when its broker started, never against the key file stored beside the log. Because the bank holds the signing key, a valid signature shows that no one without that key changed the record; it isn't evidence against the bank itself. The check also can't detect records cut from the end of the log.

- AAP is an Internet Draft, not a finished standard.

- The bank's broker is an unreleased local build of the AAP reference implementation from secretless-ai at commit 0b25f7451f41, with no provenance attestation. It answers grant requests on a local TCP port as well as on its Unix socket.

  The bank's broker opens that port on 127.0.0.1 with a number the operating system picks and gives the number to no other process, and the agent's broker client takes a socket path and no host or port. A process running as the same user can still find the port and, with the broker token, send it grant requests. The test suite sends a grant request carrying the broker token to that port on every run and records the answer.

  To admit a caller, the broker checks one thing, on its Unix socket as on its local TCP port: the broker token. File permissions let every process running as the operating system user that runs the demo read the broker token, and keep other users of the machine from reading it. AAP's socket presentation binding, which identifies the calling process by its operating system credentials, isn't yet in the reference implementation, so the broker can't tell the agent from another process of that user.

  - [`AAP-BROKER-PROFILE.md`, Section 6.8, Presentation binding](https://github.com/opena2a-standards/agent-authorization-protocol/blob/61ee86a0534204c857bfe826a6b7d5643ecacef3/AAP-BROKER-PROFILE.md#68-presentation-binding)
  - [`AAP-BROKER-PROFILE.md`, Section 14, Implementation status, the presentation binding step](https://github.com/opena2a-standards/agent-authorization-protocol/blob/61ee86a0534204c857bfe826a6b7d5643ecacef3/AAP-BROKER-PROFILE.md#14-reference-implementation-informative)

- This demo is not a security assessment of any real institution.
