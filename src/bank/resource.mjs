// The bank's payment API: the audience the bank's broker calls on an agent's
// behalf, with an access token from the bank's token service. The bank's own
// check decides each operation against the consent the token names. The
// answer carries no reason: the reason stays in the bank's records.
//
// A token that carries a mission member is Mission-bound: the Mission rules
// in mission.mjs decide it, against the bank's Mission records, before the
// consent check runs. They can refuse a request the consent would allow,
// and they never allow one the consent refuses. A refusal names its OAuth
// error in WWW-Authenticate, and its reason goes to mission.decisions.

import { bearer, readJson, sendJson } from '../http.mjs';
import { decideMissionRequest } from './mission.mjs';
import { centsToDecimal, parseCents } from './money.mjs';

// mission, when given: { issuer, resource, missions, decisions }, the
// configuration decideMissionRequest reads, and an array for the records.
export function resourceHandler(bank, tokens, mission = null) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      const isPay = req.method === 'POST' && url.pathname === '/v1/payments';
      const isBalance = req.method === 'GET' && url.pathname === '/v1/balance';
      if (!isPay && !isBalance) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const token = tokens.redeem(bearer(req));
      if (!token) {
        sendJson(res, 401, { status: 'refused' });
        return;
      }
      let operation;
      if (isPay) {
        const body = await readJson(req);
        let amountCents;
        try {
          amountCents = parseCents(body?.amount?.amount);
        } catch {
          sendJson(res, 400, { status: 'refused' });
          return;
        }
        operation = {
          kind: 'payment',
          creditorAccount: String(body.creditorAccount ?? ''),
          amountCents,
          amountDecimal: body.amount.amount,
          currency: String(body.amount.currency ?? ''),
        };
      } else {
        operation = { kind: 'balance' };
      }
      if (token.mission !== undefined) {
        const m = decideMissionRequest(token, operation, mission, bank.now());
        mission?.decisions?.push({
          time: bank.iso(),
          missionId: token.mission?.id ?? null,
          tokenJti: token.jti ?? null,
          kind: operation.kind,
          decision: m.allowed ? 'allowed' : 'refused',
          category: m.category,
          reason: m.reason,
        });
        if (!m.allowed) {
          if (m.challenge) res.setHeader('WWW-Authenticate', m.challenge);
          sendJson(res, m.status, { status: 'refused' });
          return;
        }
      }
      const r = bank.actUnderConsent({ consentId: token.scope, tokenSub: token.sub, tokenJti: token.jti, operation });
      if (r.decision.decision !== 'allowed') {
        sendJson(res, 403, { status: 'refused' });
        return;
      }
      if (isPay) sendJson(res, 200, { status: 'accepted', paymentId: r.row.rowId });
      else sendJson(res, 200, { balance: centsToDecimal(r.balanceCents), currency: 'USD' });
    } catch {
      if (!res.headersSent) sendJson(res, 400, { status: 'refused' });
    }
  };
}
