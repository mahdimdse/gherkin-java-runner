import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  argFileContent,
  cucumberArgs,
  featureArgument,
  forwardedSystemProperties,
  gradleClasspathCommand,
  gradleTaskPath,
  jdwpArgument,
  mavenClasspathCommand,
  mavenFullClasspath,
  parseJavaMajorVersion,
} from '../src/commandBuilder';
import { expandStepText, leavesOf, parseFeature } from '../src/gherkinModel';
import { minimizePackages, parseRunnerGlue, resolveGlue } from '../src/glue';
import { CaseResult, CucumberMessageProcessor, parseAssertion, parseJavaStackFrames } from '../src/messageParser';
import { detectProject, parseProperties, pomModules } from '../src/projectModel';
import { StepMatcher } from '../src/stepMatcher';
import { parseStepSource } from '../src/stepParser';
import { combineTagExpressions, compileTagExpression } from '../src/tags';

const FEATURE = `@billing
Feature: Checkout

  Background:
    Given a logged in user

  @smoke
  Scenario: Pay by card
    When I pay 12 euros by "card"
    Then the order is confirmed

  Scenario Outline: Pay with <method>
    When I pay <amount> euros by "<method>"
    Then the order is <state>

    @fast
    Examples: cheap
      | amount | method | state     |
      | 1      | card   | confirmed |
      | 2      | cash   | confirmed |

    @slow @wip
    Examples: expensive
      | amount | method | state    |
      | 9999   | card   | rejected |

  @rules
  Rule: Refunds
    Scenario: Refund
      Given an order
`;

test('gherkin: tree, leaves, rows and inherited tags', () => {
  const p = parseFeature(FEATURE);
  assert.equal(p.error, undefined);
  const root = p.root!;
  assert.equal(root.label, 'Checkout');
  assert.deepEqual(root.children.map((c) => c.kind), ['scenario', 'outline', 'rule']);
  const leaves = leavesOf(root);
  assert.deepEqual(leaves.map((l) => l.line), [8, 19, 20, 25, 29]);
  const row1 = leaves[1];
  assert.equal(row1.kind, 'row');
  assert.equal(row1.label, '| 1 | card | confirmed |');
  assert.deepEqual(row1.tags, ['@billing', '@fast']);
  assert.deepEqual(leaves[3].tags, ['@billing', '@slow', '@wip']);
  assert.deepEqual(leaves[4].tags, ['@billing', '@rules']);
  assert.deepEqual(leaves[0].tags, ['@billing', '@smoke']);
  assert.ok(p.tags.some((t) => t.name === '@smoke' && t.line === 7 && t.column === 2));
});

test('gherkin: steps with columns and outline expansion', () => {
  const p = parseFeature(FEATURE);
  const pay = p.steps.find((s) => s.line === 13)!;
  assert.equal(pay.keyword, 'When');
  assert.equal(pay.text, 'I pay <amount> euros by "<method>"');
  assert.equal(pay.keywordColumn, 4);
  assert.equal(pay.textColumn, 9);
  assert.deepEqual(expandStepText(pay), ['I pay 1 euros by "card"', 'I pay 2 euros by "cash"', 'I pay 9999 euros by "card"']);
  assert.ok(p.steps.some((s) => s.text === 'a logged in user'));
});

test('gherkin: syntax errors are reported, not thrown', () => {
  const p = parseFeature('Feature: x\n  Scenario: y\n    Given a\n  this is garbage\n');
  assert.ok(p.error);
  assert.equal(p.errorLine, 4);
});

test('gherkin: other languages', () => {
  const p = parseFeature('# language: de\nFunktionalität: Kasse\n  Szenario: Zahlen\n    Angenommen ein Benutzer\n');
  assert.equal(p.root!.children.length, 1);
  assert.equal(p.steps[0].text, 'ein Benutzer');
});

