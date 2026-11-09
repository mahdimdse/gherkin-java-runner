// Incremental processor for Cucumber's `message` (NDJSON) output. Pure, no vscode import.
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export type CucumberStatus = 'PASSED' | 'FAILED' | 'AMBIGUOUS' | 'UNDEFINED' | 'PENDING' | 'SKIPPED' | 'UNKNOWN';

export interface CaseKey {
  /** Feature path (file system path when the URI is file:, otherwise the raw URI). */
  featurePath: string;
  /** Leaf line: the scenario line, or the Examples row line for outlines. */
  line: number;
}

export interface CaseResult extends CaseKey {
  status: CucumberStatus;
  durationMs?: number;
  /** Error / exception text for the failing step. */
  message?: string;
  /** Line of the failing / undefined step (hooks fall back to the scenario line). */
  stepLine?: number;
  stepText?: string;
  /** Snippets suggested for undefined steps. */
  snippets: string[];
  scenarioName?: string;
  /** Every step and hook of the final attempt, in order. */
  steps: StepReport[];
}

export type HookKind = 'Before' | 'After' | 'BeforeStep' | 'AfterStep' | 'Hook';

/** One finished step or hook, for the step-by-step console output. */
export interface StepReport {
  /** Gherkin keyword ('Given ', 'And ', …) for steps; undefined for hooks. */
  keyword?: string;
  hook?: HookKind;
  /** Step text, or the hook's name / Java method. */
  text: string;
  /** Line of the step in the feature file; undefined for hooks. */
  line?: number;
  status: CucumberStatus;
  durationMs?: number;
  error?: string;
  docString?: string;
  dataTable?: string[][];
}

export interface ProcessorEvents {
  onCaseStarted?(key: CaseKey, testCaseStartedId: string, scenarioName: string): void;
  onStepFinished?(step: StepReport, testCaseStartedId: string): void;
  onCaseFinished?(result: CaseResult): void;
  onAttachment?(text: string, testCaseStartedId?: string): void;
  onParseError?(err: string): void;
}

const SEVERITY: Record<CucumberStatus, number> = {
  PASSED: 0,
  UNKNOWN: 1,
  SKIPPED: 2,
  PENDING: 3,
  UNDEFINED: 4,
  AMBIGUOUS: 5,
  FAILED: 6,
};

interface Timestamp {
  seconds: number | string;
  nanos: number;
}

const tsMs = (t?: Timestamp) => (t ? Number(t.seconds) * 1000 + t.nanos / 1e6 : undefined);

const HOOK_TYPES: Record<string, HookKind> = {
  BEFORE_TEST_CASE: 'Before',
  AFTER_TEST_CASE: 'After',
  BEFORE_TEST_STEP: 'BeforeStep',
  AFTER_TEST_STEP: 'AfterStep',
};

/** Newer Cucumber puts only the short text in `message` and the full trace in `exception.stackTrace`. */
function resultMessage(result: any): string | undefined {
  const exception = result.exception;
  if (exception?.stackTrace) return String(exception.stackTrace).replace(/\r\n/g, '\n');
  return result.message ?? (exception ? [exception.type, exception.message].filter(Boolean).join(': ') : undefined);
}

