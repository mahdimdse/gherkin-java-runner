import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { parseRunnerGlue } from './glue';
import { StepMatcher } from './stepMatcher';
import { parseStepSource, SourceInfo, StepDefinition } from './stepParser';

export interface IndexedStep extends StepDefinition {
  uri: vscode.Uri;
}

/** Workspace-wide index of Java/Kotlin step definitions, parameter types and glue packages. */
export class StepIndex implements vscode.Disposable {
  private files = new Map<string, { uri: vscode.Uri; info: SourceInfo; runnerGlue: string[] }>();
  private matcher = new StepMatcher();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private disposables: vscode.Disposable[] = [this.changed];
  private ready: Promise<void> | undefined;
  private pending = new Set<string>();
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(private readonly log: vscode.OutputChannel) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{java,kt}');
    this.disposables.push(
      watcher,
      watcher.onDidCreate((u) => this.queue(u)),
      watcher.onDidChange((u) => this.queue(u)),
      watcher.onDidDelete((u) => this.remove(u)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (/\.(java|kt)$/.test(e.document.fileName)) this.queue(e.document.uri, e.document.getText());
      }),
    );
  }

  get whenReady(): Promise<void> {
    return (this.ready ??= this.rebuild());
  }

  async rebuild(): Promise<void> {
    const cfg = getConfig();
    const started = Date.now();
    const uris = await vscode.workspace.findFiles(cfg.stepDefinitionGlob, cfg.exclude);
    this.files.clear();
    const batch = 64;
    for (let i = 0; i < uris.length; i += batch) {
      await Promise.all(uris.slice(i, i + batch).map((u) => this.indexFile(u)));
    }
    this.refreshMatcher();
    this.log.appendLine(
      `[steps] indexed ${this.stepCount()} step definitions in ${this.files.size} files (${Date.now() - started} ms)`,
    );
    this.changed.fire();
  }

  private async indexFile(uri: vscode.Uri, text?: string): Promise<void> {
    try {
      const source = text ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      if (!source.includes('io.cucumber')) {
        this.files.delete(uri.fsPath);
        return;
      }
      this.files.set(uri.fsPath, { uri, info: parseStepSource(source), runnerGlue: parseRunnerGlue(source) });
    } catch (e: any) {
      this.log.appendLine(`[steps] failed to index ${uri.fsPath}: ${e?.message ?? e}`);
    }
  }

  private queue(uri: vscode.Uri, text?: string): void {
    if (!/\.(java|kt)$/.test(uri.fsPath) || /[\\/](target|build|out|bin|node_modules)[\\/]/.test(uri.fsPath)) return;
    if (text !== undefined) {
      void this.indexFile(uri, text).then(() => this.scheduleFlush());
      return;
    }
    this.pending.add(uri.toString());
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(async () => {
      const uris = [...this.pending].map((u) => vscode.Uri.parse(u));
      this.pending.clear();
      await Promise.all(uris.map((u) => this.indexFile(u)));
      this.refreshMatcher();
      this.changed.fire();
    }, 300);
  }

  private remove(uri: vscode.Uri): void {
    if (this.files.delete(uri.fsPath)) {
      this.refreshMatcher();
      this.changed.fire();
    }
  }

  private refreshMatcher(): void {
    this.matcher.setParameterTypes([...this.files.values()].flatMap((f) => f.info.parameterTypes));
  }

  stepCount(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.info.steps.length;
    return n;
  }

  *steps(): Iterable<IndexedStep> {
    for (const f of this.files.values()) for (const s of f.info.steps) yield { ...s, uri: f.uri };
  }

  findDefinitions(candidateTexts: string[]): IndexedStep[] {
    return this.matcher.findMatches(this.steps(), candidateTexts);
  }

  /** Packages of glue classes (steps, hooks, DI config) located inside `moduleDir`. */
  gluePackagesUnder(moduleDir: string): string[] {
    const prefix = moduleDir.endsWith(path.sep) ? moduleDir : moduleDir + path.sep;
    const out = new Set<string>();
    for (const [fsPath, f] of this.files) {
      if (fsPath.startsWith(prefix) && f.info.isGlue && f.info.packageName) out.add(f.info.packageName);
    }
    return [...out];
  }

  /** Glue declared on runner classes (@ConfigurationParameter / @CucumberOptions) inside `moduleDir`. */
  runnerGlueUnder(moduleDir: string): string[] {
    const prefix = moduleDir.endsWith(path.sep) ? moduleDir : moduleDir + path.sep;
    const out = new Set<string>();
    for (const [fsPath, f] of this.files) if (fsPath.startsWith(prefix)) f.runnerGlue.forEach((g) => out.add(g));
    return [...out];
  }

  /** Locate a source file by simple file name + class name (for stack-trace links). */
  findSource(fileName: string, className: string): vscode.Uri | undefined {
    const pkg = className.includes('.') ? className.slice(0, className.lastIndexOf('.')) : '';
    let fallback: vscode.Uri | undefined;
    for (const [fsPath, f] of this.files) {
      if (path.basename(fsPath) !== fileName) continue;
      if (f.info.packageName === pkg) return f.uri;
      fallback ??= f.uri;
    }
    return fallback;
  }

  dispose(): void {
    clearTimeout(this.flushTimer);
    for (const d of this.disposables) d.dispose();
  }
}
