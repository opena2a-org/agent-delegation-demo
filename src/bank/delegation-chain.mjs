// The bank broker's check of an Agent Delegation Chain, as
// draft-asor-wimse-agent-delegation-chain-03 defines it. It sits beside the
// AAP grant path in ./broker.mjs and does not replace it: no AAP token, grant
// or Delegation Assertion passes through here. It reads node: built-ins and
// no package, and makes no network call.
//
// What it runs on a chain DT_0 ... DT_n presented without a request (the
// draft's section 6.1): the parse rules of sections 3, 4, 4.1, 4.2 and 4.4 on
// every token, then steps 1 to 5 and 7 of section 6, denying at the earliest
// failure under the outcome names of Table 2. Steps 6 and 8 need the request;
// they are not run, every result says so, and no result reports the chain as
// authorizing an action.
//
// Choices the draft's text leaves to an implementation, made here and held by
// test/delegation-chain.test.mjs:
//   - Step 1 names the key DT_0 verifies under (a trusted root key) and no
//     key for a child. A child DT_i verifies here under the key its protected
//     header carries as "jwk", which must be the key whose RFC 7638
//     thumbprint DT_{i-1}.cnf names in "jkt": the holder of the parent signs
//     the child. The algorithm configured for an Ed25519 key is Ed25519.
//   - The parse checks of one token run in this order: three base64url
//     parts; then, for the protected header and then for the payload, UTF-8,
//     one pass over its JSON text that stops at the earliest of a syntax error
//     (malformed), a repeated member name (duplicate_member), a number that is
//     not finite in binary64 (non_finite), a number whose magnitude exceeds
//     2^53-1 by value (malformed) and a lone UTF-16 surrogate (malformed), and
//     the JCS check of its bytes (non_canonical); then the shape of every
//     member (malformed). Every token of the chain is parsed before step 1
//     runs, and each step runs over the whole chain before the next.
//   - A child that carries no "del_max_depth" holds its parent's value for
//     rule 5. Step 3 bounds the chain by DT_0's value, as the draft writes it.
//   - A constraint object with two or more members beside "key" is malformed
//     unless they are "rank" and its "order", whether or not this verifier
//     implements the types they name.
//   - A token that carries a "status" claim is denied status_unknown at step
//     7: this verifier holds no status list.
//   - "one_of" and "not_one_of" members are compared by their JCS
//     serialization.
// Limits of this verifier, not of the draft: a chain of at most 32 tokens, a
// token of at most 16384 characters, JSON nested at most 32 levels deep.

import crypto from 'node:crypto';

export const DRAFT = 'draft-asor-wimse-agent-delegation-chain-03';

// The outcome names of the draft's Table 2, in its order.
export const OUTCOMES = Object.freeze([
  'malformed', 'non_canonical', 'duplicate_member', 'non_finite', 'signature_invalid', 'par_hash_mismatch',
  'depth_invalid', 'principal_altered', 'not_narrower', 'expired', 'holder_binding_failed', 'revoked',
  'status_unknown', 'audience_mismatch', 'scope_not_granted', 'ceiling_exceeded', 'unknown_constraint',
]);
export const STEPS_PERFORMED = Object.freeze([1, 2, 3, 4, 5, 7]);
export const STEPS_NOT_PERFORMED = Object.freeze([6, 8]);

const LIMITS = Object.freeze({ tokens: 32, tokenChars: 16384, depth: 32 });
const DETAIL_TYPE = 'agent_delegation';
const DETAIL_MEMBERS = new Set(['type', 'scopes', 'constraints']);
const NUMERIC_TYPES = new Set(['max', 'max_lifetime', 'max_subtree', 'min']);
const KNOWN_TYPES = new Set([...NUMERIC_TYPES, 'one_of', 'not_one_of', 'prefix', 'rank']);
const CHILD_KEY_ALG = 'Ed25519';

class Denied extends Error {
  constructor(outcome, step, index, detail) {
    super(detail);
    Object.assign(this, { outcome, step, index, detail });
  }
}
const deny = (outcome, step, index, detail) => { throw new Denied(outcome, step, index, detail); };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, name) => Object.hasOwn(o, name);
const quote = (v) => JSON.stringify(v);

// RFC 8785 (JCS): members sorted by their names' UTF-16 code units, which is
// how the default sort compares strings; strings and numbers as
// JSON.stringify writes them, which are the forms RFC 8785 adopts.
export function jcs(value) {
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JCS has no form for a number that is not finite');
  return JSON.stringify(value);
}

