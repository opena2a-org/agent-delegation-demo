// Re-sign a run's broker audit log with a fresh key and replace the .pub
// file beside it, as someone holding write access to the log directory could.
// Prints whether the replaced .pub file would verify the forged log: a dispute
// view that trusted that file would report it as verified.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const broker = require('secretless-ai/dist/broker/index.js');
const [work, logPath] = process.argv.slice(2);

const forged = path.join(work, 'forged.log');
const logger = new broker.AuditLogger(forged);
for (const line of fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)) {
  const e = JSON.parse(line);
  logger.logEvent(e.eventType, e.agentId, e.credentialName, e.policyId, e.result, e.reason, e.latencyMs);
}
logger.close();
fs.copyFileSync(forged, logPath);
fs.copyFileSync(`${forged}.pub`, `${logPath}.pub`);
const viaPubFile = broker.verifyAuditLog(logPath, fs.readFileSync(`${logPath}.pub`, 'utf8'));
process.stdout.write(`${JSON.stringify({ verifiesUnderReplacedPubFile: viaPubFile.valid === true, records: viaPubFile.records })}\n`);
