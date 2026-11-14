// The markup of each screen, from the copy and a screen model. A slot whose
// text is null renders empty and keeps its place: data-mismatch when the
// bank's result does not bear the copy out, data-pending when its words are
// not set yet. A fill with no value renders nothing and is recorded.

import { MissingFill, esc, html } from './fill.mjs';
import { ICON } from './icons.mjs';

export class Render {
  constructor(copy, labelTexts) {
    this.copy = copy;
    this.labelTexts = labelTexts; // id -> { text, printable }
    this.missing = []; // fills with no value, and labels that may not print
    this.quiet = false;
  }

  // Escaped text with its fills, or '' with the fill recorded.
  t(text, values = {}, strong = []) {
    if (text === null || text === undefined) return '';
    try {
      return html(text, values, strong);
    } catch (err) {
      if (!(err instanceof MissingFill)) throw err;
      this.missing.push(`{${err.fill}}`);
      return '';
    }
  }

  // An empty slot's marker: data-pending with the key of words not set yet,
  // or data-mismatch where the bank's result does not bear the copy out. A
  // column that has not run yet, and the offline screen, whose model keeps
  // its own record of what failed, mark no mismatch.
  m(text, pendingKey) {
    if (text !== null && text !== undefined) return '';
    if (pendingKey) return ` data-pending="${esc(pendingKey)}"`;
    return this.quiet ? '' : ' data-mismatch=""';
  }

  why(text, values) {
    const f = this.t(text, values);
    return f.startsWith('Why:') ? `<b>Why:</b>${f.slice(4)}` : f;
  }

  // A note: a label prints in the words the server gives for it, when they
  // may be printed; any other note prints as the copy has it.
  note(text, stepLabels) {
    const id = Object.keys(this.copy.LABELS).find((k) => this.copy.LABELS[k] === text);
    if (!id) return `<div class="note">${ICON.info}<span>${this.t(text)}</span></div>`;
    const fromStep = Array.isArray(stepLabels) ? stepLabels.find((l) => l.id === id) : null;
    const l = fromStep || this.labelTexts[id];
    if (!l || !l.printable || typeof l.text !== 'string') {
      this.missing.push(`label ${id}`);
      return '';
    }
    return `<div class="note" data-label="${esc(id)}">${ICON.info}<span>${this.t(l.text)}</span></div>`;
  }

  notes(list, stepLabels, cls = 'notes') {
    if (!list || !list.length) return '<div></div>';
    return `<div class="${cls}">${list.map((n) => this.note(n, stepLabels)).join('')}</div>`;
  }

  tile(c) {
    const tone = (c.outcome === null || c.outcome === undefined) && !c.outcomePending ? 'neutral' : c.tone;
    const label = c.tileLabel ? `<div class="tilelabel">${this.t(c.tileLabel)}</div>` : '';
    return `<div class="tile tone-${esc(tone)}"><span class="icontile">${ICON[tone]}</span><div>${label}<div class="outcome"${this.m(c.outcome, c.outcomePending)}>${this.t(c.outcome)}</div></div></div>`;
  }

  result(c) {
    if (Array.isArray(c.result)) {
      const parts = c.result.filter(Boolean);
      const marks = parts.filter((p) => p.text === null || p.text === undefined).map((p) => p.pending || 'mismatch');
      const text = parts.map((p) => this.t(p.text, p.values, p.strong)).filter(Boolean).join(' ');
      const attr = marks.length ? (marks.every((m) => m !== 'mismatch') ? ` data-pending="${esc(marks.join(' '))}"` : ' data-mismatch=""') : '';
      return `<p class="result"${attr}>${text}</p>`;
    }
    return `<p class="result"${this.m(c.result, c.resultPending)}>${this.t(c.result, c.values)}</p>`;
  }

  checks(c) {
    if (c.checks) {
      return `<div class="checks">${c.checks.map(([k, v]) => (v === null
        ? `<div class="check" data-mismatch=""><code>${esc(k)}</code></div>`
        : `<div class="check ${v === 'passed' ? 'ok' : 'warn'}">${v === 'passed' ? ICON.ok : ICON.warn}<code>${esc(k)}</code><span class="w">${this.t(this.copy.GLOBAL.checkWords[v] ?? v)}</span></div>`)).join('')}</div>`;
    }
    if (c.checksA) return `<div class="checksA">${this.t(c.checksA)}</div>`;
    return '';
  }

  whyBlock(c) {
    return `<div><p class="why"${this.m(c.why)}>${this.why(c.why, c.values)}</p>${this.checks(c)}</div>`;
  }

  rows(rows, cls = 'rows', values = {}) {
    return `<dl class="${cls}">${rows.map(([k, v, tone, pendingKey]) => {
      const icon = v !== null && v !== undefined && tone ? ICON[tone] : '';
      return `<dt>${this.t(k)}</dt><dd class="${v !== null && v !== undefined && tone ? esc(tone) : ''}"${this.m(v, pendingKey)}>${icon}<span>${this.t(v, values)}</span></dd>`;
    }).join('')}</dl>`;
  }

