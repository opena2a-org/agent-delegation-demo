// A process started inside the offline check's block that appends a line
// that is not JSON to the egress counter's file, so the file can no longer
// be read as the record of the run.
import fs from 'node:fs';

fs.appendFileSync(process.env.DEMO_EGRESS_LOG, 'not a counter line\n');
