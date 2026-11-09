import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  argFileContent,
  CUCUMBER_MAIN,
  cucumberArgs,
  FeatureSelection,
  forwardedSystemProperties,
  GRADLE_INIT_SCRIPT,
  gradleClasspathCommand,
  gradleExecutable,
  jvmArgs,
  mavenClasspathCommand,
  mavenExecutable,
  mavenFullClasspath,
} from './commandBuilder';
import { RunnerConfig } from './config';
import { resolveGlue } from './glue';
import { resolveJava } from './javaInfo';
import {
  CaseKey,
  CaseResult,
  CucumberMessageProcessor,
  formatCaseSummary,
  formatScenarioHeader,
  formatStep,
  formatSummaryHeader,
  parseAssertion,
  parseJavaStackFrames,
} from './messageParser';
import { startProcess } from './process';
import { JavaProject, projectKey, readCucumberProperties } from './projectModel';
import { StepIndex } from './stepIndex';

export interface ExecContext {
  storageDir: string;
  log: vscode.OutputChannel;
  index: StepIndex;
}

export interface GroupRun {
  project: JavaProject;
  selections: FeatureSelection[];
  /** Leaf items keyed by caseKey(). */
  leaves: Map<string, vscode.TestItem>;
  run: vscode.TestRun;
  token: vscode.CancellationToken;
  debug: boolean;
  cfg: RunnerConfig;
}

const classpathCache = new Map<string, string[]>();

export function caseKey(fsPath: string, line: number): string {
  const p = path.normalize(fsPath);
  return `${process.platform === 'win32' ? p.toLowerCase() : p}#${line}`;
}

const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

