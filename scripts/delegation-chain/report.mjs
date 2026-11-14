// One fixture's report for scripts/delegation-chain/verify.mjs: the bank
// broker's delegation chain check on the fixture's chain, beside the
// fixture's expected result. ok is true when the observed result is the
// expected one.

import { isDeepStrictEqual } from 'node:util';
import { verifyDelegationChain } from '../../src/bank/broker.mjs';

const at = (step, index) => `${step === 'parse' ? 'parse' : `step ${step}`}${index === null ? '' : `, DT_${index}`}`;
const constraint = (k) => `${k.key} ${k.type} ${JSON.stringify(k.value)}${k.order ? ` of ${JSON.stringify(k.order)}` : ''}`;

export function report(fx, file, { trace = false } = {}) {
  const e = fx.expected;
  const r = verifyDelegationChain(fx.chain, fx.verifierState);
  const expected = e.verifyResult === 'ACCEPT' ? 'ACCEPT' : `REJECT ${e.rejectCategory} (${at(e.step, e.index)})`;
  const observed = r.valid ? 'ACCEPT' : `REJECT ${r.outcome} (${at(r.step, r.index)})`;
  const ok = expected === observed && r.authorizes === false
    && (!r.valid || (isDeepStrictEqual(r.stepsNotPerformed, e.stepsNotPerformed) && isDeepStrictEqual(r.leaf.unknownConstraintTypes, e.unknownConstraintTypes ?? [])));
  const lines = [
    `fixture: ${fx.name}`,
    `  file: ${file}`,
    `  chain: ${fx.chain.length} tokens; clock ${fx.verifierState.clockNumericDate}; accepted algorithms ${fx.verifierState.acceptedAlgorithms.join(' ')}; trusted root keys ${fx.verifierState.keys.map((k) => `${k.kid} (${k.alg})`).join(' ')}`,
  ];
  if (trace) for (const t of r.trace) lines.push(`  ${t.step === 'parse' ? 'parse' : `step ${t.step}`}: ${t.check}`);
  lines.push(`  expected: ${expected}`, `  observed: ${observed}`);
  if (r.valid) {
    lines.push(`  principal: ${r.chain.principal}; acting agents: ${r.chain.actingAgents.join(' > ')}`);
    lines.push(`  leaf scopes: ${r.leaf.scopes.join(' ')}`);
    lines.push(`  leaf constraints: ${r.leaf.constraints.map(constraint).join('; ')}`);
    if (r.leaf.unknownConstraintTypes.length > 0) lines.push(`  leaf constraint types this verifier does not implement: ${r.leaf.unknownConstraintTypes.map((k) => `${k.key} ${k.type}`).join('; ')} (step 8 denies every action under them)`);
    lines.push(`  steps performed: ${r.stepsPerformed.join(' ')}; not performed: ${r.stepsNotPerformed.join(' ')}, which need the request; reports an action as authorized: ${r.authorizes ? 'yes' : 'no'}`);
  } else {
    lines.push(`  detail: ${r.detail}`);
  }
  lines.push(`  result: ${ok ? 'PASS' : 'FAIL'}`);
  return { ok, lines };
}