  kv(rows, values = {}) {
    return `<dl class="kv">${rows.map(([k, v]) => `<dt>${this.t(k)}</dt><dd${this.m(v)}>${this.t(v, values)}</dd>`).join('')}</dl>`;
  }

  setupPanel(c, approving) {
    const p = c.panel;
    if (!p.formTitle && !('approve' in p) && p.fields === undefined) return `<div class="panel"><div class="panel-head">${this.t(p.title)}</div></div>`;
    if (c.side === 'A') {
      const body = p.fields ? this.kv(p.fields, c.values) : '';
      return `<div class="panel"><div class="panel-head">${this.t(p.title)}</div><div class="panel-body">${body}</div></div>`;
    }
    const button = p.approve
      ? `<div class="panel-action"><button type="button" class="btn primary" data-action="run"${approving ? ' disabled' : ''}>${esc(approving ? this.copy.GLOBAL.buttons.running : this.copy.GLOBAL.buttons.approve)}</button></div>`
      : '';
    const fields = p.fields ? this.kv(p.fields, c.values) : '';
    const also = p.also !== undefined ? `<div class="panel-note"${this.m(p.also)}>${this.t(p.also)}</div>` : '';
    return `<div class="panel"><div class="panel-head">${this.t(p.title)}</div><div class="panel-body"><div class="form-title"${this.m(p.formTitle)}>${this.t(p.formTitle)}</div>${fields}${button}${also}</div></div>`;
  }

  actionPanel(c) {
    const p = c.panel;
    if (!('action' in p)) return `<div class="panel"><div class="panel-head">${this.t(p.title)}</div><div class="panel-body"></div></div>`;
    const status = 'status' in p
      ? `<div class="panel-note"${this.m(p.status) || this.m(p.statusMeasured)}>${[this.t(p.status), this.t(p.statusMeasured, c.values)].filter(Boolean).join(' ')}</div>`
      : '';
    const note = 'note' in p ? `<div class="panel-note"${this.m(p.note)}>${this.t(p.note)}</div>` : '';
    return `<div class="panel"><div class="panel-head">${this.t(p.title)}</div><div class="panel-body"><span class="pa"${this.m(p.action)}>${this.t(p.action)}</span><span${this.m(p.done)}>${this.t(p.done)}</span>${status}${note}</div></div>`;
  }

  evidence(c) {
    if (c.log) {
      const l = c.log;
      const logRows = l.rows.map((r) => `<tr>${r.map((x, i) => `<td${i === 2 ? this.m(x) : ''}>${this.t(x, c.values)}</td>`).join('')}</tr>`).join('');
      const missing = l.missing.map(([k, v]) => `<dt>${this.t(k)}</dt><dd${this.m(v)}>${v === null ? '' : ICON.warn}<span>${this.t(v)}</span></dd>`).join('');
      return `<div class="panel record"><div class="panel-head">${this.t(l.title)}</div><div class="panel-body"><table class="log">${logRows}</table></div><div class="panel-head">${this.t(l.missingTitle)}</div><div class="panel-body"><dl class="kv missing">${missing}</dl></div></div>`;
    }
    if (c.record) {
      const r = c.record;
      return `<div class="panel record"><div class="panel-head">${this.t(r.signed.title)}</div><div class="panel-body">${this.kv(r.signed.rows, c.values)}</div><div class="panel-head">${this.t(r.ledger.title)}</div><div class="panel-body">${this.kv(r.ledger.rows, c.values)}</div></div>`;
    }
    let out = '';
    if (c.panel) out += this.actionPanel(c);
    if (c.rows) out += this.rows(c.rows, c.panel ? 'rows after-panel' : 'rows', c.values);
    return `<div>${out}</div>`;
  }

  columns(id, cols, { labels = [], approving = false } = {}) {
    return `<section class="cols" aria-live="polite">${cols.map((c, i) => {
      const stepLabels = labels[i];
      this.quiet = Boolean(c.notRun);
      const parts = id === 'setup'
        ? [`<h2 class="coltitle">${this.t(c.title)}</h2>`, this.setupPanel(c, approving), this.tile(c), this.result(c), this.whyBlock(c), this.notes(c.notes, stepLabels)]
        : [`<h2 class="coltitle">${this.t(c.title)}</h2>`, this.tile(c), this.result(c), this.whyBlock(c), this.evidence(c), this.notes(c.notes, stepLabels)];
      this.quiet = false;
      return `<article class="col" data-side="${esc(c.side)}">${parts.join('')}</article>`;
    }).join('')}</section>`;
  }

