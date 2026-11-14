// A second process of the same operating system user. It reads the broker
// token from the file it is given, calls the broker's Unix socket with it,
// and makes the same call without it. Prints its pid and the two status codes,
// never the token.

import fs from 'node:fs';
import http from 'node:http';

const [socketPath, tokenFile] = process.argv.slice(2);

const get = (headers) => new Promise((resolve) => {
  const req = http.request({ socketPath, path: '/health', method: 'GET', headers }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', (err) => resolve(err.code ?? 'error'));
  req.end();
});

const token = fs.readFileSync(tokenFile, 'utf8').trim();
const withToken = await get({ Authorization: `Bearer ${token}` });
const withoutToken = await get({});
process.stdout.write(`${JSON.stringify({ pid: process.pid, withToken, withoutToken })}\n`);
