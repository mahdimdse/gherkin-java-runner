// Incremental processor for Cucumber's `message` (NDJSON) output. Pure, no vscode import.
import { fileURLToPath } from 'url';

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
}

export interface ProcessorEvents {
  onCaseStarted?(key: CaseKey, testCaseStartedId: string): void;
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
  steps: Map<string, { text: string; astNodeIds: string[] }>;
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
}

export class CucumberMessageProcessor {
  private lineOfAstNode = new Map<string, number>();
  private pickles = new Map<string, PickleInfo>();
  private testCases = new Map<string, { pickleId: string; steps: Map<string, string | undefined> }>();
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
    else if (env.testCase) this.onTestCase(env.testCase);
    else if (env.testCaseStarted) this.onTestCaseStarted(env.testCaseStarted);
    else if (env.testStepFinished) this.onTestStepFinished(env.testStepFinished);
    else if (env.testCaseFinished) this.onTestCaseFinished(env.testCaseFinished);
    else if (env.suggestion) this.onSuggestion(env.suggestion);
    else if (env.attachment) this.onAttachment(env.attachment);
  }

  private onGherkinDocument(doc: any): void {
    const visitScenario = (sc: any) => {
      this.lineOfAstNode.set(sc.id, sc.location.line);
      for (const st of sc.steps ?? []) this.lineOfAstNode.set(st.id, st.location.line);
      for (const ex of sc.examples ?? []) {
        for (const row of ex.tableBody ?? []) this.lineOfAstNode.set(row.id, row.location.line);
      }
    };
    const visitBackground = (bg: any) => {
      for (const st of bg.steps ?? []) this.lineOfAstNode.set(st.id, st.location.line);
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
    const steps = new Map<string, { text: string; astNodeIds: string[] }>();
    for (const s of p.steps ?? []) steps.set(s.id, { text: s.text, astNodeIds: s.astNodeIds ?? [] });
    this.pickles.set(p.id, { uri: p.uri, name: p.name, astNodeIds: p.astNodeIds ?? [], steps });
  }

  private onTestCase(tc: any): void {
    const steps = new Map<string, string | undefined>();
    for (const s of tc.testSteps ?? []) steps.set(s.id, s.pickleStepId);
    this.testCases.set(tc.id, { pickleId: tc.pickleId, steps });
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
    });
    this.events.onCaseStarted?.(key, tcs.id);
  }

  private onTestStepFinished(tsf: any): void {
    const r = this.running.get(tsf.testCaseStartedId);
    if (!r) return;
    const result = tsf.testStepResult ?? {};
    const status: CucumberStatus = result.status ?? 'UNKNOWN';
    const tc = this.testCases.get(r.testCaseId);
    const pickle = tc && this.pickles.get(tc.pickleId);
    const pickleStepId = tc?.steps.get(tsf.testStepId);
    if (pickleStepId) r.pickleStepIds.push(pickleStepId);
    if (SEVERITY[status] > SEVERITY[r.worst]) {
      r.worst = status;
      const exception = result.exception;
      r.message =
        result.message ??
        (exception ? [exception.type, exception.message].filter(Boolean).join(': ') + (exception.stackTrace ? '\n' + exception.stackTrace : '') : undefined);
      const ps = pickleStepId ? pickle?.steps.get(pickleStepId) : undefined;
      r.stepLine = ps ? this.lineOfAstNode.get(ps.astNodeIds[0]) : r.key.line;
      r.stepText = ps?.text;
    }
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
    };
    this.finished.push(result);
    this.events.onCaseFinished?.(result);
  }
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