class JsonFault extends Error {
  constructor(outcome, detail) {
    super(detail);
    this.outcome = outcome;
  }
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES = Object.freeze({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' });

// RFC 8259 JSON, read in one pass that refuses what the draft's section 3
// refuses, at the earliest point in the text: a repeated member name, a
// number that is not finite, a number of magnitude above 2^53-1 and a lone
// surrogate. Objects have no prototype, so no member name reaches one.
export function parseStrictJson(text) {
  let i = 0;
  const fault = (outcome, detail) => { throw new JsonFault(outcome, `${detail} (at character ${i})`); };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i += 1; };

  const string = () => {
    i += 1;
    let out = '';
    for (;;) {
      if (i >= text.length) fault('malformed', 'a string is not closed');
      const c = text[i];
      if (c === '"') { i += 1; break; }
      if (c === '\\') {
        const e = text[i + 1];
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fault('malformed', 'a \\u escape is not four hex digits');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (e !== undefined && has(ESCAPES, e)) {
          out += ESCAPES[e];
          i += 2;
        } else {
          fault('malformed', 'an escape JSON does not define');
        }
        continue;
      }
      if (c.charCodeAt(0) < 0x20) fault('malformed', 'a control character is not escaped');
      out += c;
      i += 1;
    }
    if (!out.isWellFormed()) fault('malformed', 'a string holds a lone UTF-16 surrogate');
    return out;
  };

  const number = () => {
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) fault('malformed', 'not a JSON value');
    const v = Number(m[0]);
    if (!Number.isFinite(v)) fault('non_finite', `the number ${m[0]} is not finite in IEEE 754 binary64`);
    if (Math.abs(v) > Number.MAX_SAFE_INTEGER) fault('malformed', `the number ${m[0]} exceeds 2^53-1 in magnitude`);
    i += m[0].length;
    return v;
  };

  const value = (depth) => {
    if (depth > LIMITS.depth) fault('malformed', `JSON nested deeper than ${LIMITS.depth} levels`);
    ws();
    const c = text[i];
    if (c === '{') {
      i += 1;
      const out = Object.create(null);
      const seen = new Set();
      ws();
      if (text[i] === '}') { i += 1; return out; }
      for (;;) {
        ws();
        if (text[i] !== '"') fault('malformed', 'a member name is not a string');
        const name = string();
        if (seen.has(name)) fault('duplicate_member', `the member name ${quote(name)} repeats`);
        seen.add(name);
        ws();
        if (text[i] !== ':') fault('malformed', 'no colon after a member name');
        i += 1;
        out[name] = value(depth + 1);
        ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return out; }
        fault('malformed', 'an object is not closed');
      }
    }
    if (c === '[') {
      i += 1;
      const out = [];
      ws();
      if (text[i] === ']') { i += 1; return out; }
      for (;;) {
        out.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; return out; }
        fault('malformed', 'an array is not closed');
      }
    }
    if (c === '"') return string();
    if (c === '-' || (c >= '0' && c <= '9')) return number();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) { i += word.length; return v; }
    }
    return fault('malformed', 'not a JSON value');
  };

  const out = value(0);
  ws();
  if (i !== text.length) fault('malformed', 'text after the JSON value');
  return out;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
// Unpadded base64url whose characters are the canonical encoding of the bytes.
function base64url(s) {
  if (typeof s !== 'string' || !B64URL.test(s) || s.length % 4 === 1) return null;
  const bytes = Buffer.from(s, 'base64url');
  return bytes.toString('base64url') === s ? bytes : null;
}
const isDigest = (s) => base64url(s)?.length === 32;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeJson(bytes, index, part) {
  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    deny('malformed', 'parse', index, `the ${part} of DT_${index} is not UTF-8`);
  }
  let value;
  try {
    value = parseStrictJson(text);
  } catch (err) {
    if (err instanceof JsonFault) deny(err.outcome, 'parse', index, `the ${part} of DT_${index}: ${err.message}`);
    throw err;
  }
  if (!Buffer.from(jcs(value), 'utf8').equals(bytes)) deny('non_canonical', 'parse', index, `the ${part} of DT_${index} is not the JCS serialization of what it parses to`);
  if (!isObject(value)) deny('malformed', 'parse', index, `the ${part} of DT_${index} is not a JSON object`);
  return value;
}

