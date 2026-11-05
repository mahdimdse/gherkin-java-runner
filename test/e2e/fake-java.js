#!/usr/bin/env node
// Imitates `java ... io.cucumber.core.cli.Main` well enough to exercise the extension.
const fs = require('fs');
const { generateMessages } = require('@cucumber/gherkin');
const { IdGenerator, SourceMediaType } = require('@cucumber/messages');
let argv = process.argv.slice(2);
if (argv[0] === '-version') { console.error('openjdk version "17.0.9" 2023-10-17'); process.exit(0); }
if (argv.length === 1 && argv[0].startsWith('@')) {
  const txt = fs.readFileSync(argv[0].slice(1), 'utf8');
  argv = [...txt.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
}
fs.writeFileSync(process.env.FAKE_JAVA_ARGS_OUT, JSON.stringify(argv, null, 1));
const main = argv.indexOf('io.cucumber.core.cli.Main');
const jvm = argv.slice(0, main);
const cli = argv.slice(main + 1);
const debug = jvm.find((a) => a.startsWith('-agentlib:jdwp'));
let messageFile; const features = [];
for (let i = 0; i < cli.length; i++) {
  if (cli[i] === '--plugin') { const p = cli[++i]; if (p.startsWith('message:')) messageFile = p.slice(8); }
  else if (cli[i] === '--glue') i++;
  else if (cli[i].includes('.feature')) features.push(cli[i]);
}
const out = fs.createWriteStream(messageFile);
const emit = (o) => out.write(JSON.stringify(o) + '\n');
const ids = IdGenerator.incrementing();
let t = 1000;
const ts = () => ({ seconds: t++, nanos: 0 });
async function run() {
  if (debug) { console.log('Listening for transport dt_socket at address: 5555'); await new Promise((r) => setTimeout(r, 300)); }
  for (const f of features) {
    const m = /^(.*\.feature)((?::\d+)*)$/.exec(f);
    const file = m[1]; const lines = m[2] ? m[2].slice(1).split(':').map(Number) : null;
    const uri = 'file://' + file;
    const envs = generateMessages(fs.readFileSync(file, 'utf8'), uri, SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, { includeGherkinDocument: true, includePickles: true, newId: ids });
    const doc = envs.find((e) => e.gherkinDocument).gherkinDocument;
    emit({ gherkinDocument: doc });
    const lineOf = new Map();
    const walk = (sc) => { lineOf.set(sc.id, sc.location.line); sc.examples.forEach((ex) => ex.tableBody.forEach((r) => lineOf.set(r.id, r.location.line))); };
    doc.feature.children.forEach((c) => { if (c.scenario) walk(c.scenario); (c.rule?.children ?? []).forEach((rc) => rc.scenario && walk(rc.scenario)); });
    for (const e of envs) {
      if (!e.pickle) continue;
      const p = e.pickle;
      const pl = p.astNodeIds.map((id) => lineOf.get(id));
      if (lines && !lines.some((l) => pl.includes(l))) continue;
      emit({ pickle: p });
      const tcId = ids(); const steps = p.steps.map((s) => ({ id: ids(), pickleStepId: s.id }));
      emit({ testCase: { id: tcId, pickleId: p.id, testSteps: steps } });
      const st = ids();
      emit({ testCaseStarted: { id: st, testCaseId: tcId, attempt: 0, timestamp: ts() } });
      console.log(`  Scenario: ${p.name}`);
      let failed = false;
      for (const [i, s] of p.steps.entries()) {
        const text = p.steps[i].text;
        let status = failed ? 'SKIPPED' : 'PASSED'; let message;
        if (!failed && /fail/.test(text)) { status = 'FAILED'; failed = true; message = 'org.opentest4j.AssertionFailedError: expected: <ok> but was: <broken>\n\tat com.acme.steps.Steps.fails(Steps.java:12)'; }
        if (!failed && /undefined/.test(text)) { status = 'UNDEFINED'; failed = true; emit({ suggestion: { id: ids(), pickleStepId: s.id, snippets: [{ language: 'java', code: '@Given("an undefined step")\npublic void x() {}' }] } }); }
        emit({ testStepFinished: { testCaseStartedId: st, testStepId: steps[i].id, testStepResult: { status, message, duration: { seconds: 0, nanos: 0 } }, timestamp: ts() } });
      }
      emit({ testCaseFinished: { testCaseStartedId: st, timestamp: ts(), willBeRetried: false } });
    }
  }
  out.end(() => process.exit(0));
}
run();
