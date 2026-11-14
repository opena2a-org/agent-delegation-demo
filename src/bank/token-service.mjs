// The bank's token service: the OAuth 2.0 token exchange endpoint (RFC 8693)
// the bank's broker calls. It accepts a broker token under the accept rule
// in verifier.mjs, once per jti, and then issues a random, single
// use access token for the bank's payment API. The access token never leaves
// the bank: the broker uses it on the agent's behalf.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { readBody, sendJson } from '../http.mjs';
import { verifyBrokerToken } from './verifier.mjs';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_TYPE = 'urn:ietf:params:oauth:token-type:jwt';
const ACCESS_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const ACCESS_TTL_SECONDS = 60;

function decodePayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export class TokenService {
  // onIssue, when given, is called with every access token this service issues.
  constructor({ key, audience, verifyPath, workDir, verifierEnv, jtiFile, now = () => Date.now(), onIssue = null }) {
    this.key = key; // { kid, publicJwk }: the current run's broker key, and no other
    this.audience = audience;
    this.verifyPath = verifyPath;
    this.workDir = workDir;
    this.verifierEnv = verifierEnv;
    this.jtiFile = jtiFile;
    this.now = now;
    this.onIssue = onIssue;
    this.issued = new Map();
    this.exchanges = [];
    // The jti store is a file, read back at start, so a replay is refused
    // across a restart of the broker or of this service.
    this.seen = new Set();
    if (fs.existsSync(jtiFile)) {
      for (const line of fs.readFileSync(jtiFile, 'utf8').split('\n')) if (line) this.seen.add(line);
    }
  }

  remember(jti) {
    this.seen.add(jti);
    fs.appendFileSync(this.jtiFile, `${jti}\n`, { mode: 0o600 });
  }

  record(entry) {
    this.exchanges.push({ time: new Date(this.now()).toISOString(), ...entry });
  }

  async exchange(params) {
    if (params.get('grant_type') !== GRANT_TYPE || params.get('subject_token_type') !== JWT_TYPE) {
      this.record({ accepted: false, code: 'request' });
      return null;
    }
    const requested = params.get('requested_token_type');
    if (requested && requested !== ACCESS_TYPE) {
      this.record({ accepted: false, code: 'request' });
      return null;
    }
    const token = params.get('subject_token') ?? '';
    const nowSeconds = Math.floor(this.now() / 1000);
    const v = await verifyBrokerToken({
      token,
      nowSeconds,
      key: this.key,
      verifyPath: this.verifyPath,
      workDir: this.workDir,
      env: this.verifierEnv,
    });
    const claims = decodePayload(token);
    if (!v.accepted || !claims) {
      this.record({ accepted: false, code: v.code === 'ran' ? 'verifier' : v.code });
      return null;
    }
    const base = { jti: claims.jti, sub: claims.sub, scope: claims.scope, aud: claims.aud };
    if (this.seen.has(claims.jti)) {
      this.record({ ...base, accepted: false, code: 'replay' });
      return null;
    }
    this.remember(claims.jti);
    if (claims.aud !== this.audience || params.get('audience') !== this.audience || claims.scope !== params.get('scope')) {
      this.record({ ...base, accepted: false, code: 'audience or scope' });
      return null;
    }
    const accessToken = crypto.randomBytes(32).toString('hex');
    this.issued.set(accessToken, { ...base, exp: nowSeconds + ACCESS_TTL_SECONDS });
    if (this.onIssue) this.onIssue(accessToken);
    this.record({ ...base, accepted: true, code: 'issued', claims });
    return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, issued_token_type: ACCESS_TYPE };
  }

  // Single use: a presented access token is removed whatever happens next.
  redeem(accessToken) {
    if (typeof accessToken !== 'string') return null;
    const t = this.issued.get(accessToken);
    if (!t) return null;
    this.issued.delete(accessToken);
    if (t.exp < Math.floor(this.now() / 1000)) return null;
    return t;
  }

  handler() {
    return async (req, res) => {
      if (req.method !== 'POST' || new URL(req.url, 'http://127.0.0.1').pathname !== '/token') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      try {
        const params = new URLSearchParams(await readBody(req, 16 * 1024));
        const out = await this.exchange(params);
        if (!out) {
          sendJson(res, 400, { error: 'invalid_grant' });
          return;
        }
        sendJson(res, 200, out);
      } catch {
        sendJson(res, 400, { error: 'invalid_request' });
      }
    };
  }

  // What the dispute and data checks may read: claims and decisions, never a
  // token string.
  evidence() {
    return this.exchanges.map((e) => ({ ...e }));
  }
}