// Section 4.1: classify a scope by its bytes alone, in this order.
const LITERAL = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const WILDCARD = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*\.\*$/;
const OPAQUE = /^[\x21\x23-\x29\x2B-\x5B\x5D-\x7E]+$/;
export function scopeForm(s) {
  if (typeof s !== 'string') return null;
  if (LITERAL.test(s)) return 'literal';
  if (WILDCARD.test(s)) return 'wildcard';
  if (OPAQUE.test(s)) return 'opaque';
  return null;
}

// Section 4.1: the covering relation of a parent scope over a child scope.
export function covers(parent, child) {
  const p = scopeForm(parent);
  const c = scopeForm(child);
  if (!p || !c) return false;
  if (p !== 'wildcard') return parent === child;
  if (c === 'opaque') return false;
  return child.startsWith(parent.slice(0, -1));
}

function parseConstraints(list, bad) {
  if (!Array.isArray(list)) bad('"constraints" is not an array');
  const seen = new Set();
  return list.map((k) => {
    if (!isObject(k)) bad('a constraint is not an object');
    if (typeof k.key !== 'string') bad('a constraint carries no "key" that is a string');
    const others = Object.keys(k).filter((m) => m !== 'key');
    let type;
    if (others.includes('rank') || others.includes('order')) {
      if (!(others.length === 2 && others.includes('rank') && others.includes('order'))) bad(`the constraint on ${quote(k.key)} is not a "rank" constraint with its "order" and nothing else`);
      type = 'rank';
    } else if (others.length === 1) {
      [type] = others;
    } else {
      bad(`the constraint on ${quote(k.key)} carries ${others.length} members beside "key", where it carries one typed value`);
    }
    const v = k[type];
    if (NUMERIC_TYPES.has(type) && typeof v !== 'number') bad(`the "${type}" constraint on ${quote(k.key)} is not a number`);
    if ((type === 'one_of' || type === 'not_one_of') && !Array.isArray(v)) bad(`the "${type}" constraint on ${quote(k.key)} is not an array`);
    if (type === 'prefix' && typeof v !== 'string') bad(`the "prefix" constraint on ${quote(k.key)} is not a string`);
    if (type === 'rank') {
      const { order } = k;
      if (!Array.isArray(order) || order.length < 2 || !order.every((x) => typeof x === 'string') || new Set(order).size !== order.length) bad(`the "order" of the "rank" constraint on ${quote(k.key)} is not two or more distinct strings`);
      if (typeof v !== 'string' || !order.includes(v)) bad(`the "rank" of the constraint on ${quote(k.key)} is not a member of its "order"`);
    }
    const id = jcs([k.key, type]);
    if (seen.has(id)) bad(`two constraints share the key ${quote(k.key)} and the type ${quote(type)}`);
    seen.add(id);
    return { key: k.key, type, known: KNOWN_TYPES.has(type), value: v, order: k.order, bytes: jcs(k) };
  });
}

function parseAuthority(details, bad) {
  if (!Array.isArray(details)) bad('"authorization_details" is not an array');
  if (details.length !== 1) bad(`"authorization_details" carries ${details.length} details, where a token carries exactly one`);
  const [d] = details;
  if (!isObject(d)) bad('the authorization detail is not an object');
  if (d.type !== DETAIL_TYPE) bad(`the authorization detail type ${quote(d.type)} is not "${DETAIL_TYPE}"`);
  for (const m of Object.keys(d)) if (!DETAIL_MEMBERS.has(m)) bad(`the authorization detail carries the member ${quote(m)}`);
  if (!Array.isArray(d.scopes)) bad('"scopes" is not an array');
  for (const s of d.scopes) if (!scopeForm(s)) bad(`the scope ${quote(s)} matches none of the forms of section 4.1`);
  return { scopes: [...d.scopes], constraints: has(d, 'constraints') ? parseConstraints(d.constraints, bad) : [] };
}