const STEPS_JAVA = `package com.acme.steps;

import io.cucumber.java.en.Given;
import io.cucumber.java.en.When;
import io.cucumber.java.ParameterType;
import io.cucumber.java.Before;

public class CheckoutSteps {
    // @Given("commented out step")
    /* @When("block commented") */
    @Before
    public void setUp() {}

    @Given("a logged in user")
    public void loggedIn() {}

    @When("I pay {int} euros by {string}")
    public void pay(int amount, String method) {}

    @When(value = "^the order is (confirmed|rejected)$")
    public void state(String s) {}

    @Given("an " +
           "order")
    @io.cucumber.java.en.And("an order exists")
    public void anOrder() {}

    @Then("I see a {color} banner")
    public void banner(Color c) {}

    @ParameterType("red|green|blue")
    public Color color(String c) { return null; }

    @Given("a path like C:\\\\temp and a \\"quote\\"")
    public void escapes() {}
}`;

test('step parser: annotations, concatenation, comments, escapes, parameter types', () => {
  const info = parseStepSource(STEPS_JAVA);
  assert.equal(info.packageName, 'com.acme.steps');
  assert.equal(info.className, 'CheckoutSteps');
  assert.equal(info.isGlue, true);
  const exprs = info.steps.map((s) => s.expression);
  assert.deepEqual(exprs, [
    'a logged in user',
    'I pay {int} euros by {string}',
    '^the order is (confirmed|rejected)$',
    'an order',
    'an order exists',
    'I see a {color} banner',
    'a path like C:\\temp and a "quote"',
  ]);
  const pay = info.steps[1];
  assert.equal(pay.line, 16);
  assert.equal(pay.column, 4);
  assert.equal(pay.methodName, 'pay');
  assert.equal(info.steps[3].methodName, 'anOrder');
  assert.deepEqual(info.parameterTypes.map((p) => [p.name, p.regexps[0]]), [['color', 'red|green|blue']]);
});

test('step parser: localized annotations, java8 lambdas, Kotlin, runner-only files', () => {
  const de = parseStepSource('package de.x;\nimport io.cucumber.java.de.Angenommen;\nclass S { @Angenommen("ein Benutzer") void a(){} }');
  assert.deepEqual(de.steps.map((s) => s.expression), ['ein Benutzer']);

  const j8 = parseStepSource(
    'package a;\nimport io.cucumber.java8.En;\npublic class S implements En { public S() { Given("I have {int} cukes", (Integer n) -> {}); When("x", () -> {}); } }',
  );
  assert.deepEqual(j8.steps.map((s) => s.expression), ['I have {int} cukes', 'x']);

  const kt = parseStepSource('package k.steps\nimport io.cucumber.java.en.Given\nclass S {\n  @Given("kotlin step {word}")\n  fun step(w: String) {}\n}');
  assert.equal(kt.packageName, 'k.steps');
  assert.equal(kt.steps[0].methodName, 'step');

  const runner = parseStepSource(
    'package r;\nimport io.cucumber.junit.platform.engine.Constants;\nimport org.junit.platform.suite.api.*;\n@Suite class RunCucumberTest {}',
  );
  assert.equal(runner.isGlue, false);
});

test('step matcher: cucumber expressions, regex, custom types, fallback', () => {
  const info = parseStepSource(STEPS_JAVA);
  const m = new StepMatcher(info.parameterTypes);
  const find = (t: string) => m.findMatches(info.steps, [t]).map((s) => s.expression);
  assert.deepEqual(find('I pay 12 euros by "card"'), ['I pay {int} euros by {string}']);
  assert.deepEqual(find('the order is rejected'), ['^the order is (confirmed|rejected)$']);
  assert.deepEqual(find('the order is lost'), []);
  assert.deepEqual(find('I see a green banner'), ['I see a {color} banner']);
  assert.deepEqual(find('I see a purple banner'), []);
  assert.deepEqual(find('an order'), ['an order']);
  // unknown parameter type -> lenient match still navigates
  const m2 = new StepMatcher();
  assert.ok(m2.matches({ expression: 'I have {money} in (my )wallet' }, 'I have 5 EUR in wallet'));
  assert.ok(m2.matches({ expression: 'I have {money} in (my )wallet' }, 'I have 5 EUR in my wallet'));
  // optional text and alternatives in cucumber expressions
  assert.ok(m2.matches({ expression: 'I have {int} cucumber(s) in my belly/stomach' }, 'I have 1 cucumber in my stomach'));
  // Java inline flag
  assert.ok(m2.matches({ expression: '(?i)^HELLO (\\w+)$' }, 'hello world'));
});

