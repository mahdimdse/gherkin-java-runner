#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_MVN_ARGS_OUT, JSON.stringify(args));
const out = args.find((a) => a.startsWith('-Dmdep.outputFile=')).split('=')[1];
fs.writeFileSync(out, '/repo/io/cucumber/cucumber-java.jar:/repo/junit.jar');
console.log('[INFO] BUILD SUCCESS');
