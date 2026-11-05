'use strict';

const fs = require('node:fs');
fs.appendFileSync(process.env.BRIDGE_STUB_QUEUE, `${JSON.stringify(process.argv.slice(2))}\n`);
if (process.env.BRIDGE_STUB_QUEUE_FAIL === '1') process.exitCode = 1;
else process.stdout.write('queued\n');