test('tags: combine and evaluate', () => {
  assert.equal(combineTagExpressions('', undefined), undefined);
  assert.equal(combineTagExpressions('not @wip', '@smoke or @fast'), '(not @wip) and (@smoke or @fast)');
  const f = compileTagExpression('(not @wip) and (@smoke or @fast)');
  assert.equal(f.evaluate(['@billing', '@fast']), true);
  assert.equal(f.evaluate(['@billing', '@slow', '@wip']), false);
  assert.equal(f.evaluate(['@billing']), false);
  assert.throws(() => compileTagExpression('@a and'));
});

function env(o: object) {
  return JSON.stringify(o) + '\n';
}

test('message processor: maps scenarios, rows, failures, undefined steps and retries', () => {
  const uri = 'file:///work/proj/src/test/resources/features/checkout.feature';
  const doc = {
    gherkinDocument: {
      uri,
      feature: {
        children: [
          { background: { steps: [{ id: 'b1', location: { line: 5 } }] } },
          { scenario: { id: 's1', location: { line: 8 }, steps: [{ id: 'st1', location: { line: 9 } }, { id: 'st2', location: { line: 10 } }], examples: [] } },
          {
            scenario: {
              id: 's2', location: { line: 12 }, steps: [{ id: 'st3', location: { line: 13 } }],
              examples: [{ tableBody: [{ id: 'r1', location: { line: 19 } }, { id: 'r2', location: { line: 20 } }] }],
            },
          },
          { rule: { children: [{ scenario: { id: 's3', location: { line: 30 }, steps: [{ id: 'st4', location: { line: 31 } }], examples: [] } }] } },
        ],
      },
    },
  };
  const lines = [
    env(doc),
    env({ pickle: { id: 'p1', uri, name: 'Pay by card', astNodeIds: ['s1'], steps: [{ id: 'ps1', text: 'a logged in user', astNodeIds: ['b1'] }, { id: 'ps2', text: 'I pay', astNodeIds: ['st1'] }] } }),
    env({ pickle: { id: 'p2', uri, name: 'Pay with card', astNodeIds: ['s2', 'r1'], steps: [{ id: 'ps3', text: 'I pay 1', astNodeIds: ['st3', 'r1'] }] } }),
    env({ pickle: { id: 'p3', uri, name: 'Pay with cash', astNodeIds: ['s2', 'r2'], steps: [{ id: 'ps4', text: 'I pay 2 euros by "cash"', astNodeIds: ['st3', 'r2'] }] } }),
    env({ pickle: { id: 'p4', uri, name: 'Refund', astNodeIds: ['s3'], steps: [{ id: 'ps5', text: 'an order', astNodeIds: ['st4'] }] } }),
    env({ testCase: { id: 'tc1', pickleId: 'p1', testSteps: [{ id: 'h1', hookId: 'hook' }, { id: 't1', pickleStepId: 'ps1' }, { id: 't2', pickleStepId: 'ps2' }] } }),
    env({ testCase: { id: 'tc2', pickleId: 'p2', testSteps: [{ id: 't3', pickleStepId: 'ps3' }] } }),
    env({ testCase: { id: 'tc3', pickleId: 'p3', testSteps: [{ id: 't4', pickleStepId: 'ps4' }] } }),
    env({ testCase: { id: 'tc4', pickleId: 'p4', testSteps: [{ id: 't5', pickleStepId: 'ps5' }] } }),
    // passing scenario
    env({ testCaseStarted: { id: 'a1', testCaseId: 'tc1', attempt: 0, timestamp: { seconds: 100, nanos: 0 } } }),
    env({ testStepFinished: { testCaseStartedId: 'a1', testStepId: 'h1', testStepResult: { status: 'PASSED' } } }),
    env({ testStepFinished: { testCaseStartedId: 'a1', testStepId: 't1', testStepResult: { status: 'PASSED' } } }),
    env({ testStepFinished: { testCaseStartedId: 'a1', testStepId: 't2', testStepResult: { status: 'PASSED' } } }),
    env({ testCaseFinished: { testCaseStartedId: 'a1', timestamp: { seconds: 100, nanos: 250000000 }, willBeRetried: false } }),
    // failing row, retried once
    env({ testCaseStarted: { id: 'a2', testCaseId: 'tc2', attempt: 0, timestamp: { seconds: 101, nanos: 0 } } }),
    env({ testStepFinished: { testCaseStartedId: 'a2', testStepId: 't3', testStepResult: { status: 'FAILED', message: 'flaky' } } }),
    env({ testCaseFinished: { testCaseStartedId: 'a2', timestamp: { seconds: 101, nanos: 0 }, willBeRetried: true } }),
    env({ testCaseStarted: { id: 'a3', testCaseId: 'tc2', attempt: 1, timestamp: { seconds: 102, nanos: 0 } } }),
    env({ testStepFinished: { testCaseStartedId: 'a3', testStepId: 't3', testStepResult: { status: 'FAILED', message: 'org.opentest4j.AssertionFailedError: expected: <1> but was: <2>\n\tat com.acme.steps.CheckoutSteps.pay(CheckoutSteps.java:17)' } } }),
    env({ testCaseFinished: { testCaseStartedId: 'a3', timestamp: { seconds: 102, nanos: 0 }, willBeRetried: false } }),
    // undefined step with snippet
    env({ suggestion: { id: 'sg', pickleStepId: 'ps4', snippets: [{ language: 'java', code: '@When("I pay {int} euros by {string}")' }] } }),
    env({ testCaseStarted: { id: 'a4', testCaseId: 'tc3', attempt: 0, timestamp: { seconds: 103, nanos: 0 } } }),
    env({ testStepFinished: { testCaseStartedId: 'a4', testStepId: 't4', testStepResult: { status: 'UNDEFINED' } } }),
    env({ testCaseFinished: { testCaseStartedId: 'a4', timestamp: { seconds: 103, nanos: 0 }, willBeRetried: false } }),
  ];
  const started: number[] = [];
  const done: CaseResult[] = [];
  const p = new CucumberMessageProcessor({ onCaseStarted: (k) => started.push(k.line), onCaseFinished: (r) => done.push(r) });
  // feed in awkward chunks to exercise buffering
  const all = lines.join('');
  for (let i = 0; i < all.length; i += 37) p.feed(all.slice(i, i + 37));
  p.end();

  assert.deepEqual(started, [8, 19, 19, 20]);
  assert.deepEqual(done.map((d) => [d.line, d.status]), [[8, 'PASSED'], [19, 'FAILED'], [20, 'UNDEFINED']]);
  assert.equal(done[0].featurePath, path.normalize('/work/proj/src/test/resources/features/checkout.feature'));
  assert.equal(done[0].durationMs, 250);
  assert.equal(done[1].stepLine, 13);
  assert.match(done[1].message!, /expected: <1>/);
  assert.equal(done[2].stepText, 'I pay 2 euros by "cash"');
  assert.deepEqual(done[2].snippets, ['@When("I pay {int} euros by {string}")']);
});

