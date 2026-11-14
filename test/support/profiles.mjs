// Profile texts the tests write for sandbox-exec. Each carries the
// boundary's terms: exec refused for the keychain tool, and reads and writes
// refused on the credential store paths under the real home directory, the
// one the password database records. The tests give their children a HOME of
// their own, so a term built from HOME would refuse the wrong path.
//
// A file profile is written with writeProfile, and a -p string goes through
// resolveProfilePaths, so every path in it is the path the kernel matches.

import { KEYCHAIN_TOOL, protectedPaths, realHome } from '../../src/orchestrator/sandbox.mjs';

// Two lines, each ending in a newline. The store paths sit in one rule, so
// deniesReadWrite matches each of them.
export function storeTerms() {
  const paths = protectedPaths({ home: realHome() }).map((p) => `(subpath "${p}")`).join(' ');
  return `(deny process-exec (literal "${KEYCHAIN_TOOL}"))\n(deny file-read* file-write* ${paths})\n`;
}

// A test's own profile: everything allowed, the test's own lines, then the
// boundary's terms. It adds no network term and no sentinel.
export function outerProfileText(lines) {
  return `(version 1)\n(allow default)\n${lines.join('\n')}\n${storeTerms()}`;
}

// The page cell's profile: outbound network to localhost alone, then the
// boundary's terms.
export function pageCellProfile() {
  return `(version 1)\n(allow default)\n(deny network-outbound (remote ip "*:*"))\n(allow network-outbound (remote ip "localhost:*"))\n${storeTerms()}`;
}
