// Every child the demo starts gets an explicit environment. Nothing is
// inherited from the shell that started the demo.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COUNTER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../egress/counter.cjs');

// The six names every child gets, plus the two the egress counter needs.
export const ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'TZ',
  'LANG',
  'DO_NOT_TRACK',
  'OPENA2A_TELEMETRY',
  'NODE_OPTIONS',
  'DEMO_EGRESS_LOG',
]);

// The counter's path is written as a JSON string, so NODE_OPTIONS loads it
// from a clone path with a space, a double quote or a backslash.
export function counterOption(counterPath = COUNTER_PATH) {
  return `--require ${JSON.stringify(counterPath)}`;
}

export function childEnv({ home, egressLog = null, counterPath = COUNTER_PATH }) {
  if (!home) throw new Error('every child gets its own HOME');
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    TZ: 'UTC',
    LANG: 'C',
    DO_NOT_TRACK: '1',
    OPENA2A_TELEMETRY: 'off',
  };
  if (egressLog) {
    env.NODE_OPTIONS = counterOption(counterPath);
    env.DEMO_EGRESS_LOG = egressLog;
  }
  return env;
}
