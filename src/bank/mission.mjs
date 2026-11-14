// Mission-Bound Authorization at the bank, after draft-mcguinness-oauth-mission-02:
//
//   - the integrity anchor construction (Section 6.3): JCS (RFC 8785) over
//     the envelope {iss, typ, value}, SHA-256, "sha-256:" and base64url;
//   - the Mission state rule (Section 10);
//   - the payment API's issuer-local resolution of a Mission-bound token
//     (Section 9.2.4) and its enforcement of the token's carried entries
//     (Sections 9.1.1 and 9.1.4);
//   - the subset rule (Section 5.4) for a derivation under a Mission,
//     deriveUnderMission, which the bank's token service does not call.
//
// The type the bank enforces and narrows is mission_resource_access, whose
// relation draft-mcguinness-oauth-mission-resource-access defines. The bank
// implements the exact resource match, literal and family actions, and the
// max_amount constraint. What it does not implement is refused, never
// guessed: an entry it cannot enforce provides no authority, and a
// derivation it cannot decide is refused.

import crypto from 'node:crypto';

export const RESOURCE_ACCESS = 'mission_resource_access';

// The action each payment API operation needs, by operation kind.
export const ACTIONS = Object.freeze({ payment: 'payments.create', balance: 'balance.read' });

const ENTRY_MEMBERS = new Set(['type', 'resource', 'resource_match', 'actions', 'constraints', 'delegation']);
const DELEGATION_MEMBERS = new Set(['max_depth', 'allowed_delegates']);
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// The days of each month in a common year; February has 29 in a leap year.
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
// The decimal grammar of the resource access type: digits, then at most 18
// fraction digits. A value outside it is malformed, never parsed.
const DECIMAL = /^[0-9]+(\.[0-9]{1,18})?$/;
const CURRENCY = /^[A-Z]{3}$/;

// A plain JSON object, as JSON.parse and structuredClone give one.
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function quote(s) {
  if (!s.isWellFormed()) throw new TypeError('a string with a lone surrogate is not I-JSON');
  return JSON.stringify(s);
}

