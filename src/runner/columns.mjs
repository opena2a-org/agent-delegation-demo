// Two columns of plain text, wrapped at word boundaries, for the text runner.

export const COL = 46;

export function wrap(text, width = COL) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(line);
  }
  return out;
}

export function sideBySide(rows, [leftTitle, rightTitle] = ['Password path', 'Grant path']) {
  const lines = [];
  lines.push(`  ${leftTitle.padEnd(COL)}   ${rightTitle}`);
  lines.push(`  ${'-'.repeat(COL)}   ${'-'.repeat(COL)}`);
  for (const [a, b] of rows) {
    const left = wrap(a);
    const right = wrap(b);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      lines.push(`  ${(left[i] ?? '').padEnd(COL)}   ${right[i] ?? ''}`.trimEnd());
    }
  }
  return lines.join('\n');
}
