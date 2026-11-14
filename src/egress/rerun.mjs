// The offline check's rerun. The view server starts this file as
//
//   /usr/bin/sandbox-exec -f <runDir>/egress.sb <node> src/egress/rerun.mjs
//
// so this process and every process it starts run under that one profile:
// outbound network refused except the run's loopback listener ports and Unix
// sockets under the run directory, exec refused except this Node.js binary,
// the credential store paths and the sentinel directory refused. The bank and
// the agents start without profiles of their own, because a profile that
// denies anything cannot start a nested one.
//
// In order: the two sibling controls (the sentinel read and the exec of the
// copy of /usr/bin/true, each expected to be refused), the grant path
// scenarios on a fresh bank in the given run directory, any extra process the
// caller names, then one connect to 192.0.2.1 port 9 and one to this
// machine's own address, port 9, both after scenario 4 and both expected to
// be refused. When either control shows its deny form not refusing, neither
// the scenarios nor an extra process start, and the two connects follow the
// controls. It answers over its stdin and stdout.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { serve } from '../orchestrator/channel.mjs';
import { childEnv } from '../orchestrator/env.mjs';
import { offlineDecisions, runSteps } from '../scenarios/engine.mjs';
import { COUNTER_CONTROL, OWN_ADDRESS_PORT } from './classify.mjs';
import { connectOnce, execControl, readControl } from './controls.mjs';

serve({
  // Answered once this process runs under the profile. The counter wrote this
  // process's hello line as it loaded, before this file ran. The view server
  // starts the run as usual after this answer, never before.
  ready() {
    return { pid: process.pid };
  },

  async rerun(params) {
    const out = { pid: process.pid, sentinel: null, exec: null, decisions: null, extra: [], decision2: null, decision3: null, error: null };
    out.sentinel = readControl(params.sentinelFile);
    out.exec = execControl(params.execControl);
    // A deny form seen not refusing: the sentinel was read, or the copy of
    // /usr/bin/true was executed (it ran, or it exited with a status). The
    // scenarios and any extra process would start under the profile that
    // just failed, so none starts. The two connects still run: the network
    // deny refuses them, and they reach neither the store nor an exec.
    if (out.sentinel.outcome === 'read' || out.exec.outcome === 'ran' || out.exec.outcome.startsWith('exit ')) {
      out.decision2 = await connectOnce(COUNTER_CONTROL.host, COUNTER_CONTROL.port);
      out.decision3 = params.ownAddress ? await connectOnce(params.ownAddress, OWN_ADDRESS_PORT) : null;
      return out;
    }
    let run = null;
    try {
      const r = await runSteps(params.chain, {
        sandbox: 'outer',
        runDir: params.runDir,
        runId: params.runId,
        ports: params.ports,
        origins: [],
      }, 'offline');
      run = r.run;
      out.decisions = offlineDecisions(r.result.steps);
      out.pids = run.pids();
    } catch {
      out.error = 'the scenarios did not complete';
    }
    for (const script of params.extraScripts ?? []) {
      const home = path.join(params.offlineDir, `extra-${out.extra.length}`);
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const r = spawnSync(process.execPath, [script], {
        env: childEnv({ home, egressLog: params.egressLog }),
        cwd: home,
        stdio: 'ignore',
        timeout: 15000,
      });
      out.extra.push({ script: path.basename(script), pid: r.pid, status: r.status });
    }
    out.decision2 = await connectOnce(COUNTER_CONTROL.host, COUNTER_CONTROL.port);
    out.decision3 = params.ownAddress ? await connectOnce(params.ownAddress, OWN_ADDRESS_PORT) : null;
    if (run) await run.stop();
    return out;
  },

  stop() {
    return { stopped: true };
  },
});
