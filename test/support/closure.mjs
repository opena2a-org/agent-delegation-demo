// A reader of the repository's JavaScript as code, and the import closure of
// a file over the files tracked at the head. It reads text and runs none of
// it. The lexing rules are the ones test/launcher-boundary.test.mjs uses for
// the launcher's graph: comments are removed, each string literal is
// replaced by "@<n>" (its value is strings[n]), each template literal with a
// ${...} part by __template__ and each regular expression literal by
// __regex__, so an import( or require( inside a string, a comment or a
// pattern is not code. Each literal is also kept with its line, a template's
// ${...} parts written as ${} and their expressions kept in order, for the
// walks that read profile text and stand in lines.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function scan(text) {
  let src = '';
  const strings = [];
  const literals = [];
  let i = 0;
  let line = 1;
  const advance = (to) => {
    for (let k = i; k < to && k < text.length; k += 1) if (text[k] === '\n') line += 1;
    i = to;
  };
  const regexMayStart = () => {
    const before = src.trimEnd();
    return before === '' || '(,=:[!&|?{};+-*%<>~^'.includes(before.at(-1)) || /\b(return|typeof|case|in|of|delete|void|throw|new|await|yield)$/.test(before);
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < text.length && text[j] !== '\n') j += 1;
      advance(j);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const lines = text.slice(i, e < 0 ? text.length : e + 2).split('\n').length - 1;
      advance(e < 0 ? text.length : e + 2);
      src += lines > 0 ? '\n'.repeat(lines) : ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      const at = line;
      let j = i + 1;
      let v = '';
      while (j < text.length && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') { v += text[j + 1] ?? ''; j += 2; } else { v += text[j]; j += 1; }
      }
      strings.push(v);
      literals.push({ line: at, value: v, template: false });
      src += `"@${strings.length - 1}"`;
      advance(j + 1);
      continue;
    }
    if (c === '`') {
      const at = line;
      let j = i + 1;
      let v = '';
      let raw = '';
      let depth = 0;
      let parts = false;
      const exprs = [];
      while (j < text.length) {
        if (text[j] === '\\') {
          if (depth === 0) { v += text[j + 1] ?? ''; raw += text.slice(j, j + 2); } else exprs[exprs.length - 1] += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (depth === 0 && text[j] === '`') break;
        if (text[j] === '$' && text[j + 1] === '{') {
          parts = true;
          if (depth === 0) { v += '${}'; raw += '${}'; exprs.push(''); } else exprs[exprs.length - 1] += '${';
          depth += 1;
          j += 2;
          continue;
        }
        if (depth > 0 && text[j] === '{') depth += 1;
        if (depth > 0 && text[j] === '}') {
          depth -= 1;
          if (depth > 0) exprs[exprs.length - 1] += '}';
          j += 1;
          continue;
        }
        if (depth === 0) { v += text[j]; raw += text[j]; } else exprs[exprs.length - 1] += text[j];
        j += 1;
      }
      literals.push({ line: at, value: v, raw, template: true, parts, exprs: exprs.map((e) => e.trim()) });
      if (parts) src += '__template__';
      else { strings.push(v); src += `"@${strings.length - 1}"`; }
      const lines = text.slice(i, j + 1).split('\n').length - 1;
      advance(j + 1);
      if (lines > 0) src += '\n'.repeat(lines);
      continue;
    }
    if (c === '/' && regexMayStart()) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j += 1;
      }
      j += 1;
      while (j < text.length && /[a-z]/i.test(text[j])) j += 1;
      src += ' __regex__ ';
      advance(j);
      continue;
    }
    src += c;
    advance(i + 1);
  }
  return { src, strings, literals };
}