class OutputTail {
  private text = '';
  constructor(private readonly max = 12000) {}
  add(s: string) {
    this.text = (this.text + s).slice(-this.max);
  }
  get value() {
    return this.text.trim();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function pruneOldRuns(runsDir: string, keep = 5): void {
  try {
    const dirs = fs
      .readdirSync(runsDir)
      .map((d) => path.join(runsDir, d))
      .filter((d) => fs.statSync(d).isDirectory())
      .sort();
    for (const d of dirs.slice(0, Math.max(0, dirs.length - keep))) fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function buildClasspath(ctx: ExecContext, g: GroupRun, tail: OutputTail): Promise<string[] | undefined> {
  const key = projectKey(g.project);
  if (!g.cfg.compileBeforeRun && classpathCache.has(key)) return classpathCache.get(key);

  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  const outFile = path.join(ctx.storageDir, 'classpath', `${hash}.txt`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  try {
    fs.rmSync(outFile, { force: true });
  } catch {
    /* ignore */
  }

  let spec;
  if (g.project.tool === 'maven') {
    spec = mavenClasspathCommand(g.project, mavenExecutable(g.project, g.cfg.mavenExecutable), outFile, g.cfg.mavenArgs);
  } else {
    const init = path.join(ctx.storageDir, 'gherkin-runner-init.gradle');
    fs.writeFileSync(init, GRADLE_INIT_SCRIPT);
    spec = gradleClasspathCommand(g.project, gradleExecutable(g.project, g.cfg.gradleExecutable), init, outFile, g.cfg.gradleArgs);
  }

  const header = `▶ Compiling tests with ${g.project.tool === 'maven' ? 'Maven' : 'Gradle'}: ${spec.command} ${spec.args.join(' ')}\n`;
  g.run.appendOutput(crlf(header));
  ctx.log.appendLine(`[run] (cwd ${spec.cwd}) ${spec.command} ${spec.args.join(' ')}`);

  const proc = startProcess({
    ...spec,
    env: { ...process.env, ...g.cfg.env },
    onStdout: (t) => {
      tail.add(t);
      g.run.appendOutput(crlf(t));
    },
    onStderr: (t) => {
      tail.add(t);
      g.run.appendOutput(crlf(t));
    },
  });
  const sub = g.token.onCancellationRequested(() => proc.kill());
  const code = await proc.exit;
  sub.dispose();
  if (g.token.isCancellationRequested) return undefined;
  if (code !== 0 || !fs.existsSync(outFile)) {
    ctx.log.appendLine(`[run] build failed with exit code ${code}`);
    return undefined;
  }
  const raw = fs.readFileSync(outFile, 'utf8').trim();
  const cp =
    g.project.tool === 'maven'
      ? mavenFullClasspath(g.project.moduleDir, raw)
      : raw.split(path.delimiter).filter(Boolean);
  classpathCache.set(key, cp);
  return cp;
}

function resolveGlueFor(ctx: ExecContext, g: GroupRun, props: Record<string, string>) {
  return resolveGlue({
    configured: g.cfg.glue,
    properties: props,
    runnerGlue: ctx.index.runnerGlueUnder(g.project.moduleDir),
    detectedPackages: ctx.index.gluePackagesUnder(g.project.moduleDir),
  });
}

export function hasJavaDebugger(): boolean {
  return !!vscode.extensions.getExtension('vscjava.vscode-java-debug');
}

export async function runGroup(ctx: ExecContext, g: GroupRun): Promise<void> {
  const { run, project } = g;
  const leafItems = [...g.leaves.values()];
  const reported = new Set<vscode.TestItem>();
  const tail = new OutputTail();

  const errorAll = (msg: string) => {
    for (const item of leafItems) if (!reported.has(item)) run.errored(item, new vscode.TestMessage(msg));
  };

  // 1. Compile + classpath
  const classpath = await buildClasspath(ctx, g, tail);
  if (!classpath) {
    if (g.token.isCancellationRequested) leafItems.forEach((i) => run.skipped(i));
    else errorAll(`Build failed — the tests were not run.\n\n${tail.value.slice(-4000)}`);
    return;
  }

  // 2. Cucumber + JVM arguments
  await ctx.index.whenReady;
  const props = readCucumberProperties(project.moduleDir);
  const glue = resolveGlueFor(ctx, g, props);
  ctx.log.appendLine(`[run] glue (${glue.source}): ${glue.glue.join(', ') || '(Cucumber default)'}`);

  const java = resolveJava(g.cfg.javaHome);
  const runsDir = path.join(ctx.storageDir, 'runs');
  pruneOldRuns(runsDir);
  const runDir = path.join(runsDir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(runDir, { recursive: true });
  const messageFile = path.join(runDir, 'messages.ndjson');

  const debugPort = g.debug ? await freePort() : undefined;
  const jvm = jvmArgs({
    vmArgs: g.cfg.vmArgs,
    systemProperties: forwardedSystemProperties(props, g.cfg.prettyOutput),
    debugPort,
    javaMajor: java.major,
  });
  const cuke = cucumberArgs({
    messageFile,
    glue: glue.glue,
    extraArgs: g.cfg.cucumberArgs,
    features: g.selections,
  });

  const env: NodeJS.ProcessEnv = { ...process.env, ...g.cfg.env };
  let args: string[];
  if (java.major >= 9) {
    const argFile = path.join(runDir, 'java-args.txt');
    fs.writeFileSync(argFile, argFileContent([...jvm, '-cp', classpath.join(path.delimiter), CUCUMBER_MAIN, ...cuke]));
    args = [`@${argFile}`];
  } else {
    env.CLASSPATH = classpath.join(path.delimiter);
    args = [...jvm, CUCUMBER_MAIN, ...cuke];
  }

  const shown = [java.executable, ...jvm, '-cp', '<test classpath>', CUCUMBER_MAIN, ...cuke].join(' ');
  run.appendOutput(crlf(`\n▶ Running Cucumber (Java ${java.major} from ${java.source})${g.debug ? ' in debug mode' : ''}\n${shown}\n\n`));
  ctx.log.appendLine(`[run] (cwd ${project.moduleDir}) ${shown}`);

  // 3. Result processing
  const running = new Map<string, vscode.TestItem>();
  const lookup = (key: CaseKey): vscode.TestItem | undefined => {
    const direct = g.leaves.get(caseKey(key.featurePath, key.line));
    if (direct) return direct;
    // classpath:features/x.feature -> match by path suffix
    const suffix = key.featurePath.replace(/^classpath:/, '').replace(/\\/g, '/');
    for (const [k, item] of g.leaves) {
      const [p, l] = [k.slice(0, k.lastIndexOf('#')), Number(k.slice(k.lastIndexOf('#') + 1))];
      if (l === key.line && p.replace(/\\/g, '/').toLowerCase().endsWith(suffix.toLowerCase())) return item;
    }
    return undefined;
  };

  const processor = new CucumberMessageProcessor({
    onCaseStarted: (key, id, name) => {
      const item = lookup(key);
      if (item) {
        running.set(id, item);
        run.started(item);
      }
      if (g.cfg.prettyOutput) run.appendOutput(crlf(formatScenarioHeader(name, key)), undefined, item);
    },
    onStepFinished: (step, id) => {
      const text = g.cfg.prettyOutput ? formatStep(step) : '';
      if (text) run.appendOutput(crlf(text), undefined, running.get(id));
    },
    onCaseFinished: (result) => {
      const item = lookup(result);
      if (!item) return;
      for (const [id, it] of running) if (it === item) running.delete(id);
      reported.add(item);
      applyResult(ctx, run, item, result);
    },
    onAttachment: (text, id) => {
      const item = id ? running.get(id) : undefined;
      run.appendOutput(crlf(text.endsWith('\n') ? text : text + '\n'), undefined, item);
    },
    onParseError: (e) => ctx.log.appendLine(`[run] could not parse a Cucumber message: ${e}`),
  });

  let offset = 0;
  const readMessages = () => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(messageFile, 'r');
      const size = fs.fstatSync(fd).size;
      if (size > offset) {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        processor.feed(buf.toString('utf8'));
      }
    } catch {
      /* not created yet */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };

  // 4. Launch
  const singleRunning = () => (running.size === 1 ? running.values().next().value : undefined);
  let debugSession: vscode.DebugSession | undefined;
  let attachRequested = false;
  const runId = crypto.randomBytes(6).toString('hex');
  const disposables: vscode.Disposable[] = [];

  const proc = startProcess({
    command: java.executable,
    args,
    cwd: project.moduleDir,
    env,
    onStdout: (t) => {
      tail.add(t);
      // Print finished steps first so console output lands after the step it follows.
      readMessages();
      run.appendOutput(crlf(t), undefined, singleRunning());
      if (g.debug && !attachRequested && /Listening for transport dt_socket at address/.test(t)) {
        attachRequested = true;
        void attach();
      }
    },
    onStderr: (t) => {
      tail.add(t);
      run.appendOutput(crlf(t), undefined, singleRunning());
    },
  });

  const attach = async () => {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.moduleDir));
    const config: vscode.DebugConfiguration = {
      type: 'java',
      request: 'attach',
      name: `Cucumber: ${path.basename(project.moduleDir)}`,
      hostName: '127.0.0.1',
      port: debugPort,
      timeout: 30000,
      __gherkinRunId: runId,
    };
    const ok = await vscode.debug.startDebugging(folder, config);
    if (!ok) {
      run.appendOutput(crlf('\nCould not attach the Java debugger — stopping the test JVM.\n'));
      proc.kill();
    }
  };

  if (g.debug) {
    disposables.push(
      vscode.debug.onDidStartDebugSession((s) => {
        if (s.configuration.__gherkinRunId === runId) debugSession = s;
      }),
      vscode.debug.onDidTerminateDebugSession((s) => {
        // User pressed Stop: the JVM keeps running after the debugger detaches, so end it.
        if (s.configuration.__gherkinRunId === runId) setTimeout(() => proc.kill(), 1500);
      }),
    );
    const timer = setTimeout(() => {
      if (!attachRequested) {
        run.appendOutput(crlf(`\nThe test JVM did not open its debug port within ${g.cfg.attachTimeoutSeconds}s — stopping.\n`));
        proc.kill();
      }
    }, g.cfg.attachTimeoutSeconds * 1000);
    disposables.push({ dispose: () => clearTimeout(timer) });
  }

  disposables.push(g.token.onCancellationRequested(() => {
    proc.kill();
    if (debugSession) void vscode.debug.stopDebugging(debugSession);
  }));

  const poll = setInterval(readMessages, 250);
  const code = await proc.exit;
  clearInterval(poll);
  readMessages();
  processor.end();
  disposables.forEach((d) => d.dispose());
  if (debugSession) void vscode.debug.stopDebugging(debugSession);
  ctx.log.appendLine(`[run] cucumber exited with code ${code}`);

  if (g.cfg.summaryTable && processor.finished.length) {
    run.appendOutput(crlf(formatSummaryHeader(processor.finished)));
    for (const r of processor.finished) run.appendOutput(crlf(formatCaseSummary(r)), undefined, lookup(r));
  }

  // 5. Anything we asked for but did not get a result for
  const missing = leafItems.filter((i) => !reported.has(i));
  if (!missing.length) return;
  if (g.token.isCancellationRequested) {
    missing.forEach((i) => run.skipped(i));
  } else if (processor.finished.length === 0 && code !== 0) {
    const hint = /ClassNotFoundException: io\.cucumber\.core\.cli\.Main|Could not find or load main class io\.cucumber/.test(tail.value)
      ? 'cucumber-java (cucumber-core) was not found on the test classpath. Add io.cucumber:cucumber-java as a test dependency.\n\n'
      : '';
    errorAll(`Cucumber exited with code ${code} before reporting results.\n\n${hint}${tail.value.slice(-4000)}`);
  } else {
    for (const i of missing) {
      run.skipped(i);
    }
    run.appendOutput(crlf(`\n${missing.length} selected scenario(s) did not run (unsaved edits, or filtered out by Cucumber options).\n`));
  }
}

function applyResult(ctx: ExecContext, run: vscode.TestRun, item: vscode.TestItem, r: CaseResult): void {
  const uri = item.uri!;
  const location = new vscode.Location(uri, new vscode.Position(Math.max(0, (r.stepLine ?? r.line) - 1), 0));
  const withLocation = (m: vscode.TestMessage) => {
    m.location = location;
    return m;
  };
  switch (r.status) {
    case 'PASSED':
      run.passed(item, r.durationMs);
      return;
    case 'SKIPPED':
      run.skipped(item);
      return;
    case 'FAILED': {
      const text = r.message ?? 'Step failed';
      const parsed = parseAssertion(text);
      const msg =
        parsed.expected !== undefined && parsed.actual !== undefined
          ? vscode.TestMessage.diff(text, parsed.expected, parsed.actual)
          : new vscode.TestMessage(text);
      withLocation(msg);
      msg.stackTrace = stackFrames(ctx, text);
      run.failed(item, msg, r.durationMs);
      return;
    }
    case 'UNDEFINED': {
      const snippet = r.snippets.length ? `\n\nYou can implement it with:\n\n${r.snippets.join('\n\n')}` : '';
      run.errored(item, withLocation(new vscode.TestMessage(`Undefined step: ${r.stepText ?? ''}${snippet}`)), r.durationMs);
      return;
    }
    case 'PENDING':
      run.errored(item, withLocation(new vscode.TestMessage(`Pending step: ${r.stepText ?? ''}\n${r.message ?? ''}`.trim())), r.durationMs);
      return;
    case 'AMBIGUOUS':
      run.errored(item, withLocation(new vscode.TestMessage(r.message ?? `Ambiguous step: ${r.stepText ?? ''}`)), r.durationMs);
      return;
    default:
      run.errored(item, withLocation(new vscode.TestMessage(r.message ?? `Unknown result for ${r.scenarioName ?? 'scenario'}`)), r.durationMs);
  }
}

function stackFrames(ctx: ExecContext, text: string): vscode.TestMessageStackFrame[] | undefined {
  const frames: vscode.TestMessageStackFrame[] = [];
  for (const f of parseJavaStackFrames(text)) {
    if (/^(java|javax|jdk|sun|org\.junit|org\.opentest4j|org\.assertj|org\.hamcrest|io\.cucumber)\./.test(f.className)) continue;
    const src = ctx.index.findSource(f.file, f.className);
    frames.push(
      new vscode.TestMessageStackFrame(
        `${f.className}.${f.method}(${f.file}:${f.line})`,
        src,
        src ? new vscode.Position(f.line - 1, 0) : undefined,
      ),
    );
    if (frames.length >= 15) break;
  }
  return frames.length ? frames : undefined;
}
