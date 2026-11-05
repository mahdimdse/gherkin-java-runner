import * as vscode from 'vscode';
import { getConfig } from './config';
import { expandStepText, parseFeature, ParsedFeature, StepInfo } from './gherkinModel';
import { StepIndex } from './stepIndex';

export const FEATURE_SELECTOR: vscode.DocumentSelector = [{ pattern: '**/*.feature' }, { language: 'feature' }];

const cache = new Map<string, { version: number; parsed: ParsedFeature }>();

export function parsedDocument(doc: vscode.TextDocument): ParsedFeature {
  const key = doc.uri.toString();
  const hit = cache.get(key);
  if (hit && hit.version === doc.version) return hit.parsed;
  const parsed = parseFeature(doc.getText());
  cache.set(key, { version: doc.version, parsed });
  return parsed;
}

export function forgetDocument(uri: vscode.Uri): void {
  cache.delete(uri.toString());
}

const isFeature = (doc: vscode.TextDocument) => doc.uri.fsPath.endsWith('.feature');

function stepAt(doc: vscode.TextDocument, line0: number): StepInfo | undefined {
  return parsedDocument(doc).steps.find((s) => s.line - 1 === line0);
}

/** Ctrl+click / F12 / Peek on a step jumps to the matching Java step definition(s). */
export class StepDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly index: StepIndex) {}

  async provideDefinition(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.LocationLink[] | undefined> {
    const step = stepAt(doc, position.line);
    if (!step) return undefined;
    await this.index.whenReady;
    const defs = this.index.findDefinitions(expandStepText(step));
    if (!defs.length) return undefined;
    const origin = new vscode.Range(step.line - 1, step.keywordColumn, step.line - 1, step.textColumn + step.text.length);
    return defs.map((d) => {
      const pos = new vscode.Position(d.line, d.column);
      return {
        originSelectionRange: origin,
        targetUri: d.uri,
        targetRange: new vscode.Range(pos, pos.translate(3, 0)),
        targetSelectionRange: new vscode.Range(pos, pos),
      };
    });
  }
}

/** Hover shows which step definition a step is bound to. */
export class StepHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: StepIndex) {}

  async provideHover(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const step = stepAt(doc, position.line);
    if (!step || position.character < step.keywordColumn) return undefined;
    await this.index.whenReady;
    const defs = this.index.findDefinitions(expandStepText(step));
    if (!defs.length) return undefined;
    const md = new vscode.MarkdownString();
    for (const d of defs.slice(0, 5)) {
      const file = vscode.workspace.asRelativePath(d.uri);
      md.appendMarkdown(`**@${d.keyword}** \`${d.expression.replace(/`/g, "'")}\`  \n`);
      md.appendMarkdown(`${d.methodName ? d.methodName + '() — ' : ''}${file}:${d.line + 1}\n\n`);
    }
    if (defs.length > 1) md.appendMarkdown(`$(warning) ${defs.length} definitions match (ambiguous step)`);
    md.supportThemeIcons = true;
    return new vscode.Hover(md);
  }
}

/** Warnings for steps without a matching definition. */
export class UndefinedStepDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('gherkinRunner');
  private timers = new Map<string, NodeJS.Timeout>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly index: StepIndex) {
    this.disposables.push(
      this.collection,
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        this.collection.delete(d.uri);
        forgetDocument(d.uri);
      }),
      index.onDidChange(() => this.refreshAll()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gherkinRunner.diagnostics')) this.refreshAll();
      }),
    );
    void index.whenReady.then(() => this.refreshAll());
  }

  private refreshAll(): void {
    for (const d of vscode.workspace.textDocuments) this.schedule(d, 0);
  }

  private schedule(doc: vscode.TextDocument, delay = 400): void {
    if (!isFeature(doc)) return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => void this.update(doc), delay));
  }

  private async update(doc: vscode.TextDocument): Promise<void> {
    if (doc.isClosed) return;
    if (!getConfig(doc.uri).undefinedStepDiagnostics) {
      this.collection.delete(doc.uri);
      return;
    }
    await this.index.whenReady;
    if (this.index.stepCount() === 0) {
      // Nothing indexed (no Java sources in the workspace?) - stay quiet rather than flag every line.
      this.collection.delete(doc.uri);
      return;
    }
    const parsed = parsedDocument(doc);
    const diags: vscode.Diagnostic[] = [];
    if (parsed.error) {
      const line = Math.max(0, (parsed.errorLine ?? 1) - 1);
      diags.push(new vscode.Diagnostic(doc.lineAt(Math.min(line, doc.lineCount - 1)).range, parsed.error, vscode.DiagnosticSeverity.Error));
    }
    for (const step of parsed.steps) {
      const defs = this.index.findDefinitions(expandStepText(step));
      if (defs.length) continue;
      const range = new vscode.Range(step.line - 1, step.textColumn, step.line - 1, step.textColumn + step.text.length);
      const d = new vscode.Diagnostic(range, `Undefined step: no step definition matches "${step.text}"`, vscode.DiagnosticSeverity.Warning);
      d.source = 'cucumber';
      diags.push(d);
    }
    this.collection.set(doc.uri, diags);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}

/** "Run @tag" lenses above tag lines. */
export class TagCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!getConfig(doc.uri).tagCodeLens) return [];
    const parsed = parsedDocument(doc);
    const byLine = new Map<number, string[]>();
    for (const t of parsed.tags) {
      const list = byLine.get(t.line) ?? [];
      if (!list.includes(t.name)) list.push(t.name);
      byLine.set(t.line, list);
    }
    const lenses: vscode.CodeLens[] = [];
    for (const [line, tags] of byLine) {
      const range = new vscode.Range(line - 1, 0, line - 1, 0);
      for (const tag of tags) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(run) ${tag}`,
            tooltip: `Run every scenario tagged ${tag} in the workspace`,
            command: 'gherkinRunner.runTag',
            arguments: [tag, false],
          }),
        );
      }
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(debug-alt) Debug',
          tooltip: `Debug every scenario tagged ${tags.join(' or ')} in the workspace`,
          command: 'gherkinRunner.runTag',
          arguments: [tags.join(' or '), true],
        }),
      );
    }
    return lenses;
  }
}