const isAudience = (a) => typeof a === 'string' || (Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string'));

function parseToken(token, index) {
  const bad = (detail) => deny('malformed', 'parse', index, `DT_${index}: ${detail}`);
  if (typeof token !== 'string') bad('the token is not a string');
  if (token.length > LIMITS.tokenChars) bad(`the token is longer than this verifier reads (${LIMITS.tokenChars} characters)`);
  const parts = token.split('.');
  if (parts.length !== 3) bad('the token is not three base64url parts');
  const [h, p, s] = parts.map(base64url);
  if (!h || !p || !s) bad('a part of the token is not unpadded base64url');
  const header = decodeJson(h, index, 'protected header');
  const c = decodeJson(p, index, 'payload');

  if (typeof header.alg !== 'string') bad('the protected header carries no "alg"');
  if (header.typ !== 'at+jwt' && header.typ !== 'application/at+jwt') bad('the protected header "typ" is not at+jwt');
  if (has(header, 'crit')) bad('the protected header names "crit" parameters, and this verifier implements none');

  if (typeof c.iss !== 'string' || c.iss === '') bad('"iss" is not a non-empty string');
  for (const n of ['exp', 'iat']) if (typeof c[n] !== 'number') bad(`"${n}" is not a number`);
  if (has(c, 'nbf') && typeof c.nbf !== 'number') bad('"nbf" is not a number');
  if (typeof c.jti !== 'string' || c.jti === '') bad('"jti" is not a non-empty string');
  if (!isAudience(c.aud)) bad('"aud" is not a string or an array of one or more strings');
  if (index === 0 && (typeof c.sub !== 'string' || c.sub === '')) bad('"sub" of DT_0 is not a non-empty string');
  if (typeof c.sub !== 'string') bad('"sub" is not a string');
  if (typeof c.client_id !== 'string') bad('"client_id" is not a string');
  if (!isObject(c.cnf) || !isDigest(c.cnf.jkt)) bad('"cnf" carries no "jkt" that is a SHA-256 thumbprint in base64url');
  if (!Number.isInteger(c.del_depth) || c.del_depth < 0) bad('"del_depth" is not a non-negative integer');
  if (index === 0 && !has(c, 'del_max_depth')) bad('DT_0 carries no "del_max_depth"');
  if (has(c, 'del_max_depth') && !(Number.isInteger(c.del_max_depth) && c.del_max_depth > 0)) bad('"del_max_depth" is not a positive integer');
  if (index === 0 && has(c, 'par_hash')) bad('DT_0 carries a "par_hash"');
  if (index > 0 && !has(c, 'par_hash')) bad('a child carries no "par_hash"');
  if (index > 0 && !isDigest(c.par_hash)) bad('"par_hash" is not a SHA-256 digest in base64url');
  const authority = parseAuthority(c.authorization_details, bad);

  return { header, claims: c, authority, signingInput: `${parts[0]}.${parts[1]}`, signature: s };
}

function publicKey(jwk) {
  if (!isObject(jwk) || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || base64url(jwk.x)?.length !== 32 || has(jwk, 'd')) return null;
  try {
    return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
  } catch {
    return null;
  }
}

const thumbprint = (jwk) => crypto.createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`, 'utf8').digest();

function ed25519Verifies(key, t) {
  if (t.signature.length !== 64) return false;
  try {
    return crypto.verify(null, Buffer.from(t.signingInput, 'ascii'), key, t.signature);
  } catch {
    return false;
  }
}

function checkState(state) {
  const ok = isObject(state) && Number.isInteger(state.clockNumericDate)
    && Array.isArray(state.acceptedAlgorithms) && state.acceptedAlgorithms.every((a) => typeof a === 'string')
    && Array.isArray(state.keys) && state.keys.length > 0
    && state.keys.every((k) => isObject(k) && typeof k.kid === 'string' && typeof k.alg === 'string' && publicKey(k.publicJwk));
  if (!ok) throw new TypeError('verifier state: clockNumericDate (integer seconds), acceptedAlgorithms (strings) and keys ({ kid, alg, publicJwk } with an Ed25519 public JWK) are required');
}

// Step 1 for one token.
function step1(t, i, tokens, state, trace) {
  const { alg } = t.header;
  if (!state.acceptedAlgorithms.includes(alg)) deny('signature_invalid', 1, i, `DT_${i} names the algorithm ${quote(alg)}, which is not on this verifier's list`);
  if (i === 0) {
    const candidates = state.keys.filter((k) => !has(t.header, 'kid') || k.kid === t.header.kid);
    if (candidates.length === 0) deny('signature_invalid', 1, 0, `DT_0 names the key ${quote(t.header.kid)}, which is not a trusted root key`);
    const configured = candidates.filter((k) => k.alg === alg);
    if (configured.length === 0) deny('signature_invalid', 1, 0, `DT_0 names the algorithm ${quote(alg)}, and this verifier configures another for the root key`);
    const key = configured.find((k) => ed25519Verifies(publicKey(k.publicJwk), t));
    if (!key) deny('signature_invalid', 1, 0, 'DT_0 does not verify under a trusted root key');
    trace.push({ step: 1, index: 0, check: `DT_0 verifies under the trusted root key ${quote(key.kid)} (${alg})` });
    return;
  }
  const key = publicKey(t.header.jwk);
  if (!key) deny('signature_invalid', 1, i, `DT_${i} carries no Ed25519 public key in its protected header "jwk"`);
  if (!crypto.timingSafeEqual(thumbprint(t.header.jwk), Buffer.from(tokens[i - 1].claims.cnf.jkt, 'base64url'))) {
    deny('signature_invalid', 1, i, `the key in DT_${i}'s header is not the key DT_${i - 1}.cnf names`);
  }
  if (alg !== CHILD_KEY_ALG) deny('signature_invalid', 1, i, `DT_${i} names the algorithm ${quote(alg)}, and this verifier configures ${CHILD_KEY_ALG} for an Ed25519 key`);
  if (!ed25519Verifies(key, t)) deny('signature_invalid', 1, i, `DT_${i} does not verify under the key DT_${i - 1}.cnf names`);
  trace.push({ step: 1, index: i, check: `DT_${i} verifies under the key DT_${i - 1}.cnf names, jkt ${tokens[i - 1].claims.cnf.jkt} (${alg})` });
}

