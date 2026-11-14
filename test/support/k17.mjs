// K17, read from one broker in one run: the status of an authenticated
// POST /grant {} on the broker's Unix socket and on its TCP port.
//   - The socket answers 400: the grant route is wired and refuses an empty
//     request. A broker built without its grant resolver answers 404 on both,
//     so a TCP value is read together with socket 400 and never alone.
//   - The TCP port answers 400 while the pinned broker's TCP listener shares
//     the socket's handler and routes /grant, and 404 once the pin serves
//     grants on the socket alone. While it answers 400, no line says the
//     broker serves grants on its socket alone.

import http from 'node:http';

// The TCP value recorded for each pinned broker commit, after reading it.
export const K17_TCP_AT_PIN = Object.freeze({
  '0b25f7451f41482d247148347cdd242aa02770a4': 400,
});

export function k17Problems({ socket, tcp }, pinCommit, recorded = K17_TCP_AT_PIN) {
  const problems = [];
  if (socket !== 400) problems.push(`socket ${socket}: an authenticated empty grant request must read 400 on the socket; a broker without its grant resolver reads 404`);
  const expected = Object.hasOwn(recorded, pinCommit) ? recorded[pinCommit] : undefined;
  if (expected === undefined) problems.push(`no TCP value is recorded for the pinned commit ${String(pinCommit).slice(0, 12)}: read it, then record it`);
  else if (tcp !== expected) problems.push(`tcp ${tcp}: ${expected} is recorded for this pin`);
  return problems;
}

export const k17Line = ({ socket, tcp }) => `K17 socket ${socket} tcp ${tcp}`;

// One authenticated POST /grant with the body {}, over a Unix socket or a
// loopback TCP port. null when no answer came.
export function postGrant({ socketPath = null, port = null, token }) {
  const body = '{}';
  const target = socketPath ? { socketPath } : { host: '127.0.0.1', port };
  return new Promise((resolve) => {
    const req = http.request({
      ...target,
      path: '/grant',
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}
