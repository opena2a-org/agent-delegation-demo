// The bank's token service checks every broker token with the reference
// Node.js verifier from aap-conformance, vendored unmodified, run once per
// check as `node verify.mjs <input file>`.
//
// The verifier's exit status says whether its verdict matched the input
// file's expected outcome, not whether the token was accepted. So the bank
// accepts when all of these hold, and refuses otherwise:
//   - the input file it wrote names a cgt fixture, expects ACCEPT, carries
//     the bank's current time as an integer and exactly the run's broker key;
//   - the verifier exits 0;
//   - exactly one stdout line, after trimming, begins with `observed:`, and that line is `observed: ACCEPT`;
//   - stdout carries the line "summary: 1 pass, 0 fail (1 fixtures)".
// Anything else, a timeout or a crash, is a refusal.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EXPECTED_RESULT = 'ACCEPT';
const SUMMARY = 'summary: 1 pass, 0 fail (1 fixtures)';

// The one function that writes verifier input.
export function verifierInput({ token, nowSeconds, key }) {
  return {
    fixtureType: 'cgt',
    tokenForm: 'compact',
    verifierState: {
      clockNumericDate: nowSeconds,
      keys: [{ kid: key.kid, publicJwk: key.publicJwk }],
    },
    expected: { verifyResult: EXPECTED_RESULT },
    token,
  };
}

export function inputIsSound(input, { nowSeconds, key }) {
  if (!input || typeof input !== 'object') return false;
  if (input.fixtureType !== 'cgt') return false;
  if (!input.expected || input.expected.verifyResult !== EXPECTED_RESULT) return false;
  const st = input.verifierState;
  if (!st || !Number.isInteger(st.clockNumericDate) || st.clockNumericDate !== nowSeconds) return false;
  if (!Array.isArray(st.keys) || st.keys.length !== 1) return false;
  if (st.keys[0].kid !== key.kid) return false;
  if (JSON.stringify(st.keys[0].publicJwk) !== JSON.stringify(key.publicJwk)) return false;
  return typeof input.token === 'string' && input.token.length > 0;
}

export function acceptRule({ exitCode, stdout }) {
  if (exitCode !== 0 || typeof stdout !== 'string') return false;
  const lines = stdout.split('\n').map((l) => l.trim());
  const observed = lines.filter((l) => l.startsWith('observed:'));
  if (observed.length !== 1 || observed[0] !== `observed: ${EXPECTED_RESULT}`) return false;
  return lines.includes(SUMMARY);
}

export function runVerifier({ verifyPath, inputFile, cwd, env, timeoutMs = 10000, maxStdout = 64 * 1024 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [verifyPath, inputFile], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let over = false;
    child.stdout.on('data', (c) => {
      if (stdout.length + c.length > maxStdout) {
        over = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += c.toString('utf8');
    });
    child.stderr.resume();
    const timer = setTimeout(() => {
      over = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: '', failed: 'spawn' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(over ? { exitCode: null, stdout: '', failed: 'limit' } : { exitCode: code, stdout });
    });
  });
}

// Write the input, check what was written, run the verifier, apply the
// accept rule, and delete the input file (it holds the token).
export async function verifyBrokerToken({ token, nowSeconds, key, verifyPath, workDir, env }) {
  const input = verifierInput({ token, nowSeconds, key });
  const file = path.join(workDir, `${crypto.randomBytes(8).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  try {
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!inputIsSound(written, { nowSeconds, key })) return { accepted: false, code: 'input' };
    const out = await runVerifier({ verifyPath, inputFile: file, cwd: workDir, env });
    return { accepted: acceptRule(out), code: out.failed ?? (out.exitCode === 0 ? 'ran' : 'exit') };
  } finally {
    fs.rmSync(file, { force: true });
  }
}
