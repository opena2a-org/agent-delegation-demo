// The limit each test cell in a file names for itself, read from the file's
// text as code (./closure.mjs scan: comments are removed, and a string, a
// template or a regular expression is not code). It runs none of it.
//
// A cell is a call of test, it, describe or suite, or of one of their skip,
// todo and focus forms, that is not a property of another object. Its
// options are the argument before its function, or its one argument when
// that is an object literal. Their limit is the timeout they carry: an
// object literal's timeout, spreads included in the order JavaScript reads
// them; a constant the file sets; a call of a helper the file defines, with
// an arrow or a function that returns one value, read with its arguments in
// place of its parameters; or a conditional, read as the larger of its two
// branches. A timeout is a number, or arithmetic over numbers, constants the
// file sets and helpers the file defines. A cell whose options this reading
// cannot evaluate is returned with its limit unread, so a check built on it
// fails closed.

import { scan } from './closure.mjs';

class Unread extends Error {}

const OPEN = '([{';
const CLOSE = ')]}';
const NAME = '[A-Za-z_$][\\w$]*';
const FORMS = ['skip', 'todo', ['on', 'ly'].join('')].join('|');
const CELL = new RegExp(`(?<![\\w$.])(?:test|it|describe|suite)(?:\\.(?:${FORMS}))?\\s*\\(`, 'g');
const DEPTH = 64;

// The text inside the bracket that opens at s[i], and the index past its
// match.
function group(s, i) {
  let depth = 0;
  for (let k = i; k < s.length; k += 1) {
    if (OPEN.includes(s[k])) depth += 1;
    else if (CLOSE.includes(s[k])) {
      depth -= 1;
      if (depth === 0) return [s.slice(i + 1, k), k + 1];
    }
  }
  throw new Unread(s.slice(i).trim());
}

