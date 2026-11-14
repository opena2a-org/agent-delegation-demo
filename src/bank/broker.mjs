// The bank's broker: the AAP reference implementation from secretless-ai,
// run in this process. The bank builds it from its own grant file, the way
// the reference loader does, and starts it again whenever a consent changes
// (the reference implementation reads its grants once, at start).
//
// Every path the broker would otherwise default under HOME is set here: the
// socket, the access token file, the audit log and the policy file. Its
// credential resolver refuses every name, so /resolve can never read a
// credential store or this process's environment.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { LocalAtxVerifier } from '@opena2a/atx-verify';
import { OUTCOMES, verifyChain } from './delegation-chain.mjs';

const require = createRequire(import.meta.url);
const broker = require('secretless-ai/dist/broker/index.js');

// Beside the AAP grant path below, which it leaves as it is, the broker checks
// an Agent Delegation Chain of draft-asor-wimse-agent-delegation-chain-03: the
// par_hash link of every child to its parent and the subsumption rules of the
// draft's section 4.3, on the chain alone (steps 1 to 5 and 7 of its section
// 6). See ./delegation-chain.mjs for what it runs and what it does not.
export const DELEGATION_CHAIN_OUTCOMES = OUTCOMES;

export function verifyDelegationChain(chain, verifierState) {
  return verifyChain(chain, verifierState);
}

export const BROKER_ISSUER = 'did:web:broker.examplebank.test';
export const BROKER_KID = 'bank-broker-key-1';
export const PROVIDER_ID = 'bank-token-service';

export const refusingResolver = Object.freeze({
  resolve: async () => undefined,
  exists: async () => false,
});

// Every provider and downstream caller the bank supplies throws fixed text
// and nothing else, so no operation detail can reach the broker's signed record through
// an error message.
class FixedMessageProvider {
  constructor(inner) {
    this.inner = inner;
    this.modes = inner.modes;
  }

  async resolve(ctx, binding) {
    try {
      return await this.inner.resolve(ctx, binding);
    } catch {
      throw new Error('token exchange failed');
    }
  }
}

class FixedMessageCaller {
  constructor(inner) {
    this.inner = inner;
  }

  async call(audience, op, cred) {
    try {
      return await this.inner.call(audience, op, cred);
    } catch {
      throw new Error('payment API call failed');
    }
  }
}

export function loadTrust(trustFile) {
  const t = JSON.parse(fs.readFileSync(trustFile, 'utf8'));
  if (!Array.isArray(t.trustedIssuers) || t.trustedIssuers.length !== 1) throw new Error('trust section must name exactly one issuer');
  if (!Array.isArray(t.publicKeys) || t.publicKeys.length !== 1) throw new Error('trust section must hold exactly one key');
  const key = t.publicKeys[0];
  if (typeof key.keyId !== 'string' || !key.keyId.startsWith(`${t.trustedIssuers[0]}#`)) throw new Error('the key must carry a DID URL keyId under the issuer');
  return { trustedIssuers: [...t.trustedIssuers], publicKeys: [{ algorithm: key.algorithm, publicKeyHex: key.publicKeyHex, keyId: key.keyId }] };
}

export function makeSigningKey() {
  const key = broker.generateBrokerSigningKey(BROKER_ISSUER, BROKER_KID);
  const publicJwk = broker.brokerPublicJwk(key);
  return { key, kid: BROKER_KID, publicJwk };
}

// RFC 7638 thumbprint of an Ed25519 public JWK.
export function jwkThumbprint(jwk) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

export class BankBroker {
  // onStart, when given, is called after every start with the path of the
  // broker token file the broker has just written.
  constructor({ bankDir, sockDir, trust, signing, grantFile, onStart = null }) {
    this.bankDir = bankDir;
    this.grantFile = grantFile;
    this.trust = trust;
    this.signing = signing;
    this.onStart = onStart;
    this.paths = {
      socketPath: path.join(sockDir, 'broker.sock'),
      tokenFile: path.join(bankDir, 'broker.token'),
      auditLog: path.join(bankDir, 'audit', 'broker-audit.log'),
      policyFile: path.join(bankDir, 'policy.json'),
    };
    fs.mkdirSync(path.dirname(this.paths.auditLog), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.paths.policyFile)) fs.writeFileSync(this.paths.policyFile, JSON.stringify({ rules: [] }), { mode: 0o600 });
    this.server = null;
    this.audit = null;
    this.capturedAuditKeyPem = null;
    this.auditKeyChanged = false;
    this.starts = 0;
  }

  readGrants() {
    const g = JSON.parse(fs.readFileSync(this.grantFile, 'utf8'));
    return g.bindings;
  }

  build() {
    const bindings = this.readGrants();
    const grants = JSON.parse(fs.readFileSync(this.grantFile, 'utf8'));
    const policy = new broker.GrantPolicy(bindings);
    const transport = new broker.HttpsTokenExchangeTransport();
    const providers = new broker.MapProviderRegistry();
    for (const [id, p] of Object.entries(grants.providers)) {
      providers.register(id, new FixedMessageProvider(new broker.ExchangeProvider({ tokenEndpoint: p.tokenEndpoint }, this.signing.key, transport)));
    }
    const worker = new broker.EphemeralWorker(new FixedMessageCaller(new broker.HttpsDownstreamCaller()));
    this.audit = new broker.AuditLogger(this.paths.auditLog);
    const grantResolver = new broker.GrantResolver({
      verifier: new LocalAtxVerifier(this.trust),
      policy,
      providers,
      worker,
      audit: this.audit,
      aimClient: null,
    });
    const config = {
      socketPath: this.paths.socketPath,
      httpPort: 0,
      policyFile: this.paths.policyFile,
      auditLog: this.paths.auditLog,
      tokenFile: this.paths.tokenFile,
    };
    return new broker.BrokerServer(config, { resolver: refusingResolver, audit: this.audit, aimClient: null, grantResolver });
  }

  async start() {
    this.server = this.build();
    await this.server.start();
    // The audit public key is captured when the broker starts and kept
    // outside the log directory. The dispute view verifies with this key and
    // never with the .pub file beside the log.
    const pem = this.audit.publicKeyPem();
    if (this.capturedAuditKeyPem === null) this.capturedAuditKeyPem = pem;
    else if (pem !== this.capturedAuditKeyPem) this.auditKeyChanged = true;
    this.starts += 1;
    if (this.onStart) this.onStart(this.paths.tokenFile);
  }

  async stop() {
    if (this.server) await this.server.stop();
    this.server = null;
  }

  async restart() {
    const t0 = process.hrtime.bigint();
    await this.stop();
    await this.start();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return Math.round(ms / 100) / 10;
  }

  running() {
    return this.server !== null;
  }

  verifyAudit() {
    if (!fs.existsSync(this.paths.auditLog)) return { valid: false, records: 0, reason: 'no audit log yet' };
    return broker.verifyAuditLog(this.paths.auditLog, this.capturedAuditKeyPem);
  }

  auditEntries() {
    if (!fs.existsSync(this.paths.auditLog)) return [];
    return fs.readFileSync(this.paths.auditLog, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return { unreadable: true }; }
    });
  }
}
