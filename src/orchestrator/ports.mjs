import net from 'node:net';

// Ask the OS for a free loopback port, then release it. The port is written
// into a sandbox profile before the process that listens on it starts, so it
// cannot be read back from that process's own listen(0).
export function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function freeLoopbackPorts(n) {
  const out = new Set();
  while (out.size < n) out.add(await freeLoopbackPort());
  return [...out];
}

// Free loopback ports that stay taken, each by a listener of this process,
// until release() is called. Meanwhile the OS cannot hand one of them out
// again. release() may be called more than once.
export async function holdLoopbackPorts(n) {
  const servers = [];
  const closeAll = () => Promise.all(servers.map((srv) => new Promise((resolve) => { srv.close(() => resolve()); })));
  try {
    while (servers.length < n) {
      servers.push(await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => resolve(srv));
      }));
    }
  } catch (err) {
    await closeAll();
    throw err;
  }
  let released = null;
  return {
    ports: servers.map((srv) => srv.address().port),
    release() {
      released ??= closeAll();
      return released;
    },
  };
}

export function portIsFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}
