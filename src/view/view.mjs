// The page script: reads the copy, the build and the run on screen from the
// view server, renders the screen the page names, and runs its step when
// asked. Every value it shows comes from the bank's result or state for that
// run (proof.mjs, offline-state.mjs).
//
// main[data-state]: loading, idle (the screen's step has not run in the run
// on screen), running, then one of the terminal states: done, mismatch (a
// copy string the bank's result does not bear out, left empty) or error (the
// server did not answer). The offline screen also carries
// main[data-offline-state].
//
// Presenter keys: Right Arrow or Page Down runs the screen's step if it has
// not run, otherwise goes to the next screen; Left Arrow or Page Up goes back.

import { footerProvenance } from './footer.mjs';
import { offlineState } from './offline-state.mjs';
import { SCREEN_STEP, screenModel, summaryModel } from './proof.mjs';
import { Render } from './screens.mjs';

const ORDER = ['overview', 'setup', 's1', 's2', 's3', 's4', 'offline', 'summary'];
const main = document.getElementById('main');
const id = main.dataset.screen;
const page = { copy: null, fills: null, labels: {}, build: null, result: null, state: null, offline: null, phase: 'loading' };

async function getJson(route) {
  const res = await fetch(route, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function postJson(route, body) {
  const res = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body ?? {}), cache: 'no-store' });
  const json = await res.json().catch(() => null);
  if (res.status !== 200 || !json) throw new Error(`the server answered ${res.status}`);
  return json;
}

const screenOf = (sid) => page.copy.SCREENS.find((s) => s.id === sid);
const hasAction = () => id === 'offline' || Object.hasOwn(SCREEN_STEP, id);

function go(offset) {
  const i = ORDER.indexOf(id) + offset;
  if (i < 0 || i >= ORDER.length) return false;
  window.location.assign(screenOf(ORDER[i]).route);
  return true;
}

// A label's words for one path's step: printable words from that step's own
// labels (L6 follows the scope the bank minted), else none.
function labelText(step, labelId) {
  const l = step && Array.isArray(step.labels) ? step.labels.find((x) => x.id === labelId) : page.labels[labelId];
  return l && l.printable && typeof l.text === 'string' ? l.text : null;
}

function setFooter() {
  const prov = document.querySelector('.footer-prov');
  const run = id !== 'overview' && page.result ? { runId: page.result.runId, ranAtUtc: page.result.ranAtUtc } : null;
  prov.textContent = footerProvenance(page.copy, page.build, run);
}

function setState(state) {
  main.dataset.state = state;
  if (state === 'loading' || state === 'running') main.setAttribute('aria-busy', 'true');
  else main.removeAttribute('aria-busy');
}

function render() {
  const copy = page.copy;
  const s = screenOf(id);
  const r = new Render(copy, page.labels);
  let failed = [];
  if (id === 'overview') {
    main.innerHTML = r.overview(s);
  } else if (id === 'summary') {
    const m = summaryModel(copy, page.state);
    main.innerHTML = r.summary(s, m, page.fills);
    failed = m.failed;
  } else if (id === 'offline') {
    const m = offlineState(copy, page.offline);
    main.innerHTML = r.offline(s, m, page.phase === 'running' ? 'running' : page.offline ? 'done' : 'idle');
    main.dataset.offlineState = m.state;
    failed = m.failed;
  } else {
    const m = screenModel(copy, id, { result: page.result, state: page.state, labelText });
    const steps = page.result && page.result.steps ? page.result.steps : {};
    const step = steps[SCREEN_STEP[id]] || {};
    const labels = id === 'setup' ? [steps.setup ? steps.setup.A?.labels : null, steps.approve ? steps.approve.B?.labels : null] : [step.A?.labels, step.B?.labels];
    const phase = page.phase === 'running' ? 'running' : m.done ? 'done' : 'idle';
    const head = r.head(s.label, s.h1, s.sub, { withSub: 'sub' in s });
    const card = s.card ? r.card(s, m.done ? m : null, phase) : '';
    main.innerHTML = head + card + r.columns(id, m.cols, { labels, approving: page.phase === 'running' });
    failed = m.failed;
    if (page.phase !== 'running') page.phase = m.done ? 'done' : 'idle';
  }
  if (id === 'overview') page.phase = 'done';
  if (id === 'summary') page.phase = 'done';
  if (id === 'offline' && page.phase !== 'running') page.phase = page.offline ? 'done' : 'idle';
  const mismatch = failed.length > 0 || r.missing.length > 0;
  if (mismatch) main.dataset.failed = [...failed, ...r.missing].join('; ');
  else delete main.dataset.failed;
  if (page.phase === 'running') setState('running');
  else if (page.phase === 'idle') setState('idle');
  else setState(mismatch ? 'mismatch' : 'done');
  setFooter();
}

async function run() {
  if (page.phase === 'running' || !hasAction()) return;
  page.phase = 'running';
  render();
  try {
    if (id === 'offline') {
      page.offline = await postJson('/api/offline');
    } else {
      page.result = await postJson('/api/run', { scenario: SCREEN_STEP[id] });
      const st = await getJson('/api/state');
      page.state = st.status === 200 ? st.json.state : null;
    }
    page.phase = 'done';
    render();
  } catch {
    page.phase = 'idle';
    render();
    setState('error');
  }
}

function onKey(e) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || page.phase === 'loading') return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const forward = e.key === 'ArrowRight' || e.key === 'PageDown';
  const backward = e.key === 'ArrowLeft' || e.key === 'PageUp';
  if (!forward && !backward) return;
  // The summary scrolls: Page Down and Page Up keep scrolling it, and Page
  // Up goes back from its top.
  if (id === 'summary' && (e.key === 'PageDown' || (e.key === 'PageUp' && window.scrollY > 0))) return;
  if (forward) {
    if (page.phase === 'running') { e.preventDefault(); return; }
    if (hasAction() && page.phase !== 'done') { e.preventDefault(); run(); return; }
    if (go(1)) e.preventDefault();
    return;
  }
  if (go(-1)) e.preventDefault();
}

main.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !main.contains(el)) return;
  const action = el.dataset.action;
  if (action === 'run') { e.preventDefault(); run(); }
  if (action === 'next' && el.tagName === 'BUTTON') { e.preventDefault(); go(1); }
  if (action === 'back') { e.preventDefault(); go(-1); }
});
document.addEventListener('keydown', onKey);

async function start() {
  const needsState = id === 'setup' || id === 's4' || id === 'summary';
  const [copyAnswer, buildAnswer, resultAnswer, offlineAnswer] = await Promise.all([
    getJson('/api/copy'),
    getJson('/api/build'),
    getJson('/api/result'),
    id === 'offline' ? getJson('/api/offline') : Promise.resolve(null),
  ]);
  if (copyAnswer.status !== 200 || buildAnswer.status !== 200) throw new Error('the copy or the build did not load');
  page.copy = copyAnswer.json.copy;
  page.fills = copyAnswer.json.fills;
  page.labels = Object.fromEntries(copyAnswer.json.labels.map((l) => [l.id, l]));
  page.build = buildAnswer.json.build;
  page.result = resultAnswer.status === 200 ? resultAnswer.json : null;
  page.offline = offlineAnswer && offlineAnswer.status === 200 ? offlineAnswer.json : null;
  if (needsState) {
    const st = await getJson('/api/state');
    page.state = st.status === 200 ? st.json.state : null;
  }
  page.phase = 'idle';
  render();
}

start().catch(() => setState('error'));
