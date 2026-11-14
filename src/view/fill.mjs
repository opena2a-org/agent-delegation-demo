// Text for the page: every string is escaped, and every {name} in it is
// filled from the values given or not at all. There is no default for any
// fill: a missing, null or empty value throws MissingFill where the string
// is rendered, and the screen decides what that means for its state.
// Used by the page and by the view server.

export class MissingFill extends Error {
  constructor(name) {
    super(`no value for {${name}}`);
    this.name = 'MissingFill';
    this.fill = name;
  }
}

const FILL = /\{([A-Za-z0-9]+)\}/g;

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Plain text with every fill in place.
export function fill(text, values = {}) {
  return String(text).replace(FILL, (_, k) => {
    const v = values[k];
    if (v === undefined || v === null || v === '') throw new MissingFill(k);
    return String(v);
  });
}

// Field keys, package names, identifiers and commit hashes are set in the
// mono face, as in the reference stylesheet.
const CODE = /(creditorAccounts|maximumIndividualAmount|periodicLimits|validToDateTime|atx-verify [0-9][0-9.]*|secretless-ai|aap-conformance|customer\.[ab]\b|demo_[a-z]+_agent|grant:\/\/g-[0-9a-f]+|at commit [0-9a-f]{12})/g;

function codeTokens(html) {
  return html.replace(CODE, (m) => (m.startsWith('at commit ') ? `at commit <code>${m.slice(10)}</code>` : `<code>${m}</code>`));
}

// Escaped HTML with every fill in place; the fills named in strong are set
// in bold (the counted value on the offline screen).
export function html(text, values = {}, strong = []) {
  const filled = esc(text).replace(FILL, (_, k) => {
    const v = values[k];
    if (v === undefined || v === null || v === '') throw new MissingFill(k);
    return strong.includes(k) ? `<b>${esc(v)}</b>` : esc(v);
  });
  return codeTokens(filled);
}