function subset(c, p) {
  switch (p.type) {
    case 'max':
    case 'max_lifetime':
    case 'max_subtree':
      return c.value <= p.value;
    case 'min':
      return c.value >= p.value;
    case 'one_of': {
      const allowed = new Set(p.value.map(jcs));
      return c.value.every((x) => allowed.has(jcs(x)));
    }
    case 'not_one_of': {
      const excluded = new Set(c.value.map(jcs));
      return p.value.every((x) => excluded.has(jcs(x)));
    }
    case 'prefix':
      return c.value.startsWith(p.value);
    case 'rank':
      return c.order.length === p.order.length && c.order.every((x, j) => x === p.order[j]) && c.order.indexOf(c.value) <= p.order.indexOf(p.value);
    default:
      return false;
  }
}

// Section 4.3, rules 1, 2, 3 and 5 (step 4); the reason it fails, or null.
function notSubsumed(child, parent, childDepth, parentDepth) {
  for (const s of child.scopes) if (!parent.scopes.some((p) => covers(p, s))) return `rule 1: the scope ${quote(s)} is covered by no scope of the parent`;
  for (const p of parent.constraints) {
    const c = child.constraints.find((x) => x.key === p.key && x.type === p.type);
    const name = `(${quote(p.key)}, ${quote(p.type)})`;
    if (!c) return `rule 3: the parent's constraint ${name} is absent in the child`;
    if (!p.known) {
      if (c.bytes !== p.bytes) return `rule 2: the parent's constraint ${name} is of a type this verifier does not implement, and the child's is not byte-identical to it in JCS`;
    } else if (!subset(c, p)) {
      return `rule 2: the child's constraint ${name} admits more than the parent's`;
    }
  }
  if (childDepth > parentDepth) return `rule 5: del_max_depth ${childDepth} exceeds the parent's ${parentDepth}`;
  return null;
}

