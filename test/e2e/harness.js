const fs = require('fs'); const os = require('os'); const path = require('path'); const assert = require('assert/strict');
const vscode = require('vscode');
const { runGroup, caseKey } = require('./executor.bundle.js');
const { parseFeature, leavesOf } = require('./gherkin.bundle.js');

const here = __dirname; const nm = path.resolve(here, '../../node_modules');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gjr-e2e-'));
const proj = path.join(tmp, 'shop');
fs.mkdirSync(path.join(proj, 'src/test/resources/features'), { recursive: true });
fs.writeFileSync(path.join(proj, 'pom.xml'), '<project/>');
fs.writeFileSync(path.join(proj, 'src/test/resources/junit-platform.properties'), 'cucumber.glue=com.acme.steps\ncucumber.object-factory=io.cucumber.spring.SpringFactory\ncucumber.filter.tags=@nope\n');
const featurePath = path.join(proj, 'src/test/resources/features/checkout with spaces.feature');
fs.writeFileSync(featurePath, `@billing
Feature: Checkout
  @smoke
  Scenario: Pay by card
    Given a user
    Then it works

  Scenario: Broken
    Given something that will fail
    Then never reached

  Scenario Outline: Rows
    Given a <thing>
    Examples:
      | thing          |
      | ok             |
      | undefined step |
`);
const jhome = path.join(tmp, 'jdk'); fs.mkdirSync(path.join(jhome, 'bin'), { recursive: true });
const sh = (target) => `#!/bin/sh\nNODE_PATH="${nm}" exec node "${target}" "$@"\n`;
fs.writeFileSync(path.join(jhome, 'bin/java'), sh(path.join(here, 'fake-java.js')), { mode: 0o755 });
const mvn = path.join(tmp, 'fake-mvn'); fs.writeFileSync(mvn, sh(path.join(here, 'fake-mvn.js')), { mode: 0o755 });
process.env.FAKE_JAVA_ARGS_OUT = path.join(tmp, 'java-args.json');
process.env.FAKE_MVN_ARGS_OUT = path.join(tmp, 'mvn-args.json');

const model = parseFeature(fs.readFileSync(featurePath, 'utf8')).root;
const leaves = leavesOf(model);
function makeRun() {
  const events = []; let out = '';
  const r = { events, get out() { return out; },
    enqueued: (i) => events.push(['enqueued', i.id]), started: (i) => events.push(['started', i.id]),
    passed: (i, d) => events.push(['passed', i.id]), failed: (i, m) => events.push(['failed', i.id, m]),
    errored: (i, m) => events.push(['errored', i.id, m]), skipped: (i) => events.push(['skipped', i.id]),
    appendOutput: (t) => { out += t; } };
  return r;
}
const items = new Map(leaves.map((l) => [caseKey(featurePath, l.line), { id: String(l.line), uri: vscode.Uri.file(featurePath) }]));
const index = { whenReady: Promise.resolve(), runnerGlueUnder: () => [], gluePackagesUnder: () => ['com.detected'], findSource: (f) => (f === 'Steps.java' ? vscode.Uri.file('/src/Steps.java') : undefined) };
const cfg = { buildTool: 'auto', mavenExecutable: mvn, gradleExecutable: '', mavenArgs: ['-o'], gradleArgs: [], compileBeforeRun: true, javaHome: jhome, glue: [], vmArgs: ['-Xmx256m'], env: { FOO: 'bar' }, cucumberArgs: [], prettyOutput: true, tags: '', attachTimeoutSeconds: 10 };
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const project = { tool: 'maven', moduleDir: proj, rootDir: proj, modulePath: '' };
const ctx = { storageDir: path.join(tmp, 'storage'), log: { appendLine: (s) => process.env.VERBOSE && console.log(s) }, index };