// Every specifier a file names: static import and export ... from, a bare
// import, dynamic import(), require(), and a createRequire(...)(...) call
// whose argument is a constant the file sets to path.join(ROOT, '<file>'),
// with ROOT the repository root. A call whose argument is not a literal is
// returned as nonLiteral.
export function specifiers(text, file, root) {
  const { src, strings } = scan(text);
  const literal = (arg) => {
    const m = /^\s*"@(\d+)"\s*$/.exec(arg);
    return m ? strings[Number(m[1])] : null;
  };
  const found = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\b[^;"]*?\bfrom\s*"@(\d+)"/gm)) found.push({ spec: strings[Number(m[1])], static: true });
  for (const m of src.matchAll(/^\s*import\s*"@(\d+)"/gm)) found.push({ spec: strings[Number(m[1])], static: true });
  for (const m of src.matchAll(/(?<![.\w$])import\s*\(([^()]*)\)/g)) {
    const s = literal(m[1]);
    found.push(s === null ? { nonLiteral: `import(${m[1].trim()})` } : { spec: s });
  }
  for (const m of src.matchAll(/(?<![.\w$])require\s*\(([^()]*)\)/g)) {
    const s = literal(m[1]);
    found.push(s === null ? { nonLiteral: `require(${m[1].trim()})` } : { spec: s });
  }
  for (const m of src.matchAll(/\bcreateRequire\s*\([^()]*\)\s*\(([^()]*)\)/g)) {
    const arg = m[1].trim();
    const s = literal(arg);
    if (s !== null) { found.push({ spec: s }); continue; }
    const bound = /^[A-Za-z_$][\w$]*$/.test(arg) ? new RegExp(`\\bconst\\s+${arg}\\s*=\\s*path\\.join\\(\\s*ROOT\\s*,\\s*"@(\\d+)"\\s*\\)`).exec(src) : null;
    const rootDecl = /\bconst\s+ROOT\s*=\s*path\.resolve\(\s*path\.dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)\s*,\s*"@(\d+)"\s*\)/.exec(src);
    const rootDir = rootDecl ? path.resolve(path.dirname(path.join(root, file)), strings[Number(rootDecl[1])]) : null;
    if (bound && rootDir === root) found.push({ file: strings[Number(bound[1])] });
    else found.push({ nonLiteral: `createRequire(...)(${arg})` });
  }
  return found;
}

// The leading import declaration of a file, as its specifier, or null.
export function leadingImport(text) {
  const { src, strings } = scan(text);
  const m = /^\s*import\b[^;"]*?(?:\bfrom\s*)?"@(\d+)"/.exec(src);
  return m ? strings[Number(m[1])] : null;
}

// The files tracked at the head, repository relative, with / separators.
export function trackedFiles(root) {
  return new Set(execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean));
}

// The import closure of a tracked file: every file it reaches through
// relative specifiers, each bare specifier other than a node: built-in, each
// import or require whose argument is not a literal, and each relative
// specifier that resolves to no tracked file. read lets a check hand in a
// changed text for a file.
export function closureOf(entry, { root, tracked, read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8') }) {
  const files = [];
  const bare = [];
  const computed = [];
  const missing = [];
  const todo = [entry];
  while (todo.length) {
    const f = todo.shift();
    if (files.includes(f)) continue;
    files.push(f);
    if (f.endsWith('.json')) continue;
    for (const s of specifiers(read(f), f, root)) {
      if (s.nonLiteral) { computed.push(`${f}: ${s.nonLiteral}`); continue; }
      let target = s.file ?? null;
      if (!target) {
        if (s.spec.startsWith('node:')) continue;
        if (!s.spec.startsWith('./') && !s.spec.startsWith('../') && !s.spec.startsWith('/')) { bare.push(`${f}: ${s.spec}`); continue; }
        target = s.spec.startsWith('/') ? path.relative(root, s.spec) : path.posix.normalize(path.posix.join(path.posix.dirname(f), s.spec));
      }
      target = target.split(path.sep).join('/');
      if (!tracked.has(target)) { missing.push(`${f}: ${s.spec ?? target}`); continue; }
      todo.push(target);
    }
  }
  return { files, bare, computed, missing };
}