// Verify a chain, DT_0 at index 0, under a verifier state:
//   { clockNumericDate, acceptedAlgorithms: ['Ed25519'], keys: [{ kid, alg, publicJwk }] }
// The result names the outcome ('valid' or a Table 2 name), the step and the
// token where a check failed, the steps performed and not performed, and a
// trace of the checks that passed.
export function verifyChain(chain, state) {
  checkState(state);
  const trace = [];
  const base = { stepsNotPerformed: [...STEPS_NOT_PERFORMED], authorizes: false };
  try {
    if (!Array.isArray(chain) || chain.length === 0) deny('malformed', 'parse', null, 'the chain is not an array of one or more tokens');
    if (chain.length > LIMITS.tokens) deny('malformed', 'parse', null, `the chain is longer than this verifier reads (${LIMITS.tokens} tokens)`);
    const tokens = chain.map((t, i) => parseToken(t, i));
    const n = tokens.length - 1;
    trace.push({ step: 'parse', index: null, check: `${tokens.length} tokens: JCS, one "agent_delegation" detail each, every scope and constraint well formed` });

    tokens.forEach((t, i) => step1(t, i, tokens, state, trace));

    for (let i = 1; i <= n; i += 1) {
      const digest = crypto.createHash('sha256').update(tokens[i - 1].signingInput, 'ascii').digest();
      if (!crypto.timingSafeEqual(digest, Buffer.from(tokens[i].claims.par_hash, 'base64url'))) {
        deny('par_hash_mismatch', 2, i, `DT_${i}.par_hash is not the SHA-256 of the JWS Signing Input of the DT_${i - 1} presented with it`);
      }
      trace.push({ step: 2, index: i, check: `DT_${i}.par_hash ${tokens[i].claims.par_hash} is the SHA-256 of DT_${i - 1}'s JWS Signing Input` });
    }

    tokens.forEach((t, i) => {
      if (t.claims.del_depth !== i) deny('depth_invalid', 3, i, `DT_${i}.del_depth is ${t.claims.del_depth}`);
    });
    const maxDepth = tokens[0].claims.del_max_depth;
    if (!(n < maxDepth)) deny('depth_invalid', 3, n, `the chain ends at index ${n}, which is not below DT_0.del_max_depth ${maxDepth}`);
    const principal = tokens[0].claims.sub;
    tokens.forEach((t, i) => {
      if (t.claims.sub !== principal) deny('principal_altered', 3, i, `DT_${i}.sub differs from DT_0.sub`);
    });
    trace.push({ step: 3, index: null, check: `del_depth 0 to ${n} in sequence; ${n} < DT_0.del_max_depth ${maxDepth}; sub ${quote(principal)} at every token` });

    const depths = [maxDepth];
    for (let i = 1; i <= n; i += 1) depths.push(has(tokens[i].claims, 'del_max_depth') ? tokens[i].claims.del_max_depth : depths[i - 1]);
    for (let i = 1; i <= n; i += 1) {
      const why = notSubsumed(tokens[i].authority, tokens[i - 1].authority, depths[i], depths[i - 1]);
      if (why) deny('not_narrower', 4, i, `DT_${i} is not subsumed by DT_${i - 1}: ${why}`);
      trace.push({ step: 4, index: i, check: `DT_${i} <= DT_${i - 1} under rules 1, 2, 3 and 5` });
    }

    const now = state.clockNumericDate;
    tokens.forEach((t, i) => {
      const c = t.claims;
      if (has(c, 'nbf') && !(c.nbf <= now)) deny('expired', 5, i, `DT_${i} is not valid before ${c.nbf}, and the clock reads ${now}`);
      if (!(now < c.exp)) deny('expired', 5, i, `DT_${i} expired at ${c.exp}, and the clock reads ${now}`);
      if (i > 0 && !(c.exp <= tokens[i - 1].claims.exp)) deny('expired', 5, i, `rule 4: DT_${i}.exp ${c.exp} exceeds DT_${i - 1}.exp ${tokens[i - 1].claims.exp}`);
      trace.push({ step: 5, index: i, check: `DT_${i} is inside its window at ${now}${i > 0 ? `, exp ${c.exp} <= ${tokens[i - 1].claims.exp}` : `, exp ${c.exp}`}` });
    });

    tokens.forEach((t, i) => {
      if (has(t.claims, 'status')) deny('status_unknown', 7, i, `DT_${i} carries a status reference, and this verifier holds no status list`);
    });
    trace.push({ step: 7, index: null, check: 'no token carries a status reference' });

    const leaf = tokens[n].authority;
    return {
      ...base,
      outcome: 'valid',
      valid: true,
      step: null,
      index: null,
      detail: `the chain is valid under steps ${STEPS_PERFORMED.join(', ')}; steps 6 and 8 need the request and were not performed, so no action is reported as permitted`,
      stepsPerformed: [...STEPS_PERFORMED],
      chain: { length: tokens.length, principal, actingAgents: tokens.map((t) => t.claims.client_id) },
      leaf: {
        scopes: [...leaf.scopes],
        constraints: leaf.constraints.map(({ key, type, value, order }) => (type === 'rank' ? { key, type, value, order } : { key, type, value })),
        unknownConstraintTypes: leaf.constraints.filter((k) => !k.known).map(({ key, type }) => ({ key, type })),
      },
      trace,
    };
  } catch (err) {
    if (!(err instanceof Denied)) throw err;
    return { ...base, outcome: err.outcome, valid: false, step: err.step, index: err.index, detail: err.detail, trace };
  }
}