test('assertion + stack trace parsing', () => {
  const junit = parseAssertion('org.opentest4j.AssertionFailedError: expected: <confirmed> but was: <rejected>\n\tat x.Y.z(Y.java:1)');
  assert.equal(junit.expected, 'confirmed');
  assert.equal(junit.actual, 'rejected');
  const assertj = parseAssertion('\nexpected: "confirmed"\n but was: "rejected"');
  assert.equal(assertj.expected, 'confirmed');
  assert.equal(assertj.actual, 'rejected');
  assert.equal(parseAssertion('boom').expected, undefined);
  const frames = parseJavaStackFrames('x\n\tat com.acme.Steps.pay(Steps.java:42)\n\tat java.base/jdk.internal.reflect.Foo.invoke(Foo.java:7)\n\tat k.S.step(S.kt:3)');
  assert.deepEqual(frames.map((f) => [f.className, f.file, f.line]), [['com.acme.Steps', 'Steps.java', 42], ['jdk.internal.reflect.Foo', 'Foo.java', 7], ['k.S', 'S.kt', 3]]);
});

test('command builder: maven, gradle, cucumber args, argfile, jdwp', () => {
  const mvnProject = { tool: 'maven' as const, moduleDir: '/r/api', rootDir: '/r', modulePath: 'api', wrapper: '/r/mvnw' };
  const mvn = mavenClasspathCommand(mvnProject, '/r/mvnw', '/tmp/cp.txt', ['-o']);
  assert.equal(mvn.cwd, '/r');
  assert.deepEqual(mvn.args, ['-B', '-ntp', '-f', path.join('/r', 'pom.xml'), '-pl', 'api', '-am', '-o', 'test-compile', 'dependency:build-classpath', '-Dmdep.outputFile=/tmp/cp.txt', '-Dmdep.includeScope=test']);
  const single = mavenClasspathCommand({ ...mvnProject, rootDir: '/r/api', modulePath: '' }, 'mvn', '/tmp/cp.txt');
  assert.deepEqual(single.args.slice(0, 4), ['-B', '-ntp', '-f', path.join('/r/api', 'pom.xml')]);
  assert.deepEqual(mavenFullClasspath('/r/api', '/a.jar:/b.jar', ':'), [path.join('/r/api', 'target', 'test-classes'), path.join('/r/api', 'target', 'classes'), '/a.jar', '/b.jar']);

  const gProject = { tool: 'gradle' as const, moduleDir: '/g/app/core', rootDir: '/g', modulePath: ':app:core' };
  assert.equal(gradleTaskPath(gProject), ':app:core:gherkinRunnerClasspath');
  assert.equal(gradleTaskPath({ ...gProject, modulePath: ':' }), ':gherkinRunnerClasspath');
  const g = gradleClasspathCommand(gProject, 'gradle', '/s/init.gradle', '/tmp/cp.txt');
  assert.deepEqual(g.args, ['--console=plain', '-I', '/s/init.gradle', ':app:core:gherkinRunnerClasspath', '-PgherkinRunnerOut=/tmp/cp.txt']);

  assert.equal(featureArgument({ path: '/f/a.feature' }), '/f/a.feature');
  assert.equal(featureArgument({ path: '/f/a.feature', lines: [20, 8, 20] }), '/f/a.feature:8:20');
  assert.deepEqual(
    cucumberArgs({ messageFile: '/m.ndjson', pretty: true, glue: ['com.acme'], extraArgs: ['--strict'], features: [{ path: '/f/a.feature', lines: [8] }] }),
    ['--plugin', 'message:/m.ndjson', '--plugin', 'pretty', '--glue', 'com.acme', '--strict', '/f/a.feature:8'],
  );
  assert.deepEqual(forwardedSystemProperties({ 'cucumber.glue': 'x', 'cucumber.filter.tags': '@a', 'cucumber.object-factory': 'Spring', 'cucumber.features': 'y' }), {
    'cucumber.publish.quiet': 'true',
    'cucumber.object-factory': 'Spring',
  });
  assert.equal(argFileContent(['-cp', 'C:\\a b\\c.jar', 'say "hi"']), '"-cp"\n"C:\\\\a b\\\\c.jar"\n"say \\"hi\\""\n');
  assert.equal(jdwpArgument(5005, 17), '-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5005');
  assert.equal(jdwpArgument(5005, 8), '-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=5005');
  assert.equal(parseJavaMajorVersion('openjdk version "21.0.2" 2024-01-16'), 21);
  assert.equal(parseJavaMajorVersion('java version "1.8.0_392"'), 8);
});

