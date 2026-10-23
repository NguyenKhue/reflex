#!/usr/bin/env node
// process.exit is required: the agent-device client keeps handles open for minutes after a run.
require('../src/cli').main(process.argv.slice(2)).then((code) => process.exit(code));