// The JCS form of a JSON value (RFC 8785). Member names sort by UTF-16 code
// units, which is the default order of Array.prototype.sort, and a number
// takes the ECMAScript serialization JSON.stringify gives it.
export function canonicalize(value) {
  if (value === null || value === true || value === false) return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('a number that is not finite has no JSON form');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return quote(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${quote(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`a value of type ${typeof value} is not in the JSON data model`);
}

// Section 6.3.1: the anchor of value under typ and iss.
export function computeAnchor(typ, iss, value) {
  const bytes = Buffer.from(canonicalize({ typ, iss, value }), 'utf8');
  return `sha-256:${crypto.createHash('sha256').update(bytes).digest('base64url')}`;
}

// An RFC 3339 date-time as milliseconds, or NaN when the text is not one.
// Date.parse rolls an impossible instant over instead of refusing it
// (2026-02-30 reads as 2026-03-02, and 24:00:00 as the next day's midnight),
// so each field is held to its range before Date.parse reads the text: a
// month from 01 to 12, a day its month has in that year, an hour from 00 to
// 23, and a minute and a second from 00 to 59.
export function rfc3339Ms(text) {
  const f = typeof text === 'string' ? RFC3339.exec(text) : null;
  if (!f) return NaN;
  const [year, month, day, hour, minute, second] = f.slice(1, 7).map(Number);
  if (month < 1 || month > 12) return NaN;
  const days = month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1];
  if (day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return NaN;
  return Date.parse(text);
}

// Section 10. A Mission is active when its stored state is exactly "active"
// and the decision time is strictly before its expires_at. From expires_at a
// stored "active" Mission is terminated with reason expired. Every other
// state value, one the bank does not recognize included, is not active.
export function missionState(record, now) {
  if (!isObject(record)) return { active: false, category: 'NOT_ACTIVE', reason: 'no Mission record' };
  if (record.state === 'active') {
    const expires = rfc3339Ms(record.expires_at);
    if (Number.isNaN(expires)) return { active: false, category: 'NOT_ACTIVE', reason: 'the Mission record has no valid expires_at' };
    if (now.getTime() < expires) return { active: true };
    return { active: false, category: 'EXPIRED', reason: 'Mission expired: the decision time is at or after its expires_at' };
  }
  if (record.state === 'terminated') {
    const why = isObject(record.termination) ? record.termination.reason : undefined;
    if (why === 'revoked') return { active: false, category: 'REVOKED', reason: 'Mission revoked' };
    if (why === 'expired') return { active: false, category: 'EXPIRED', reason: 'Mission expired' };
    return { active: false, category: 'NOT_ACTIVE', reason: `Mission terminated, reason ${JSON.stringify(why ?? null)}` };
  }
  return { active: false, category: 'NOT_ACTIVE', reason: `Mission state ${JSON.stringify(record.state ?? null)} is not active` };
}

// Decimal strings compared in decimal value space, never as numbers.
function decimalCompare(a, b) {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const n = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(n, '0'));
  const y = BigInt(bi + bf.padEnd(n, '0'));
  return x < y ? -1 : x > y ? 1 : 0;
}

function wellFormedAmount(v) {
  return isObject(v) && Object.keys(v).length === 2 && typeof v.amount === 'string' && DECIMAL.test(v.amount)
    && typeof v.currency === 'string' && CURRENCY.test(v.currency);
}

const isFamily = (a) => typeof a === 'string' && a.length > 2 && a.endsWith('.*');

// A literal or family action within a reference action, as the type defines
// it: within an equal value; a literal within a family whose name it extends
// at a segment boundary; a family within a family whose name its own extends
// at a segment boundary; a family never within a literal.
function actionWithin(a, ref) {
  if (a === ref) return true;
  if (!isFamily(ref)) return false;
  const stem = ref.slice(0, -1); // "payments." for "payments.*"
  return a.startsWith(stem) && a.length > stem.length;
}

const wellFormedActions = (v) => Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === 'string' && a.length > 0);

// One carried entry against one request, on its own: entries are
// alternative grants, and parts of two entries never authorize one request
// together (Section 9.1.1, items 1 and 2).
function entryDecision(e, request) {
  if (!isObject(e) || e.type !== RESOURCE_ACCESS) return 'no authority';
  const exact = e.resource_match === undefined || e.resource_match === 'exact';
  if (exact && e.resource !== request.resource) return 'no authority';
  if (!wellFormedActions(e.actions)) return 'unenforceable';
  if (!e.actions.some((a) => actionWithin(request.action, a))) return 'no authority';
  // The entry applies to this request from here on.
  if (!exact) return 'unenforceable'; // a matching mode the bank does not implement
  if (Object.keys(e).some((k) => !ENTRY_MEMBERS.has(k))) return 'unenforceable';
  if (e.constraints !== undefined) {
    if (!isObject(e.constraints)) return 'unenforceable';
    for (const [k, v] of Object.entries(e.constraints)) {
      if (k !== 'max_amount' || !wellFormedAmount(v)) return 'unenforceable';
    }
    const cap = e.constraints.max_amount;
    if (cap) {
      // The operation names no amount to hold against the ceiling.
      if (!isObject(request.amount)) return 'unenforceable';
      const { amount, currency } = request.amount;
      if (currency !== cap.currency || typeof amount !== 'string' || !DECIMAL.test(amount) || decimalCompare(amount, cap.amount) > 0) {
        return 'no authority';
      }
    }
  }
  return 'authorizes';
}

// Section 9.1.4: the request is allowed when one carried entry authorizes
// all of it. Otherwise the denial says whether an applicable entry carried
// something the bank cannot enforce.
export function authorizeRequest(entries, request) {
  let unenforceable = false;
  for (const e of Array.isArray(entries) ? entries : []) {
    const d = entryDecision(e, request);
    if (d === 'authorizes') return { allowed: true };
    if (d === 'unenforceable') unenforceable = true;
  }
  return unenforceable
    ? { allowed: false, missionDenial: 'constraint_unrecognized', category: 'UNENFORCEABLE', reason: 'an applicable entry carries a member or constraint the bank cannot enforce' }
    : { allowed: false, missionDenial: 'insufficient_authority', category: 'OUTSIDE_AUTHORITY', reason: 'no carried entry authorizes the whole request' };
}

