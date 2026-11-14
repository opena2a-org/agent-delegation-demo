// The grant path inside the bank process: the consent routes the customer
// uses, the bank's broker, its token service and its payment API.
//
// Flow for one agent operation: the agent posts its own credential, a grant
// name and the operation to the broker's Unix socket. The broker verifies the
// credential, matches the grant, signs a short lived token naming the agent,
// the bank service and the consent, and exchanges it at the token service
// for a single use access token. The broker then calls the payment API with
// that token. The agent never holds the token the broker signs or the access
// token; the one bank value it holds is the broker token every request to the
// broker carries.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { LocalAtxVerifier } from '@opena2a/atx-verify';
import { GRANT_TTL_SECONDS, TRUST_CLASS } from '../config.mjs';
import { bearer, close, listen, readJson, sendJson } from '../http.mjs';
import { childEnv } from '../orchestrator/env.mjs';
import { BankBroker, PROVIDER_ID, jwkThumbprint, loadTrust, makeSigningKey } from './broker.mjs';
import { parseCents } from './money.mjs';
import { resourceHandler } from './resource.mjs';
import { TokenService } from './token-service.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// The consent terms a customer may set, checked for shape. Anything else is
// refused rather than repaired.
export function normalizeTerms(t) {
  if (!t || typeof t !== 'object') return null;
  const strings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');
  if (!strings(t.permissions) || !strings(t.creditorAccounts)) return null;
  if (typeof t.validToDateTime !== 'string' || !ISO.test(t.validToDateTime)) return null;
  const money = (m) => m && typeof m === 'object' && typeof m.currency === 'string' && (() => {
    try { parseCents(m.amount); return true; } catch { return false; }
  })();
  if (t.maximumIndividualAmount !== null && !money(t.maximumIndividualAmount)) return null;
  if (!Array.isArray(t.periodicLimits)) return null;
  for (const l of t.periodicLimits) {
    if (!money(l) || l.periodType !== 'Month' || l.periodAlignment !== 'Calendar') return null;
  }
  return {
    permissions: [...t.permissions],
    creditorAccounts: [...t.creditorAccounts],
    maximumIndividualAmount: t.maximumIndividualAmount ? { amount: t.maximumIndividualAmount.amount, currency: t.maximumIndividualAmount.currency } : null,
    periodicLimits: t.periodicLimits.map((l) => ({ periodType: l.periodType, periodAlignment: l.periodAlignment, amount: l.amount, currency: l.currency })),
    validToDateTime: t.validToDateTime,
  };
}

