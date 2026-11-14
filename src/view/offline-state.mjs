// The offline screen's five states, from the offline check's own record:
// idle (no check has finished in this server session), measured, differs,
// not-measured and not-run. A sentence that states the check's result appears
// solely in the state where that result exists: in every state but measured
// the headline slot holds the screen's name and the subhead and why slots are
// empty. There is no default for the count: it renders from the record's own
// counter, and a count that cannot be filled puts the screen in not-measured.
// Pure functions: the page and the tests call them.

import { MissingFill, fill } from './fill.mjs';
import { fourOnBothSides } from './offline-compare.mjs';

const SCENARIOS = ['1', '2', '3', '4'];

// Whether a decision is the one the screen's row names for its scenario.
function decisionHolds(scenario, d) {
  if (!d) return false;
  if (scenario === '1') return d.outcome === 'paid' && d.consentField === null;
  if (scenario === '2') return d.outcome === 'refused' && d.consentField === 'creditorAccounts';
  if (scenario === '3') {
    const status = (agent) => (Array.isArray(d.consents) ? d.consents.find((c) => c.agent === agent)?.status : null);
    return d.outcome === 'consent withdrawn' && status('Bill pay agent') === 'withdrawn' && status('Budget agent') === 'active';
  }
  if (scenario === '4') return d.outcome === 'agent on record' && d.brokerDecision === 'allowed' && d.signatureVerified === true;
  return false;
}

// The two sentences of a result line, split where the opening one ends.
function sentences(text) {
  const i = text.indexOf('. ');
  return i < 0 ? [text, ''] : [text.slice(0, i + 1), text.slice(i + 2)];
}

const pending = (copy, key) => ({ text: copy.PENDING_WORDS[key] ?? null, pending: copy.PENDING_WORDS[key] == null ? key : null });

