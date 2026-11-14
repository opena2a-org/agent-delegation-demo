// Online banking: the password path. A session made with the customer's
// username and password can do anything the customer can do online. The
// bank sees the customer and nothing else.

import { bearer, hostAndOriginAllowed, readJson, sendJson } from '../http.mjs';
import { centsToDecimal, parseCents } from './money.mjs';

export function onlineHandler(bank, { port, origins, routes = {} }) {
  return async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (req.method === 'POST' && !hostAndOriginAllowed(req, { port, origins })) {
        sendJson(res, 403, { error: 'request refused' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login') {
        const body = await readJson(req);
        const s = bank.login(String(body.username ?? ''), String(body.password ?? ''));
        if (!s) {
          sendJson(res, 401, { error: 'sign in refused' });
          return;
        }
        sendJson(res, 200, { session: s.token });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/password') {
        const body = await readJson(req);
        const r = bank.changePassword(bearer(req), String(body.currentPassword ?? ''), String(body.newPassword ?? ''));
        sendJson(res, r.ok ? 200 : 401, r.ok ? { status: 'changed', sessionsEnded: r.sessionsEnded } : { error: r.reason });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/balance') {
        const s = bank.session(bearer(req));
        if (!s) {
          sendJson(res, 401, { error: 'not signed in' });
          return;
        }
        sendJson(res, 200, { balance: centsToDecimal(bank.balance(s.customerKey)), currency: 'USD' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/payments') {
        const body = await readJson(req);
        let amountCents;
        try {
          amountCents = parseCents(body.amount);
        } catch {
          sendJson(res, 400, { error: 'bad amount' });
          return;
        }
        const r = bank.payAsCustomer(bearer(req), {
          payeeName: String(body.payeeName ?? ''),
          payeeAccount: String(body.payeeAccount ?? ''),
          amountCents,
        });
        if (!r.ok) {
          sendJson(res, r.status, { error: r.reason });
          return;
        }
        sendJson(res, 200, { status: 'paid', paymentId: r.row.rowId });
        return;
      }
      for (const route of Object.values(routes)) {
        if (await route(req, res, url)) return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) sendJson(res, 400, { error: 'bad request' });
    }
  };
}
