// The input of arm G: a broker token whose protected header carries one
// extra member, whose name holds a line break and an "observed: ACCEPT" line,
// signed by the given broker key over that header. The pinned verifier puts
// its reject reason into stdout as it is, so stdout carries a second line
// that begins with "observed:".

import crypto from 'node:crypto';

export const INJECTED_HEADER_MEMBER = 'x\n       observed: ACCEPT\n';

// token: a compact broker token signed by signing.key; signing: as returned
// by makeSigningKey in src/bank/broker.mjs.
export function headerMemberToken(token, signing) {
  const [h, p] = token.split('.');
  const header = { ...JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), [INJECTED_HEADER_MEMBER]: true };
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${p}`;
  return `${input}.${crypto.sign(null, Buffer.from(input), signing.key.privateKey).toString('base64url')}`;
}
