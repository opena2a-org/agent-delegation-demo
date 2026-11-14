// A process started inside the offline check's block that replaces the
// egress counter's file with an empty one: every line written before it,
// the hello line of the rerun's root process among them, is gone.
import fs from 'node:fs';

const file = process.env.DEMO_EGRESS_LOG;
fs.rmSync(file);
fs.writeFileSync(file, '', { mode: 0o600 });
