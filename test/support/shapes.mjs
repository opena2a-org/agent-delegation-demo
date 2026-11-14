// The shape each test file runs in, by its path under test/ without
// .test.mjs. Every tracked test file has exactly one row, and
// test/test-shapes.test.mjs holds each row to what the file imports.
//
//   launcher  The file starts children under their own profiles, or starts a
//             process that does. A process inside a profile cannot apply a
//             different one, so the file runs outside every profile. Its
//             import closure holds node: built-ins and the demo's own files,
//             never a package from node_modules, and every process it starts
//             that runs the demo's code or a package does so under exactly
//             one profile with the boundary's terms.
//   outer     The file imports the demo's code or a package and starts no
//             child under a profile of its own. Its leading import is
//             ./support/outer-profile.mjs, which runs the file under one
//             outer profile with the boundary's terms, the test harness's
//             profile, with no different profile applied below it.
//   plain     The file imports neither the demo's code nor a package, and
//             runs outside every profile.

export const SHAPES = Object.freeze({
  'aap-verifier-arms': 'launcher',
  api: 'launcher',
  'bank-model': 'outer',
  'broker-isolation': 'launcher',
  'build-info': 'outer',
  'capture/walkthrough-capture': 'launcher',
  'copied-credential': 'launcher',
  'copy-lint': 'outer',
  'credential-lifetime': 'outer',
  'delegation-chain': 'outer',
  'egress-classify': 'launcher',
  'fictional-line': 'outer',
  'install-census': 'plain',
  'install-playwright-ffmpeg': 'outer',
  k17: 'launcher',
  'launcher-boundary': 'plain',
  'launcher-counter': 'launcher',
  'launcher-profiles': 'launcher',
  launcher: 'launcher',
  'mission-payment-api': 'outer',
  'mission-rules': 'outer',
  'offline-compare': 'launcher',
  'offline-deny-form-stop': 'launcher',
  'offline-not-run': 'launcher',
  'offline-open-run-short': 'launcher',
  'offline-open-run-throws': 'launcher',
  'offline-rules': 'launcher',
  'offline-run-as-usual': 'outer',
  'offline-started': 'launcher',
  'offline-state-words': 'outer',
  'offline-words': 'outer',
  offline: 'launcher',
  'page-cell': 'launcher',
  'page-words': 'plain',
  'path-a': 'launcher',
  'path-b': 'launcher',
  'profile-terms': 'launcher',
  profiles: 'launcher',
  readme: 'outer',
  records: 'launcher',
  repository: 'plain',
  'run-dir': 'launcher',
  'sandbox-witness': 'launcher',
  scenarios: 'launcher',
  'seeded-control': 'plain',
  'stand-in-profile': 'launcher',
  'test-script': 'plain',
  'test-shapes': 'plain',
  'token-service': 'launcher',
  vendoring: 'plain',
  'view-offline-states': 'launcher',
  'view-pages': 'launcher',
  'view-proof': 'launcher',
  'view-server': 'outer',
  'view-teardown': 'plain',
  // A launcher by function: the script it starts starts the demo's parts under
  // their profiles, so that script runs outside every profile. That process
  // also loads playwright-core and drives the browser, which the launcher shape
  // above does not allow. The import census reads this file's imports and
  // not that process's.
  'walkthrough-capture': 'launcher',
  'walkthrough-script': 'outer',
  'words-paired-with-facts': 'outer',
});

export function shapeOf(name) {
  return Object.hasOwn(SHAPES, name) ? SHAPES[name] : null;
}
