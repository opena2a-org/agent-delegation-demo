// When an offline check record compares its two runs. A scenario is the same
// or different when both runs carry its decision, and a missing decision is
// never different. The sentence on the decisions, the outcome that states
// it, the row labels and the count show when both runs returned a decision
// for each of the four scenarios, and in no other record. The check, the
// text runner and the page read this one rule; the page loads this file too.

const SCENARIOS = ['1', '2', '3', '4'];

// A decision as the scenario engine reads it back from the bank: an object
// whose outcome is a string. null, a missing key and an error record in its
// place are no decision.
export function hasDecision(d) {
  return d !== null && typeof d === 'object' && !Array.isArray(d) && typeof d.outcome === 'string' && !('error' in d);
}

// Both runs returned a decision for each of the four scenarios, and each
// scenario was compared.
export function fourOnBothSides(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length !== SCENARIOS.length) return false;
  return SCENARIOS.every((n) => {
    const o = outcomes.find((x) => x && x.scenario === n);
    return Boolean(o) && hasDecision(o.open) && hasDecision(o.blocked) && typeof o.same === 'boolean';
  });
}
