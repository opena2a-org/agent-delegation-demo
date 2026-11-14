// Money as integer cents. Consent amounts arrive as decimal strings.

const AMOUNT = /^(0|[1-9][0-9]{0,8})\.([0-9]{2})$/;

export function parseCents(text) {
  if (typeof text !== 'string') throw new TypeError('amount must be a decimal string');
  const m = AMOUNT.exec(text);
  if (!m) throw new RangeError('amount must look like 86.40');
  return Number(m[1]) * 100 + Number(m[2]);
}

export function centsToDecimal(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('cents must be a non negative integer');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function formatUsd(cents) {
  const [whole, frac] = centsToDecimal(cents).split('.');
  return `$${Number(whole).toLocaleString('en-US')}.${frac}`;
}

export function accountEnding(account) {
  return String(account).slice(-4);
}

// "March 31, 2027" from an ISO time, in UTC.
export function proseDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
}

// "HH:MM:SS UTC"
export function utcClock(iso) {
  return `${new Date(iso).toISOString().slice(11, 19)} UTC`;
}
