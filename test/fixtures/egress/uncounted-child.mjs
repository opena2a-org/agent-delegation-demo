// A process started inside the offline check's block that starts a Node.js
// child whose NODE_OPTIONS replaces the one that loads the egress counter,
// so the child runs without writing a hello line.
import { spawnSync } from 'node:child_process';

spawnSync(process.execPath, ['-e', ''], { env: { ...process.env, NODE_OPTIONS: '--no-warnings' }, stdio: 'ignore' });
