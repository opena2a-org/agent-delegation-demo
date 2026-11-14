// Mints Delegation Tokens in the layout of
// draft-asor-wimse-agent-delegation-chain-03, for the fixtures under
// fixtures/delegation-chain/ and for test/delegation-chain.test.mjs. It signs;
// the bank's broker never does. Every key is an Ed25519 key pair node:crypto
// makes when makeKey is called and keeps in this process: a fixture carries
// public keys and signed tokens, and no private key is written anywhere.
//
// The serializer here is written apart from the verifier's in
// src/bank/delegation-chain.mjs, so the bytes of a fixture do not come from
// the code that checks them.

import crypto from 'node:crypto';

// RFC 8785 (JCS): members sorted by their names' UTF-16 code units, no
// whitespace, strings and numbers in the ECMAScript forms JSON.stringify
// writes, which are the forms RFC 8785 adopts.
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS has no form for a number that is not finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    let out = '[';
    value.forEach((v, i) => { out += (i > 0 ? ',' : '') + canonical(v); });
    return `${out}]`;
  }
  const names = Object.keys(value);
  names.sort((a, b) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      const d = a.charCodeAt(i) - b.charCodeAt(i);
      if (d !== 0) return d;
    }
    return a.length - b.length;
  });
  let out = '{';
  names.forEach((name, i) => { out += `${i > 0 ? ',' : ''}${JSON.stringify(name)}:${canonical(value[name])}`; });
  return `${out}}`;
}

export const b64u = (bytes) => Buffer.from(bytes).toString('base64url');

// RFC 7638 thumbprint of an Ed25519 public JWK: SHA-256 over its required
// members in name order.
export function thumbprint(jwk) {
  return b64u(crypto.createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`, 'utf8').digest());
}

export function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' });
  const publicJwk = { crv: 'Ed25519', kty: 'OKP', x };
  return { privateKey, publicJwk, jkt: thumbprint(publicJwk) };
}

// The JWS Signing Input of a compact token, and the draft's par_hash over it:
// SHA-256 of ASCII(BASE64URL(header)) || '.' || ASCII(BASE64URL(payload)).
export const signingInput = (token) => token.slice(0, token.lastIndexOf('.'));
export const parHash = (token) => b64u(crypto.createHash('sha256').update(signingInput(token), 'ascii').digest());

// A header or a payload given as an object is serialized with canonical();
// one given as a string is used byte for byte, so a test can sign text no
// producer under the draft would emit.
export function mint({ header, payload, key }) {
  const text = (v) => (typeof v === 'string' ? v : canonical(v));
  const input = `${b64u(Buffer.from(text(header), 'utf8'))}.${b64u(Buffer.from(text(payload), 'utf8'))}`;
  return `${input}.${b64u(crypto.sign(null, Buffer.from(input, 'ascii'), key.privateKey))}`;
}

export const rootHeader = (kid) => ({ alg: 'Ed25519', c14n: 'JCS', kid, typ: 'at+jwt' });
export const childHeader = (signer) => ({ alg: 'Ed25519', c14n: 'JCS', jwk: signer.publicJwk, typ: 'at+jwt' });