export async function startPathB(ctx, params) {
  const { bankDir, sockDir, ports, repoRoot, evidenceDir } = params;
  const pins = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vendor/pins.json'), 'utf8'));
  const trust = loadTrust(path.join(repoRoot, 'fixtures/issuer/trust.json'));
  const atxVerifier = new LocalAtxVerifier(trust);
  const signing = makeSigningKey();
  const audience = `http://127.0.0.1:${ports.resource}`;
  const tokenEndpoint = `http://127.0.0.1:${ports.token}/token`;
  const verifierDir = path.join(bankDir, 'verifier');
  fs.mkdirSync(verifierDir, { recursive: true, mode: 0o700 });

  // A test run asks for the witness at init: the bank then keeps, in this
  // process's memory, every broker token its broker writes and every access
  // token its token service issues, so a test can compare them by value with
  // what the agents wrote. A run that did not ask keeps neither, and the
  // operation that returns them is refused.
  const witness = params.witness === true ? { brokerTokens: [], accessTokens: [] } : null;

  const tokens = new TokenService({
    key: { kid: signing.kid, publicJwk: signing.publicJwk },
    audience,
    verifyPath: path.join(repoRoot, pins.aapConformance.vendoredPath),
    workDir: verifierDir,
    verifierEnv: childEnv({ home: path.join(bankDir, 'home'), egressLog: process.env.DEMO_EGRESS_LOG ?? null }),
    jtiFile: path.join(bankDir, 'jti-seen.txt'),
    onIssue: witness ? (accessToken) => witness.accessTokens.push(accessToken) : null,
  });

  const grantFile = path.join(bankDir, 'grants.json');
  const writeGrants = () => {
    const bindings = [...ctx.bank.consents.values()].map((c) => ({
      grant: `grant://${c.grantName}`,
      match: { trustClass: c.trustClass },
      resolve: { mode: 'exchange', providerId: PROVIDER_ID, scope: c.consentId, audience, ttlSeconds: GRANT_TTL_SECONDS },
    }));
    const doc = { version: 1, trust, providers: { [PROVIDER_ID]: { mode: 'exchange', tokenEndpoint } }, bindings };
    fs.writeFileSync(`${grantFile}.next`, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(`${grantFile}.next`, grantFile);
  };

  ctx.servers.resource = http.createServer(resourceHandler(ctx.bank, tokens));
  await listen(ctx.servers.resource, ports.resource);
  ctx.servers.token = http.createServer(tokens.handler());
  await listen(ctx.servers.token, ports.token);

  writeGrants();
  const bb = new BankBroker({
    bankDir,
    sockDir,
    trust,
    signing,
    grantFile,
    onStart: witness ? (tokenFile) => witness.brokerTokens.push(fs.readFileSync(tokenFile, 'utf8').trim()) : null,
  });
  await bb.start();
  fs.writeFileSync(path.join(evidenceDir, 'audit-public-key.pem'), bb.capturedAuditKeyPem, { mode: 0o600 });

  const consentRoute = async (req, res, url) => {
    if (req.method === 'POST' && url.pathname === '/consents') {
      const s = ctx.bank.session(bearer(req));
      if (!s) {
        sendJson(res, 401, { error: 'not signed in' });
        return true;
      }
      const body = await readJson(req, 256 * 1024);
      const role = body.agentRole;
      const trustClass = Object.hasOwn(TRUST_CLASS, role) ? TRUST_CLASS[role] : null;
      const terms = normalizeTerms(body.terms);
      if (!trustClass || !terms) {
        sendJson(res, 400, { error: 'bad consent request' });
        return true;
      }
      const v = atxVerifier.verify(body.atx);
      if (!v.valid || !v.context || !v.context.signedCapabilities || !v.context.capabilities.includes(trustClass)) {
        sendJson(res, 422, { error: 'the agent credential was not accepted' });
        return true;
      }
      const record = ctx.bank.createConsent({
        customerKey: s.customerKey,
        agentId: v.context.agentId,
        agentDid: v.context.agentDid,
        agentRole: role,
        terms,
        trustClass,
      });
      writeGrants();
      const restartSeconds = await bb.restart();
      sendJson(res, 200, { consentId: record.consentId, grantName: record.grantName, approvedAt: record.approvedAt, restartSeconds });
      return true;
    }
    const m = /^\/consents\/(cns_[0-9a-f]{24})\/withdraw$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const s = ctx.bank.session(bearer(req));
      if (!s) {
        sendJson(res, 401, { error: 'not signed in' });
        return true;
      }
      const w = ctx.bank.withdrawConsent(m[1], s.customerKey);
      if (!w) {
        sendJson(res, 404, { error: 'no such consent' });
        return true;
      }
      writeGrants();
      const restartSeconds = await bb.restart();
      sendJson(res, 200, { status: 'withdrawn', withdrawnAt: w.withdrawnAt, restartSeconds });
      return true;
    }
    return false;
  };
  ctx.routes.consents = consentRoute;

  const brokerKeyThumbprint = jwkThumbprint(signing.publicJwk);
  return {
    describe: () => ({ brokerKeyThumbprint, audience, socketPath: bb.paths.socketPath }),
    brokerRunning: () => bb.running(),
    records: () => ({
      audit: {
        entries: bb.auditEntries(),
        verification: bb.verifyAudit(),
        keyChanged: bb.auditKeyChanged,
        capturedKeySha256: crypto.createHash('sha256').update(bb.capturedAuditKeyPem).digest('hex'),
        logFile: path.relative(params.runDir, bb.paths.auditLog),
      },
      exchanges: tokens.evidence(),
      cgtKeySet: [{ kid: signing.kid, thumbprint: brokerKeyThumbprint, x: signing.publicJwk.x }],
      brokerStarts: bb.starts,
      grantBindings: JSON.parse(fs.readFileSync(grantFile, 'utf8')).bindings.length,
    }),
    // Fault injection for the tests: take the token service or the payment
    // API off its port, and put it back; and the witness, for a run that
    // asked for it. Reached over the launcher's stdin channel, never over a
    // network listener.
    op: async ({ name }) => {
      if (name === 'witness') {
        if (!witness) throw new Error('this run keeps no witness');
        return { brokerTokens: [...witness.brokerTokens], accessTokens: [...witness.accessTokens] };
      }
      if (name === 'restartBroker') return { restartSeconds: await bb.restart() };
      if (name === 'faultTokenService') { await close(ctx.servers.token); return { ok: true }; }
      if (name === 'faultPaymentApi') { await close(ctx.servers.resource); return { ok: true }; }
      if (name === 'restore') {
        if (!ctx.servers.token.listening) await listen(ctx.servers.token, ports.token);
        if (!ctx.servers.resource.listening) await listen(ctx.servers.resource, ports.resource);
        return { ok: true };
      }
      throw new Error('unknown operation');
    },
    stop: () => bb.stop(),
  };
}
