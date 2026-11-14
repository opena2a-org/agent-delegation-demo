import crypto from 'node:crypto';
import { plantedValues } from '../../src/config.mjs';

// Every planted value as a pattern that cannot match by chance inside a hex
// digest or a base64 signature.
export function plantedPatterns() {
  const p = plantedValues();
  const literal = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  return [
    ...p.payeeNames.map(literal),
    ...p.payeeAccounts.map(literal),
    ...p.payeeAccounts.map((a) => literal(sha(a))),
    literal('86.40'),
    literal('240.00'),
    /(^|[^0-9A-Za-z+/])8640([^0-9A-Za-z+/]|$)/,
    /(^|[^0-9A-Za-z+/])24000([^0-9A-Za-z+/]|$)/,
    ...p.customer.map(literal),
  ];
}