export function offlineState(copy, record) {
  const s = copy.SCREENS.find((x) => x.id === 'offline');
  const [dl, dr] = s.cols;
  const name = s.label;
  const failed = [];
  const outcomes = record && Array.isArray(record.outcomes) ? record.outcomes : [];
  const byScenario = (n) => outcomes.find((o) => o.scenario === n) || null;
  const leftRows = dl.rows.map(([k, v], i) => {
    const o = byScenario(SCENARIOS[i]);
    return [k, o && decisionHolds(SCENARIOS[i], o.open) ? v : null];
  });
  const leftProven = leftRows.every(([, v]) => v !== null);
  const left = {
    title: dl.title,
    tone: 'neutral',
    outcome: leftProven ? dl.outcome : null,
    result: leftProven ? [{ text: dl.result }] : [],
    why: leftProven ? dl.why : null,
    rows: leftRows.map(([k, v]) => [k, v, null]),
  };
  const emptyRows = dr.rows.map(([k]) => [k, null, null]);
  const base = { name, eyebrow: null, h1: name, sub: null, left, failed };

  if (!record) {
    const idle = s.states.idle;
    const idleLeft = { ...left, outcome: copy.GLOBAL.notRunOutcome, result: [], why: null, rows: dl.rows.map(([k]) => [k, null, null]) };
    return {
      ...base,
      state: 'idle',
      left: idleLeft,
      right: { title: dr.title, tone: idle.tone, outcome: idle.outcome, result: [{ text: idle.result }], why: null, rows: emptyRows },
    };
  }

  if (record.status === 'not run') {
    const reason = copy.RULED_EXTRA.offlineNotRunReasons.includes(record.reason) ? record.reason : null;
    if (!reason) failed.push('not run reason');
    const needs = reason ? copy.RULED_EXTRA.offlineNotRunNeeds[reason] ?? null : null;
    return {
      ...base,
      state: 'not-run',
      left: { ...left, outcome: null, result: [], why: null, rows: dl.rows.map(([k]) => [k, null, null]) },
      right: {
        title: dr.title,
        tone: 'neutral',
        outcome: copy.RULED_EXTRA.offlineNotRun,
        result: reason ? [{ text: copy.RULED_EXTRA.offlineNotRunResult, values: { reason } }] : [],
        why: needs,
        rows: emptyRows,
      },
    };
  }

  // B8: each grant path decision with the network blocked against the same
  // decision with it open, when both runs returned all four. A missing
  // decision is never different, and with one missing no row is labelled.
  // A row's words are the decision its scenario names, then the screen's tag:
  // same when the two decisions are equal, different when they are not. A
  // changed decision that is not the one its row names has no words set.
  const compared = fourOnBothSides(outcomes);
  const rows = dr.rows.map(([k, v], i) => {
    const o = byScenario(SCENARIOS[i]);
    if (!compared) return [k, null, null];
    const holds = decisionHolds(SCENARIOS[i], o.blocked);
    if (o.same === true && holds && leftRows[i][1] !== null && v === `${leftRows[i][1]}${s.rowSame}`) return [k, v, null];
    if (o.same === true) { failed.push(`row ${SCENARIOS[i]}`); return [k, null, null]; }
    if (holds) return [k, `${dl.rows[i][1]}${s.rowDifferent}`, 'warn'];
    const p = pending(copy, 'offlineDiffersRow');
    return [k, p.text, 'warn', p.pending];
  });
  const allSame = compared && outcomes.every((o) => o.same === true) && rows.every(([, v]) => v !== null);
  const anyDiffers = compared && outcomes.some((o) => o.same === false);
  const [matched, counted] = sentences(dr.result);
  const differs = s.states.differs;
  const [notMatched, notMatchedCount] = sentences(differs.result);

  // A record that says measured and carries a count that cannot be filled is
  // not measured: the counter's record was missing or unreadable.
  let state = null;
  let countLine = null;
  let reason = null;
  if (record.status === 'measured') {
    const n = record.egressAttempts;
    try {
      if (!Number.isInteger(n) || n < 0) throw new MissingFill('egressAttempts');
      countLine = { text: counted, values: { egressAttempts: fill('{egressAttempts}', { egressAttempts: n }) }, strong: ['egressAttempts'] };
      state = allSame ? 'measured' : anyDiffers ? 'differs' : null;
      if (state === null) { failed.push('decisions not compared'); state = 'not-measured'; reason = null; }
    } catch (err) {
      if (!(err instanceof MissingFill)) throw err;
      state = 'not-measured';
      reason = copy.RULED_EXTRA.offlineNotMeasuredReasons[0];
    }
  } else {
    state = 'not-measured';
    reason = copy.RULED_EXTRA.offlineNotMeasuredReasons.includes(record.reason) ? record.reason : null;
    if (!reason) failed.push('not measured reason');
  }
  if (state === 'not-measured') countLine = reason ? { text: copy.RULED_EXTRA.offlineNotMeasured, values: { reason } } : null;

  if (state === 'measured') {
    const open = record.openRun && record.openRun.egress ? record.openRun.egress : null;
    const subA = Boolean(open && open.status === 'measured' && open.egressAttempts === 0);
    return {
      ...base,
      state,
      eyebrow: name,
      h1: s.h1,
      sub: subA ? s.sub : s.subB,
      subhead: subA ? 'A' : 'B',
      right: { title: dr.title, tone: 'ok', outcome: dr.outcome, result: [{ text: matched }, countLine], why: dr.why, rows },
    };
  }
  if (state === 'differs') {
    return {
      ...base,
      state,
      right: { title: dr.title, tone: differs.tone, outcome: differs.outcome, result: [{ text: notMatched }, { ...countLine, text: notMatchedCount }], why: null, rows },
    };
  }
  // not-measured: the outcome and the opening sentence follow B8.
  let outcome = null;
  let opening = null;
  if (allSame) {
    outcome = dr.outcome;
    opening = { text: matched };
  } else if (anyDiffers) {
    outcome = differs.outcome;
    opening = { text: notMatched };
  }
  return {
    ...base,
    state: 'not-measured',
    right: { title: dr.title, tone: 'neutral', outcome, result: [opening, countLine].filter(Boolean), why: null, rows },
  };
}
