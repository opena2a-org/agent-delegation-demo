# Run the demo

Everything runs on this machine: a fictional bank (Example Bank) with its
broker, token service and payment API, two agents on each path, and a view
server on `127.0.0.1`. No request goes to a real bank.

## Prerequisites

| Tool | Measured with | Notes |
|---|---|---|
| macOS | 26.6.2 arm64 | The sandbox profiles and the offline check use `/usr/bin/sandbox-exec`. Measured on macOS alone. |
| Node.js | 26.12.0 and 24.22.1 | `npm start` refuses a version before 22.12.0. |
| npm | 11.20.0 (with Node.js 26.12.0) and 11.19.1 (with Node.js 24.22.1) | |
| git | 2.53.0 | |

`npm ci` installs the versions and integrity hashes in `package-lock.json`:
secretless-ai from the tarball under `vendor/`, and the other packages from
the npm registry. Install scripts and optional packages are turned off in
`.npmrc`.

## Start

```sh
git clone https://github.com/opena2a-org/agent-delegation-demo.git && cd agent-delegation-demo && npm ci && npm start
```

When the bank and the agents are ready, `npm start` prints:

```
Agent banking delegation demo, build <commit>
Ready. Open http://127.0.0.1:7380/ in a browser.
Press Ctrl+C to stop.
```

Stop it with Ctrl+C. To use another port, run `PORT=7381 npm start`.

## The scenarios as text, and the tests

```sh
npm run scenarios
npm test
```

`npm run scenarios` prints each scenario on both paths side by side. The
offline check is not part of it; the demo that `npm start` starts runs it.
`npm test` runs the whole suite; the tests that need the sandbox do not pass
without `/usr/bin/sandbox-exec`.
