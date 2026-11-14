// Runs the offline check from this process, which the test starts under a
// sandbox profile of its own, and prints the result and its text as one
// JSON line.
import { runOfflineCheck } from '../../../src/egress/offline.mjs';
import { offlineBlock } from '../../../src/runner/offline-text.mjs';

const result = await runOfflineCheck({ open: false });
process.stdout.write(`${JSON.stringify({ result, text: offlineBlock(result) })}\n`);