(async () => {
  // 1. Whole file, run mode
  let run = makeRun();
  await runGroup(ctx, { project, selections: [{ path: featurePath }], leaves: items, run, token, debug: false, cfg });
  const byId = (r) => Object.fromEntries(r.events.filter((e) => e[0] !== 'started' && e[0] !== 'enqueued').map((e) => [e[1], e]));
  if (process.env.VERBOSE) { console.log(run.events.map(e=>e.slice(0,2))); console.log(run.out); }
  let res = byId(run);
  assert.equal(res['4'][0], 'passed');
  assert.equal(res['8'][0], 'failed');
  assert.equal(res['8'][2].expectedOutput, 'ok');
  assert.equal(res['8'][2].location.range.line, 8, 'failure points at the failing step line');
  assert.equal(res['8'][2].stackTrace[0].uri.fsPath, '/src/Steps.java');
  assert.equal(res['16'][0], 'passed');
  assert.equal(res['17'][0], 'errored');
  assert.match(res['17'][2].message, /Undefined step: a undefined step[\s\S]*@Given/);
  assert.ok(run.events.some((e) => e[0] === 'started' && e[1] === '4'));
  const javaArgs = JSON.parse(fs.readFileSync(process.env.FAKE_JAVA_ARGS_OUT, 'utf8'));
  assert.ok(javaArgs.includes('-Xmx256m'));
  assert.ok(javaArgs.includes('-Dcucumber.object-factory=io.cucumber.spring.SpringFactory'));
  assert.ok(!javaArgs.some((a) => a.includes('@nope')), 'cucumber.filter.tags from properties is not forwarded');
  assert.deepEqual(javaArgs.slice(javaArgs.indexOf('--glue'), javaArgs.indexOf('--glue') + 2), ['--glue', 'com.acme.steps']);
  const cp = javaArgs[javaArgs.indexOf('-cp') + 1].split(':');
  assert.deepEqual(cp, [path.join(proj, 'target/test-classes'), path.join(proj, 'target/classes'), '/repo/io/cucumber/cucumber-java.jar', '/repo/junit.jar']);
  assert.equal(javaArgs[javaArgs.length - 1], featurePath, 'path with spaces survives the argfile');
  const mvnArgs = JSON.parse(fs.readFileSync(process.env.FAKE_MVN_ARGS_OUT, 'utf8'));
  assert.ok(mvnArgs.includes('-o') && mvnArgs.includes('test-compile') && mvnArgs.includes('dependency:build-classpath'));
  assert.match(run.out, /Scenario: Pay by card/);
  assert.ok(!/[^\r]\n/.test(run.out), 'output uses CRLF');
  console.log('✓ run whole feature');

  // 2. Single example row (line filter) in debug mode
  run = makeRun();
  const rowItems = new Map([[caseKey(featurePath, 16), items.get(caseKey(featurePath, 16))]]);
  await runGroup(ctx, { project, selections: [{ path: featurePath, lines: [16] }], leaves: rowItems, run, token, debug: true, cfg });
  res = byId(run);
  assert.deepEqual(Object.keys(res), ['16']);
  assert.equal(res['16'][0], 'passed');
  const dbg = vscode.__lastDebug;
  assert.equal(dbg.type, 'java'); assert.equal(dbg.request, 'attach'); assert.equal(dbg.hostName, '127.0.0.1');
  const jargs = JSON.parse(fs.readFileSync(process.env.FAKE_JAVA_ARGS_OUT, 'utf8'));
  const jdwp = jargs.find((a) => a.startsWith('-agentlib:jdwp'));
  assert.ok(jdwp.endsWith(`address=127.0.0.1:${dbg.port}`), jdwp);
  assert.equal(jargs[jargs.length - 1], featurePath + ':16');
  console.log('✓ debug a single Examples row (attach config + JDWP port match)');

  // 3. Build failure marks everything errored
  run = makeRun();
  const failing = path.join(tmp, 'fail-mvn'); fs.writeFileSync(failing, '#!/bin/sh\necho "[ERROR] COMPILATION ERROR : Steps.java:[3,1] cannot find symbol"\nexit 1\n', { mode: 0o755 });
  await runGroup(ctx, { project, selections: [{ path: featurePath }], leaves: items, run, token, debug: false, cfg: { ...cfg, mavenExecutable: failing } });
  const errs = run.events.filter((e) => e[0] === 'errored');
  assert.equal(errs.length, 4);
  assert.match(errs[0][2].message, /Build failed[\s\S]*cannot find symbol/);
  console.log('✓ compile errors are reported on every selected scenario');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