  // The task card and its two buttons: before the run, Back and the run
  // button; while it runs, the run button reads Running; after it, Run again
  // and Next.
  card(screen, model, phase) {
    const c = screen.card;
    const b = this.copy.GLOBAL.buttons;
    const text = model && model.card !== undefined ? (typeof model.card === 'object' && model.card !== null ? model.card.text : model.card) : c.text;
    const hiddenText = model && model.card && typeof model.card === 'object' ? model.card.hiddenText : c.hiddenText;
    const hidden = c.hiddenLabel ? `<div class="hiddenline"><div class="hl">${this.t(c.hiddenLabel)}</div><div class="ht"${this.m(hiddenText)}>${this.t(hiddenText)}</div></div>` : '';
    const after = phase === 'done';
    const left = after ? `<button type="button" class="btn secondary" data-action="run">${esc(b.again)}</button>` : `<button type="button" class="btn secondary" data-action="back">${esc(b.back)}</button>`;
    const right = after
      ? `<button type="button" class="btn primary" data-action="next">${esc(b.next)}</button>`
      : `<button type="button" class="btn primary" data-action="run"${phase === 'running' ? ' disabled' : ''}>${esc(phase === 'running' ? b.running : c.button)}</button>`;
    return `<section class="task"><div class="task-text"><div class="task-label">${this.t(c.label)}</div><div class="task-body"${this.m(text)}>${this.t(text)}</div>${hidden}</div>${left}${right}</section>`;
  }

  head(eyebrow, h1, sub, { withSub = true } = {}) {
    return `<div class="label">${this.t(eyebrow)}</div><h1>${this.t(h1)}</h1>${withSub ? `<p class="sub">${this.t(sub)}</p>` : ''}`;
  }

  overview(s) {
    return `<h1>${this.t(s.h1)}</h1><p class="lead">${this.t(s.lead)}</p><p class="answer">${this.t(s.answer)}</p>`
      + `<section class="pathcards">${s.pathCards.map((p) => `<article class="pathcard" data-side="${esc(p.side)}"><h2>${this.t(p.title)}</h2><p>${this.t(p.body)}</p>${this.notes(p.notes)}</article>`).join('')}</section>`
      + `<section class="scards">${s.scenarioCards.map(([h, p], i) => {
        // Each card opens its own screen: the four scenarios, then the offline check.
        const target = this.copy.SCREENS.find((x) => x.id === ['s1', 's2', 's3', 's4', 'offline'][i]);
        const inner = `<h3>${this.t(h)}</h3><p>${this.t(p)}</p>`;
        return target ? `<a class="scard" href="${esc(target.route)}">${inner}</a>` : `<article class="scard">${inner}</article>`;
      }).join('')}</section>`
      + `<div class="actions"><a class="btn primary" href="/setup" data-action="next">${this.t(s.button)}</a></div>`;
  }

  summary(s, model, fills) {
    const tb = s.table;
    const rows = model.rows.map((r) => `<tr><td>${this.t(r[0])}</td><td class="warn"><span class="c">${ICON.warn}<span>${this.t(r[1])}</span></span></td><td class="ok"${this.m(r[2])}><span class="c">${r[2] === null ? '' : ICON.ok}<span>${this.t(r[2])}</span></span></td></tr>`).join('');
    const code = s.cta.selfCode.map((x) => this.t(x, fills)).join('\n');
    const limits = s.limits.items.map((i) => {
      const id = Object.keys(this.copy.LABELS).find((k) => this.copy.LABELS[k] === i);
      if (!id) return `<li>${this.t(i, fills)}</li>`;
      const l = this.labelTexts[id];
      if (!l || !l.printable) { this.missing.push(`label ${id}`); return ''; }
      return `<li data-label="${esc(id)}">${this.t(l.text)}</li>`;
    }).join('');
    return `<h1>${this.t(s.h1)}</h1><p class="sub">${this.t(s.sub)}</p>`
      + `<table class="recap"><thead><tr>${tb.head.map((h) => `<th scope="col">${this.t(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`
      + `<p class="claim">${this.t(s.claim)}</p>`
      + `<section class="cta"><div class="ct"><h2>${this.t(s.cta.h2)}</h2><p>${this.t(s.cta.text)}</p></div><div class="btns"><a class="btn primary" href="${esc(s.cta.mailto)}">${this.t(s.cta.primary)}</a><a class="btn secondary" href="#run-it-yourself">${this.t(s.cta.secondary)}</a></div></section>`
      + `<section class="self" id="run-it-yourself"><p>${this.t(s.cta.selfLead)}</p><pre>${code}</pre></section>`
      + `<section class="limits" id="limits"><h2>${this.t(s.limits.h2)}</h2><ul>${limits}</ul></section>`;
  }

  offline(s, m, phase) {
    this.quiet = true;
    const cols = [m.left, m.right].map((c) => `<article class="col" data-side="B"><h2 class="coltitle">${this.t(c.title)}</h2>${this.tile(c)}${this.result(c)}<div><p class="why">${this.why(c.why)}</p></div>${this.rows(c.rows)}<div></div></article>`).join('');
    const shared = `<div class="notes shared">${s.sharedNotes.map((n) => this.note(n)).join('')}</div>`;
    this.quiet = false;
    return this.head(m.eyebrow, m.h1, m.sub) + this.card(s, null, phase) + `<section class="cols" aria-live="polite">${cols}</section>` + shared;
  }
}