test('project detection: maven reactor, gradle multi-project, wrappers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gjr-'));
  const w = (p: string, c = '') => {
    fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
    fs.writeFileSync(path.join(tmp, p), c);
  };
  // Maven reactor
  w('m/pom.xml', '<project><modules><module>api</module><module>./web/</module></modules></project>');
  w('m/mvnw', '#!/bin/sh');
  w('m/api/pom.xml', '<project/>');
  w('m/api/src/test/resources/features/a.feature');
  w('m/web/pom.xml', '<project/>');
  w('m/web/src/test/resources/b.feature');
  w('m/other/pom.xml', '<project/>'); // not a module of the parent
  w('m/other/src/test/resources/c.feature');
  const a = detectProject(path.join(tmp, 'm/api/src/test/resources/features/a.feature'))!;
  assert.equal(a.tool, 'maven');
  assert.equal(a.rootDir, path.join(tmp, 'm'));
  assert.equal(a.modulePath, 'api');
  assert.equal(a.wrapper, path.join(tmp, 'm/mvnw'));
  assert.equal(detectProject(path.join(tmp, 'm/web/src/test/resources/b.feature'))!.modulePath, 'web');
  const c = detectProject(path.join(tmp, 'm/other/src/test/resources/c.feature'))!;
  assert.equal(c.rootDir, path.join(tmp, 'm/other'));
  assert.equal(c.modulePath, '');

  // Gradle multi-project
  w('g/settings.gradle.kts', 'include("app:core")');
  w('g/gradlew', '#!/bin/sh');
  w('g/app/core/build.gradle.kts');
  w('g/app/core/src/test/resources/x.feature');
  const g = detectProject(path.join(tmp, 'g/app/core/src/test/resources/x.feature'))!;
  assert.equal(g.tool, 'gradle');
  assert.equal(g.rootDir, path.join(tmp, 'g'));
  assert.equal(g.modulePath, ':app:core');
  assert.equal(g.wrapper, path.join(tmp, 'g/gradlew'));

  // Forced build tool
  w('both/pom.xml', '<project/>');
  w('both/build.gradle');
  w('both/src/test/resources/y.feature');
  assert.equal(detectProject(path.join(tmp, 'both/src/test/resources/y.feature'))!.tool, 'maven');
  const forced = detectProject(path.join(tmp, 'both/src/test/resources/y.feature'), 'gradle')!;
  assert.equal(forced.tool, 'gradle');
  assert.equal(forced.modulePath, ':');
  fs.rmSync(tmp, { recursive: true, force: true });

  assert.deepEqual(pomModules('<modules>\n<module> a </module><module>b/c/</module></modules>'), ['a', 'b/c']);
  assert.deepEqual(parseProperties('# c\ncucumber.glue=com.a, com.b\ncucumber.plugin : pretty\nkey\\ x = y \\\n z'), {
    'cucumber.glue': 'com.a, com.b',
    'cucumber.plugin': 'pretty',
    'key x': 'y z',
  });
});

