// A child process that makes one TCP attempt and waits for its result.
import net from 'node:net';

const s = net.connect({ host: '192.0.2.1', port: 9 });
s.once('connect', () => { s.destroy(); process.exit(0); });
s.once('error', () => process.exit(0));