// The parts of a text between the commas outside every bracket.
function split(text) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k < text.length; k += 1) {
    if (OPEN.includes(text[k])) depth += 1;
    else if (CLOSE.includes(text[k])) depth -= 1;
    else if (text[k] === ',' && depth === 0) {
      parts.push(text.slice(from, k));
      from = k + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((p) => p.trim()).filter((p, k, all) => p !== '' || k < all.length - 1);
}

// A text without the brackets that wrap all of it.
function unwrap(text) {
  let t = text.trim();
  while (t.startsWith('(')) {
    const [inner, end] = group(t, 0);
    if (end !== t.length) break;
    t = inner.trim();
  }
  return t;
}

// A conditional outside every bracket: its test and its two branches. A ?
// of ?. or ?? is not one.
function conditional(t) {
  let depth = 0;
  let q = -1;
  let nested = 0;
  for (let k = 0; k < t.length; k += 1) {
    const c = t[k];
    if (OPEN.includes(c)) depth += 1;
    else if (CLOSE.includes(c)) depth -= 1;
    else if (depth === 0 && c === '?') {
      if (t[k + 1] === '?') { k += 1; continue; }
      if (t[k + 1] === '.' && !/\d/.test(t[k + 2] ?? '')) continue;
      if (q < 0) q = k;
      else nested += 1;
    } else if (depth === 0 && c === ':' && q >= 0) {
      if (nested === 0) return [t.slice(0, q), t.slice(q + 1, k), t.slice(k + 1)];
      nested -= 1;
    }
  }
  return null;
}

// The one value a function body returns, or null when it has none or more.
function returned(block) {
  const found = [];
  let depth = 0;
  for (let k = 0; k < block.length; k += 1) {
    const c = block[k];
    if (OPEN.includes(c)) depth += 1;
    else if (CLOSE.includes(c)) depth -= 1;
    else if (depth === 0 && block.startsWith('return', k) && !/[\w$]/.test(block[k - 1] ?? '') && !/[\w$]/.test(block[k + 6] ?? '')) {
      let e = k + 6;
      let d = 0;
      for (; e < block.length; e += 1) {
        if (OPEN.includes(block[e])) d += 1;
        else if (CLOSE.includes(block[e])) d -= 1;
        else if (block[e] === ';' && d === 0) break;
      }
      found.push(block.slice(k + 6, e).trim());
      k = e;
    }
  }
  return found.length === 1 ? found[0] : null;
}

// A parameter's name, or null for a destructured one.
const paramNames = (text) => split(text).map((p) => {
  const m = new RegExp(`^(?:\\.\\.\\.)?(${NAME})\\s*(?:=[\\s\\S]*)?$`).exec(p);
  return m ? m[1] : null;
});

// What a constant's initializer is: a helper with parameters and the value it
// returns, or a value.
function definition(init) {
  const arrow = new RegExp(`^(?:async\\s+)?(?:\\(([^()]*)\\)|(${NAME}))\\s*=>([\\s\\S]*)$`).exec(init);
  if (arrow) {
    const body = arrow[3].trim();
    let value = body;
    if (body.startsWith('{')) {
      try { value = returned(group(body, 0)[0]); } catch { value = null; }
    }
    return { params: paramNames(arrow[1] ?? arrow[2]), body: value };
  }
  const fn = new RegExp(`^(?:async\\s+)?function\\b\\s*\\*?\\s*(?:${NAME})?\\s*\\(`).exec(init);
  if (fn) {
    try {
      const [params, after] = group(init, fn[0].length - 1);
      const open = init.indexOf('{', after);
      return { params: paramNames(params), body: open < 0 ? null : returned(group(init, open)[0]) };
    } catch {
      return { params: [], body: null };
    }
  }
  return { value: init };
}

// Each name the file sets at any level with const, let, var or function. A
// name set more than once is ambiguous, and reading it is unread.
function definitions(src) {
  const defs = new Map();
  const set = (name, def) => defs.set(name, defs.has(name) ? { ambiguous: true } : def);
  for (const m of src.matchAll(new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+(${NAME})\\s*=(?![=>])`, 'g'))) {
    let depth = 0;
    let e = m.index + m[0].length;
    for (; e < src.length; e += 1) {
      if (OPEN.includes(src[e])) depth += 1;
      else if (CLOSE.includes(src[e])) {
        if (depth === 0) break;
        depth -= 1;
      } else if ((src[e] === ';' || src[e] === ',') && depth === 0) break;
    }
    set(m[1], definition(src.slice(m.index + m[0].length, e).trim()));
  }
  for (const m of src.matchAll(new RegExp(`(?<![\\w$.])(?:async\\s+)?function\\s*\\*?\\s*(${NAME})\\s*\\(`, 'g'))) {
    try {
      const [params, after] = group(src, m.index + m[0].length - 1);
      const open = src.slice(after).search(/\S/) + after;
      set(m[1], src[open] === '{' ? { params: paramNames(params), body: returned(group(src, open)[0]) } : { params: [], body: null });
    } catch {
      set(m[1], { params: [], body: null });
    }
  }
  return defs;
}

function reader(src, strings) {
  const defs = definitions(src);

  // A helper called with the arguments given, each read where it was written.
  const call = (name, args, env, d, how) => {
    const def = defs.get(name);
    if (!def || def.ambiguous || !def.params || def.body === null || args.length > def.params.length) throw new Unread(`${name}(${args.join(', ')})`);
    const bound = new Map(def.params.map((p, k) => [p, k < args.length ? { text: args[k], env } : null]));
    return how(def.body, bound, d + 1);
  };
  // A name: a parameter in place, or a constant the file sets.
  const named = (name, env, d, how) => {
    if (env.has(name)) {
      const b = env.get(name);
      if (!b) throw new Unread(name);
      return how(b.text, b.env, d + 1);
    }
    const def = defs.get(name);
    if (!def || def.ambiguous || def.value === undefined) throw new Unread(name);
    return how(def.value, new Map(), d + 1);
  };

  // A number: arithmetic over numbers, names and helper calls.
  function num(text, env, d) {
    if (d > DEPTH) throw new Unread(text.trim());
    const s = text;
    let i = 0;
    const fail = () => { throw new Unread(text.trim()); };
    const space = () => { while (i < s.length && /\s/.test(s[i])) i += 1; };
    const primary = () => {
      space();
      if (s[i] === '(') {
        i += 1;
        const v = sum();
        space();
        if (s[i] !== ')') fail();
        i += 1;
        return v;
      }
      if (s[i] === '-') { i += 1; return -primary(); }
      let m = /^\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w$])/.exec(s.slice(i));
      if (m) { i += m[0].length; return Number(m[0].replaceAll('_', '')); }
      m = new RegExp(`^${NAME}`).exec(s.slice(i));
      if (!m) fail();
      i += m[0].length;
      space();
      if (s[i] === '(') {
        const [inner, end] = group(s, i);
        i = end;
        return call(m[0], split(inner), env, d, num);
      }
      return named(m[0], env, d, num);
    };
    const product = () => {
      let v = primary();
      for (;;) {
        space();
        if (s[i] === '*' && s[i + 1] !== '*') { i += 1; v *= primary(); } else if (s[i] === '/') { i += 1; v /= primary(); } else return v;
      }
    };
    const sum = () => {
      let v = product();
      for (;;) {
        space();
        if (s[i] === '+') { i += 1; v += product(); } else if (s[i] === '-') { i += 1; v -= product(); } else return v;
      }
    };
    const v = sum();
    space();
    if (i !== s.length || !Number.isFinite(v)) fail();
    return v;
  }

  // The timeout an options expression carries, or null when it carries none.
  function limit(text, env, d) {
    if (d > DEPTH) throw new Unread(text.trim());
    const t = unwrap(text);
    if (t.startsWith('{')) {
      const [inner, end] = group(t, 0);
      if (end !== t.length) throw new Unread(t);
      let l = null;
      for (const prop of split(inner)) {
        if (prop.startsWith('...')) {
          const spread = limit(prop.slice(3), env, d + 1);
          if (spread !== null) l = spread;
          continue;
        }
        if (prop === 'timeout') { l = num(prop, env, d + 1); continue; }
        if (prop.startsWith('[')) throw new Unread(t);
        const m = new RegExp(`^(${NAME}|"@(\\d+)")\\s*:([\\s\\S]*)$`).exec(prop);
        if (m && (m[2] === undefined ? m[1] : strings[Number(m[2])]) === 'timeout') l = num(m[3], env, d + 1);
      }
      return l;
    }
    const c = conditional(t);
    if (c) {
      const [a, b] = [limit(c[1], env, d + 1), limit(c[2], env, d + 1)];
      return a === null ? b : b === null ? a : Math.max(a, b);
    }
    if (/^(?:"@\d+"|__template__|null|undefined|true|false)$/.test(t)) return null;
    const m = new RegExp(`^(${NAME})\\s*(\\()?`).exec(t);
    if (m && m[2]) {
      const [inner, end] = group(t, m[0].length - 1);
      if (end === t.length) return call(m[1], split(inner), env, d, limit);
    } else if (m && m[0].trim() === t) {
      return named(m[1], env, d, limit);
    }
    throw new Unread(t);
  }

  return { limit };
}

// Each cell in a file's text: { line, name, limit }, limit in ms or null when
// the cell names none, or { line, name, unread } when its options could not
// be evaluated.
export function cellLimits(text) {
  const { src, strings } = scan(text);
  const { limit } = reader(src, strings);
  const cells = [];
  for (const m of src.matchAll(CELL)) {
    const line = src.slice(0, m.index).split('\n').length;
    let args;
    try {
      args = split(group(src, m.index + m[0].length - 1)[0]);
    } catch (err) {
      cells.push({ line, name: null, unread: err.message });
      continue;
    }
    const lead = /^"@(\d+)"$/.exec(args[0] ?? '');
    const name = lead ? strings[Number(lead[1])] : null;
    const rest = lead || args[0] === '__template__' ? args.slice(1) : args;
    const options = rest.length === 2 ? rest[0]
      : rest.length === 1 && unwrap(rest[0]).startsWith('{') ? rest[0]
      : rest.length <= 1 ? null : undefined;
    if (options === undefined) { cells.push({ line, name, unread: args.join(', ') }); continue; }
    try {
      cells.push({ line, name, limit: options === null ? null : limit(options, new Map(), 0) });
    } catch (err) {
      if (!(err instanceof Unread)) throw err;
      cells.push({ line, name, unread: err.message || options });
    }
  }
  return cells;
}