test('glue resolution', () => {
  assert.deepEqual(minimizePackages(['com.acme.steps', 'com.acme', 'com.acme.hooks', 'org.x', '']), ['com.acme', 'org.x']);
  const runner = `@Suite
@ConfigurationParameter(key = GLUE_PROPERTY_NAME, value = "com.acme.steps,com.acme.hooks")
@ConfigurationParameter(key = PLUGIN_PROPERTY_NAME, value = "pretty")
class RunCucumberTest {}
@CucumberOptions(features = "x", glue = {"legacy.a", "legacy.b"})
class Old {}`;
  assert.deepEqual(parseRunnerGlue(runner), ['com.acme.steps', 'com.acme.hooks', 'legacy.a', 'legacy.b']);
  const base = { configured: [], properties: {}, runnerGlue: [], detectedPackages: ['a.b.c', 'a.b'] };
  assert.deepEqual(resolveGlue(base), { glue: ['a.b'], source: 'detected' });
  assert.deepEqual(resolveGlue({ ...base, runnerGlue: ['r'] }).source, 'runner');
  assert.deepEqual(resolveGlue({ ...base, runnerGlue: ['r'], properties: { 'cucumber.glue': 'p1, p2' } }), { glue: ['p1', 'p2'], source: 'properties' });
  assert.deepEqual(resolveGlue({ ...base, configured: ['s'] as any }).glue, ['s']);
  assert.deepEqual(resolveGlue({ ...base, detectedPackages: [] }).source, 'none');
});
