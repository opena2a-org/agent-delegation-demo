// The password path: the agent signs in with the customer's username and
// password and acts as the customer. The password is held in memory and never
// written to a file.

async function request(base, method, path, { session = null, body = null } = {}) {
  const headers = { Accept: 'application/json' };
  if (session) headers.Authorization = `Bearer ${session}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

export class PasswordTransport {
  constructor({ bankUrl, username, password }) {
    if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):[0-9]+$/.test(bankUrl)) throw new Error('bank address must be a loopback literal');
    this.base = bankUrl;
    this.username = username;
    this.password = password;
    this.session = null;
  }

  describe() {
    return { transport: 'password session' };
  }

  async signIn() {
    const r = await request(this.base, 'POST', '/login', { body: { username: this.username, password: this.password } });
    this.session = r.status === 200 && r.body && typeof r.body.session === 'string' ? r.body.session : null;
    return this.session !== null;
  }

  async withSession(fn) {
    if (!this.session && !(await this.signIn())) return { step: 'sign in', status: 401, refused: true };
    let r = await fn();
    if (r.status === 401) {
      if (!(await this.signIn())) return { step: 'sign in', status: 401, refused: true };
      r = await fn();
    }
    return { step: 'request', status: r.status, refused: r.status >= 400, body: r.body };
  }

  pay(attempt) {
    return this.withSession(() => request(this.base, 'POST', '/payments', {
      session: this.session,
      body: { payeeName: attempt.payeeName, payeeAccount: attempt.payeeAccount, amount: attempt.amount, currency: attempt.currency },
    }));
  }

  readBalance() {
    return this.withSession(() => request(this.base, 'GET', '/balance', { session: this.session }));
  }
}
