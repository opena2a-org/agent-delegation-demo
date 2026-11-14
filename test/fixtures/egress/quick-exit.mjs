// A child process that makes one TCP attempt and exits at once, before the
// attempt can complete. The counter writes its line before the call runs, so
// the attempt is still counted.
import net from 'node:net';

net.connect({ host: '192.0.2.1', port: 9 }).on('error', () => {});
process.exit(0);