const invalidToken = (category, reason) => ({ allowed: false, status: 401, category, reason, challenge: 'Bearer error="invalid_token"' });

// The payment API's decision on a Mission-bound access token, resolved
// issuer-locally against the bank's Mission records (Section 9.2.4).
//
//   config: { issuer, resource, missions }: the bank's Mission issuer, the
//   payment API's resource identifier (also its audience), and a Map from
//   Mission id to record. Without the records the resolution cannot be
//   completed, which is a 503, never a statement about the token.
export function decideMissionRequest(token, operation, config, now) {
  if (!config || !(config.missions instanceof Map)) {
    return { allowed: false, status: 503, category: 'RESOLUTION_UNAVAILABLE', reason: 'the bank has no Mission state to resolve the token against', challenge: null };
  }
  const m = token.mission;
  if (!isObject(m) || typeof m.id !== 'string' || typeof m.issuer !== 'string') return invalidToken('NOT_ACTIVE', 'the mission member is malformed');
  // Section 9.1.1 item 6: a trusted Mission issuer, equal to the token's iss.
  if (m.issuer !== config.issuer || token.iss !== m.issuer) return invalidToken('UNTRUSTED_ISSUER', 'the Mission issuer is not the bank, or is not the token issuer');
  const aud = Array.isArray(token.aud) ? token.aud : [token.aud];
  if (!aud.includes(config.resource)) return invalidToken('AUDIENCE', 'the payment API is not in the token audience');
  const record = config.missions.get(m.id);
  if (!isObject(record) || record.issuer !== m.issuer) return invalidToken('NOT_ACTIVE', 'no Mission record for the mission id');
  const state = missionState(record, now);
  if (!state.active) return invalidToken(state.category, state.reason);
  const request = {
    resource: config.resource,
    action: ACTIONS[operation.kind],
    amount: operation.kind === 'payment' ? { amount: operation.amountDecimal, currency: operation.currency } : undefined,
  };
  const a = authorizeRequest(token.authorization_details, request);
  if (a.allowed) return { allowed: true, status: 200, category: null, reason: 'a carried entry authorizes the request' };
  return { ...a, status: 403, challenge: `Bearer error="insufficient_scope", mission_denial="${a.missionDenial}"` };
}

