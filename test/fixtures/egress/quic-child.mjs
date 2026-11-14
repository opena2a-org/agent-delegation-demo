// A process started inside the offline check's block that starts a Node.js
// child with QUIC enabled on its command line. The child loads the egress
// counter like every other process.
import { spawnSync } from 'node:child_process';

spawnSync(process.execPath, ['--experimental-quic', '-e', ''], { stdio: 'ignore' });