export function uriToPath(uri: string): string {
  if (uri.startsWith('file:')) {
    try {
      return fileURLToPath(new URL(uri));
    } catch {
      return uri.replace(/^file:\/*/, '/');
    }
  }
  return uri;
}

interface PickleInfo {
  uri: string;
  name: string;
  astNodeIds: string[];
  steps: Map<string, PickleStepInfo>;
}

interface PickleStepInfo {
  text: string;
  astNodeIds: string[];
  docString?: string;
  dataTable?: string[][];
}

interface TestStepInfo {
  pickleStepId?: string;
  hookId?: string;
  index: number;
}

interface TestCaseInfo {
  pickleId: string;
  steps: Map<string, TestStepInfo>;
  firstPickleStep: number;
  lastPickleStep: number;
}

interface Running {
  key: CaseKey;
  testCaseId: string;
  start?: number;
  worst: CucumberStatus;
  message?: string;
  stepLine?: number;
  stepText?: string;
  pickleStepIds: string[];
  steps: StepReport[];
}

export class CucumberMessageProcessor {
  private lineOfAstNode = new Map<string, number>();
  private keywordOfAstNode = new Map<string, string>();
  private hooks = new Map<string, { kind?: HookKind; label: string }>();
  private pickles = new Map<string, PickleInfo>();
  private testCases = new Map<string, TestCaseInfo>();
  private running = new Map<string, Running>();
  private snippetsByPickleStep = new Map<string, string[]>();
  private buffer = '';
  readonly finished: CaseResult[] = [];

  constructor(private readonly events: ProcessorEvents = {}) {}

  /** Feed raw chunk data; partial lines are buffered. */
  feed(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  /** Flush any trailing line without newline. */
  end(): void {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) this.handleLine(rest);
  }

  private handleLine(line: string): void {
    let env: any;
    try {
      env = JSON.parse(line);
    } catch (e: any) {
      this.events.onParseError?.(String(e?.message ?? e));
      return;
    }
    if (env.gherkinDocument) this.onGherkinDocument(env.gherkinDocument);
    else if (env.pickle) this.onPickle(env.pickle);
    else if (env.hook) this.onHook(env.hook);
    else if (env.testCase) this.onTestCase(env.testCase);
    else if (env.testCaseStarted) this.onTestCaseStarted(env.testCaseStarted);
    else if (env.testStepFinished) this.onTestStepFinished(env.testStepFinished);
    else if (env.testCaseFinished) this.onTestCaseFinished(env.testCaseFinished);
    else if (env.suggestion) this.onSuggestion(env.suggestion);
    else if (env.attachment) this.onAttachment(env.attachment);
  }

  private onGherkinDocument(doc: any): void {
    const visitStep = (st: any) => {
      this.lineOfAstNode.set(st.id, st.location.line);
      if (st.keyword) this.keywordOfAstNode.set(st.id, st.keyword);
    };
    const visitScenario = (sc: any) => {
      this.lineOfAstNode.set(sc.id, sc.location.line);
      for (const st of sc.steps ?? []) visitStep(st);
      for (const ex of sc.examples ?? []) {
        for (const row of ex.tableBody ?? []) this.lineOfAstNode.set(row.id, row.location.line);
      }
    };
    const visitBackground = (bg: any) => {
      for (const st of bg.steps ?? []) visitStep(st);
    };
    for (const child of doc.feature?.children ?? []) {
      if (child.scenario) visitScenario(child.scenario);
      if (child.background) visitBackground(child.background);
      for (const rc of child.rule?.children ?? []) {
        if (rc.scenario) visitScenario(rc.scenario);
        if (rc.background) visitBackground(rc.background);
      }
    }
  }

  private onPickle(p: any): void {
    const steps = new Map<string, PickleStepInfo>();
    for (const s of p.steps ?? []) {
      steps.set(s.id, {
        text: s.text,
        astNodeIds: s.astNodeIds ?? [],
        docString: s.argument?.docString?.content,
        dataTable: s.argument?.dataTable?.rows?.map((r: any) => (r.cells ?? []).map((c: any) => String(c.value ?? ''))),
      });
    }
    this.pickles.set(p.id, { uri: p.uri, name: p.name, astNodeIds: p.astNodeIds ?? [], steps });
  }

  private onHook(h: any): void {
    const m = h.sourceReference?.javaMethod;
    const label = h.name || (m ? `${String(m.className).split('.').pop()}.${m.methodName}()` : h.tagExpression ?? '');
    this.hooks.set(h.id, { kind: HOOK_TYPES[h.type], label });
  }

  private onTestCase(tc: any): void {
    const steps = new Map<string, TestStepInfo>();
    let firstPickleStep = Infinity;
    let lastPickleStep = -1;
    (tc.testSteps ?? []).forEach((s: any, index: number) => {
      steps.set(s.id, { pickleStepId: s.pickleStepId, hookId: s.hookId, index });
      if (s.pickleStepId) {
        firstPickleStep = Math.min(firstPickleStep, index);
        lastPickleStep = index;
      }
    });
    this.testCases.set(tc.id, { pickleId: tc.pickleId, steps, firstPickleStep, lastPickleStep });
  }

  /** Older Cucumber versions omit the hook type, so infer it from the position in the test case. */
  private hookKind(tc: TestCaseInfo, step: TestStepInfo): HookKind {
    const known = step.hookId ? this.hooks.get(step.hookId)?.kind : undefined;
    if (known) return known;
    if (step.index < tc.firstPickleStep) return 'Before';
    if (step.index > tc.lastPickleStep) return 'After';
    return 'Hook';
  }

  private keyForPickle(p: PickleInfo): CaseKey {
    const ids = p.astNodeIds;
    const leafId = ids.length > 1 ? ids[ids.length - 1] : ids[0];
    const line = this.lineOfAstNode.get(leafId) ?? this.lineOfAstNode.get(ids[0]) ?? 0;
    return { featurePath: uriToPath(p.uri), line };
  }

  private onTestCaseStarted(tcs: any): void {
    const tc = this.testCases.get(tcs.testCaseId);
    const pickle = tc && this.pickles.get(tc.pickleId);
    if (!tc || !pickle) return;
    const key = this.keyForPickle(pickle);
    this.running.set(tcs.id, {
      key,
      testCaseId: tcs.testCaseId,
      start: tsMs(tcs.timestamp),
      worst: 'PASSED',
      pickleStepIds: [],
      steps: [],
    });
    this.events.onCaseStarted?.(key, tcs.id, pickle.name);
  }

  private onTestStepFinished(tsf: any): void {
    const r = this.running.get(tsf.testCaseStartedId);
    if (!r) return;
    const result = tsf.testStepResult ?? {};
    const status: CucumberStatus = result.status ?? 'UNKNOWN';
    const tc = this.testCases.get(r.testCaseId);
    const pickle = tc && this.pickles.get(tc.pickleId);
    const testStep = tc?.steps.get(tsf.testStepId);
    const pickleStepId = testStep?.pickleStepId;
    if (pickleStepId) r.pickleStepIds.push(pickleStepId);
    const ps = pickleStepId ? pickle?.steps.get(pickleStepId) : undefined;
    const message = resultMessage(result);
    if (SEVERITY[status] > SEVERITY[r.worst]) {
      r.worst = status;
      r.message = message;
      r.stepLine = ps ? this.lineOfAstNode.get(ps.astNodeIds[0]) : r.key.line;
      r.stepText = ps?.text;
    }
    if (!tc || !testStep) return;
    const report: StepReport = ps
      ? {
          keyword: this.keywordOfAstNode.get(ps.astNodeIds[0]) ?? '* ',
          text: ps.text,
          line: this.lineOfAstNode.get(ps.astNodeIds[0]),
          docString: ps.docString,
          dataTable: ps.dataTable,
          status,
        }
      : { hook: this.hookKind(tc, testStep), text: (testStep.hookId && this.hooks.get(testStep.hookId)?.label) || '', status };
    report.durationMs = tsMs(result.duration);
    if (status !== 'PASSED' && status !== 'SKIPPED') report.error = message;
    r.steps.push(report);
    this.events.onStepFinished?.(report, tsf.testCaseStartedId);
  }

  private onSuggestion(s: any): void {
    const list = this.snippetsByPickleStep.get(s.pickleStepId) ?? [];
    for (const sn of s.snippets ?? []) if (sn.code) list.push(sn.code);
    this.snippetsByPickleStep.set(s.pickleStepId, list);
  }

  private onAttachment(a: any): void {
    if (!a.body) return;
    const media = String(a.mediaType ?? '');
    if (!media.startsWith('text/') && media !== 'application/json') return;
    const text = a.contentEncoding === 'BASE64' ? Buffer.from(a.body, 'base64').toString('utf8') : a.body;
    this.events.onAttachment?.(text, a.testCaseStartedId);
  }

  private onTestCaseFinished(tcf: any): void {
    const r = this.running.get(tcf.testCaseStartedId);
    if (!r) return;
    this.running.delete(tcf.testCaseStartedId);
    if (tcf.willBeRetried) return;
    const tc = this.testCases.get(r.testCaseId);
    const pickle = tc && this.pickles.get(tc.pickleId);
    const end = tsMs(tcf.timestamp);
    const snippets: string[] = [];
    for (const id of r.pickleStepIds) snippets.push(...(this.snippetsByPickleStep.get(id) ?? []));
    const result: CaseResult = {
      ...r.key,
      status: r.worst,
      durationMs: r.start !== undefined && end !== undefined ? Math.max(0, end - r.start) : undefined,
      message: r.message,
      stepLine: r.stepLine,
      stepText: r.stepText,
      snippets: [...new Set(snippets)],
      scenarioName: pickle?.name,
      steps: r.steps,
    };
    this.finished.push(result);
    this.events.onCaseFinished?.(result);
  }
}

const ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', grey: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

const STATUS_STYLE: Record<CucumberStatus, [icon: string, color: string]> = {
  PASSED: ['✔', ANSI.green],
  FAILED: ['✘', ANSI.red],
  AMBIGUOUS: ['✘', ANSI.red],
  UNDEFINED: ['?', ANSI.yellow],
  PENDING: ['?', ANSI.yellow],
  SKIPPED: ['↷', ANSI.cyan],
  UNKNOWN: ['•', ANSI.grey],
};

const indent = (text: string, by: string) => text.replace(/\r?\n$/, '').split(/\r?\n/).map((l) => by + l).join('\n') + '\n';

export function formatScenarioHeader(scenarioName: string, key: CaseKey): string {
  return `\n${ANSI.bold}Scenario: ${scenarioName}${ANSI.reset} ${ANSI.grey}# ${path.basename(key.featurePath)}:${key.line}${ANSI.reset}\n`;
}

/** Passing BeforeStep/AfterStep hooks run around every step, so they are left out (too noisy). */
const isQuietHook = (s: StepReport) =>
  !!s.hook && s.hook !== 'Before' && s.hook !== 'After' && (s.status === 'PASSED' || s.status === 'SKIPPED');

/** One step or hook as console text with ANSI colours; '' for quiet hooks. */
export function formatStep(s: StepReport): string {
  if (isQuietHook(s)) return '';
  const [icon, color] = STATUS_STYLE[s.status];
  let out = s.hook
    ? `  ${color}${icon} ${s.hook}${ANSI.reset} ${ANSI.grey}${s.text}${s.durationMs !== undefined ? ` (${Math.round(s.durationMs)} ms)` : ''}${ANSI.reset}\n`
    : `  ${color}${icon} ${s.keyword}${s.text}${ANSI.reset}\n`;
  if (s.docString !== undefined) out += indent(`"""\n${s.docString}\n"""`, '      ');
  if (s.dataTable?.length) {
    const widths = s.dataTable[0].map((_, c) => Math.max(...s.dataTable!.map((r) => (r[c] ?? '').length)));
    out += s.dataTable.map((r) => '      | ' + r.map((v, c) => v.padEnd(widths[c])).join(' | ') + ' |\n').join('');
  }
  if (s.error) out += ANSI.red + indent(s.error, '      ') + ANSI.reset;
  return out;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/** Opening line of the end-of-run summary: counts per status. */
export function formatSummaryHeader(results: CaseResult[]): string {
  const counts = new Map<CucumberStatus, number>();
  for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const parts = [...counts].map(([status, n]) => `${STATUS_STYLE[status][1]}${n} ${status.toLowerCase()}${ANSI.reset}`);
  return `\n${ANSI.bold}━━ Summary: ${results.length} scenario(s) ━━${ANSI.reset} ${parts.join(', ')}\n`;
}

/**
 * Terminal hyperlink (OSC 8): shows `text`, Ctrl+click opens the feature file at `line`.
 * Non-file feature paths (e.g. classpath:) stay plain text.
 */
function featureLink(featurePath: string, line: number, text: string): string {
  if (!path.isAbsolute(featurePath)) return text;
  return `\x1b]8;;${pathToFileURL(featurePath).href}#L${line}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** One scenario of the end-of-run summary: a title line and a table of its steps and hooks. */
export function formatCaseSummary(r: CaseResult, maxStepWidth = 70): string {
  const [icon, color] = STATUS_STYLE[r.status];
  const file = path.basename(r.featurePath);
  const time = r.durationMs !== undefined ? ` ${ANSI.grey}(${formatDuration(r.durationMs)})${ANSI.reset}` : '';
  const where = featureLink(r.featurePath, r.line, `${file}:${r.line}`);
  let out = `\n${ANSI.bold}${r.scenarioName ?? ''}${ANSI.reset} ${ANSI.grey}# ${where}${ANSI.reset}  ${color}${icon} ${r.status}${ANSI.reset}${time}\n`;
  const rows = r.steps
    .filter((s) => !isQuietHook(s))
    .map((s, i) => ({
      cells: [
        String(i + 1),
        truncate((s.hook ? `${s.hook} ${s.text}` : `${s.keyword ?? ''}${s.text}`).trim(), maxStepWidth),
        `${STATUS_STYLE[s.status][0]} ${s.status.toLowerCase()}`,
        formatDuration(s.durationMs),
        s.line !== undefined ? `${file}:${s.line}` : '',
      ],
      color: STATUS_STYLE[s.status][1],
      line: s.line,
    }));
  if (!rows.length) return out + `  ${ANSI.grey}(no steps reported)${ANSI.reset}\n`;

  const header = ['#', 'Step', 'Status', 'Time', 'Line'];
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((row) => row.cells[c].length)));
  // '#' and 'Time' are right-aligned
  const pad = (v: string, c: number) => (c === 0 || c === 3 ? v.padStart(widths[c]) : v.padEnd(widths[c]));
  const rule = (l: string, m: string, rt: string) => `  ${l}${widths.map((w) => '─'.repeat(w + 2)).join(m)}${rt}\n`;
  // Colours and links are added after padding, since escape sequences take no columns.
  const line = (cells: string[], style: (v: string, c: number) => string = (v) => v) =>
    '  │ ' + cells.map((v, c) => style(pad(v, c), c)).join(' │ ') + ' │\n';

  out += rule('┌', '┬', '┐') + line(header) + rule('├', '┼', '┤');
  for (const row of rows) {
    out += line(row.cells, (v, c) => {
      if (c === 2) return row.color + v + ANSI.reset;
      if (c === 4 && row.line !== undefined) return featureLink(r.featurePath, row.line, v.trimEnd()) + v.slice(v.trimEnd().length);
      return v;
    });
  }
  return out + rule('└', '┴', '┘');
}

export interface ParsedFailure {
  message: string;
  expected?: string;
  actual?: string;
}

/** Pull expected/actual out of common assertion messages (JUnit 5, JUnit 4, AssertJ, Hamcrest). */
export function parseAssertion(message: string): ParsedFailure {
  const firstBlock = message.split(/\n\s*at /)[0];
  const patterns: RegExp[] = [
    /expected:\s*<([\s\S]*?)>\s*but was:\s*<([\s\S]*?)>/, // JUnit 4/5
    /[Ee]xpected(?: value)?:\s*"?([\s\S]*?)"?\s*\n\s*(?:but was|Actual|actual):\s*"?([\s\S]*?)"?\s*$/m, // AssertJ / Hamcrest-ish
    /Expected:\s*([\s\S]*?)\n\s*but:\s*was\s*([\s\S]*?)$/m, // Hamcrest
  ];
  for (const re of patterns) {
    const m = re.exec(firstBlock);
    if (m) return { message, expected: m[1].trim(), actual: m[2].trim() };
  }
  return { message };
}

export interface StackFrame {
  className: string;
  method: string;
  file: string;
  line: number;
}

/** Java stack frames like `at com.acme.Steps.method(Steps.java:42)`. */
export function parseJavaStackFrames(message: string): StackFrame[] {
  const out: StackFrame[] = [];
  const re = /^\s*at\s+(?:[\w.$/@-]+\/)?([\w.$]+)\.([\w$<>]+)\(([\w$.-]+\.(?:java|kt)):(\d+)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message))) out.push({ className: m[1], method: m[2], file: m[3], line: Number(m[4]) });
  return out;
}