// The type's subset relation (Section 5.4, and the resource access
// companion's Subset Rule), or the reason it does not hold.
function resourceAccessSubset(a, b) {
  for (const e of [a, b]) {
    if (Object.keys(e).some((k) => !ENTRY_MEMBERS.has(k))) return 'an unrecognized member: the comparison cannot decide';
    if (e.resource_match !== undefined && e.resource_match !== 'exact') return 'a resource_match the bank does not implement';
    if (typeof e.resource !== 'string' || !wellFormedActions(e.actions)) return 'a malformed entry';
  }
  if (a.resource !== b.resource) return 'a resource outside the reference entry';
  for (const x of a.actions) {
    const within = b.actions.some((r) => x === r || (isFamily(x) ? isFamily(r) && actionWithin(x.slice(0, -2), r) : actionWithin(x, r)));
    if (!within) return `the action ${x} is outside the reference entry`;
  }
  const ac = a.constraints ?? {};
  const bc = b.constraints ?? {};
  if (!isObject(ac) || !isObject(bc)) return 'malformed constraints';
  for (const k of new Set([...Object.keys(ac), ...Object.keys(bc)])) {
    if (k !== 'max_amount') return `a constraint the bank does not narrow: ${k}`;
  }
  if (bc.max_amount !== undefined) {
    if (ac.max_amount === undefined) return 'the max_amount constraint is dropped';
    if (!wellFormedAmount(ac.max_amount) || !wellFormedAmount(bc.max_amount)) return 'a malformed max_amount';
    if (ac.max_amount.currency !== bc.max_amount.currency) return 'a max_amount in another currency';
    if (decimalCompare(ac.max_amount.amount, bc.max_amount.amount) > 0) return 'a max_amount above the reference entry';
  } else if (ac.max_amount !== undefined && !wellFormedAmount(ac.max_amount)) {
    return 'a malformed max_amount';
  }
  // delegation is policy, not authority, and never broader than the parent's.
  if (a.delegation !== undefined) {
    if (b.delegation === undefined) return 'delegation introduced where the reference entry has none';
    const ad = a.delegation;
    const bd = b.delegation;
    if (!isObject(ad) || !isObject(bd) || [...Object.keys(ad), ...Object.keys(bd)].some((k) => !DELEGATION_MEMBERS.has(k))) {
      return 'a delegation member the bank does not compare';
    }
    if (!Number.isInteger(ad.max_depth) || !Number.isInteger(bd.max_depth) || ad.max_depth > bd.max_depth) return 'a delegation max_depth above the reference entry';
    if (ad.allowed_delegates !== undefined && !Array.isArray(ad.allowed_delegates)) return 'a malformed allowed_delegates';
    if (bd.allowed_delegates !== undefined) {
      if (!Array.isArray(ad.allowed_delegates) || !Array.isArray(bd.allowed_delegates)) return 'allowed_delegates wider than the reference entry';
      const parent = new Set(bd.allowed_delegates.map(canonicalize));
      if (!ad.allowed_delegates.every((d) => parent.has(canonicalize(d)))) return 'allowed_delegates wider than the reference entry';
    }
  }
  return null;
}

// Section 5.4: candidate is a subset of reference. An entry byte-identical
// to its reference under the canonical form is one for every type; any
// other comparison needs the type's own relation, which the bank applies
// for the types it declares narrowing for.
export function isSubsetEntry(candidate, reference, { narrowing = [RESOURCE_ACCESS] } = {}) {
  if (canonicalize(candidate) === canonicalize(reference)) return { subset: true, reason: 'byte-identical to the reference entry' };
  if (!isObject(candidate) || !isObject(reference) || candidate.type !== reference.type) return { subset: false, reason: 'another type than the reference entry' };
  if (!narrowing.includes(candidate.type) || candidate.type !== RESOURCE_ACCESS) return { subset: false, reason: `no narrowing declared for ${candidate.type}` };
  const why = resourceAccessSubset(candidate, reference);
  return why ? { subset: false, reason: why } : { subset: true, reason: 'no broader under the type relation' };
}

// A derivation under a Mission, as a token service makes one in a Token
// Exchange (the bank's token service does not call this): the Mission is
// active, and every requested entry is a subset of some entry of its
// Authority Set (Sections 5.4, 7.1 and 11).
export function deriveUnderMission({ mission, requested, now, narrowing = [RESOURCE_ACCESS] }) {
  const state = missionState(mission, now);
  if (!state.active) return { derived: false, error: 'invalid_request', category: state.category, reason: state.reason };
  if (!Array.isArray(requested) || requested.length === 0) {
    return { derived: false, error: 'invalid_authorization_details', category: 'NOT_A_SUBSET', reason: 'no entry requested' };
  }
  const set = Array.isArray(mission.authority_set) ? mission.authority_set : [];
  for (const [i, entry] of requested.entries()) {
    const tries = set.map((ref) => isSubsetEntry(entry, ref, { narrowing }));
    if (!tries.some((t) => t.subset)) {
      const reasons = [...new Set(tries.map((t) => t.reason))].join('; ') || 'the Authority Set is empty';
      return { derived: false, error: 'invalid_authorization_details', category: 'NOT_A_SUBSET', reason: `entry ${i} is not a subset of any Authority Set entry: ${reasons}` };
    }
  }
  return { derived: true, entries: structuredClone(requested) };
}
