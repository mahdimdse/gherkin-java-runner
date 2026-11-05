import * as path from 'path';
import * as vscode from 'vscode';
import { FeatureSelection } from './commandBuilder';
import { getConfig } from './config';
import { caseKey, ExecContext, hasJavaDebugger, runGroup } from './executor';
import { ModelNode, NodeKind, parseFeature } from './gherkinModel';
import { detectProject, JavaProject, projectKey } from './projectModel';
import { combineTagExpressions, compileTagExpression, validateTagExpression } from './tags';

interface ItemData {
  kind: NodeKind;
  fsPath: string;
  line: number;
  tags: string[];
}

export interface RunOptions {
  debug: boolean;
  /** Extra tag expression for this run (combined with the gherkinRunner.tags setting). */
  tagExpression?: string;
}

const ICON: Record<NodeKind, string> = {
  feature: '',
  rule: '$(list-tree) ',
  scenario: '',
  outline: '$(table) ',
  examples: '$(list-flat) ',
  row: '',
};

export class FeatureTestController implements vscode.Disposable {
  readonly controller = vscode.tests.createTestController('gherkinRunner', 'Cucumber (Java)');
  private readonly data = new WeakMap<vscode.TestItem, ItemData>();
  private readonly disposables: vscode.Disposable[] = [this.controller];
  private readonly docTimers = new Map<string, NodeJS.Timeout>();
  private lastTagExpression = '';
  /** Every tag seen in the workspace (for the tag picker). */
  private knownTags = new Map<string, Set<string>>();

  constructor(private readonly ctx: ExecContext) {
    const c = this.controller;
    c.createRunProfile('Run', vscode.TestRunProfileKind.Run, (r, t) => this.run(r, t, { debug: false }), true);
    c.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, (r, t) => this.run(r, t, { debug: true }), true);
    c.createRunProfile('Run with Tag Expression…', vscode.TestRunProfileKind.Run, (r, t) => this.runWithPrompt(r, t, false), false);
    c.createRunProfile('Debug with Tag Expression…', vscode.TestRunProfileKind.Debug, (r, t) => this.runWithPrompt(r, t, true), false);
    c.refreshHandler = () => this.discoverAll();
    c.resolveHandler = async (item) => {
      if (!item) await this.discoverAll();
    };

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.onDocument(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocument(e.document)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gherkinRunner.featureGlob') || e.affectsConfiguration('gherkinRunner.exclude')) {
          void this.discoverAll();
        }
      }),
    );
    this.watch();
  }

  private watch(): void {
    const w = vscode.workspace.createFileSystemWatcher('**/*.feature');
    this.disposables.push(
      w,
      w.onDidCreate((u) => void this.updateFromDisk(u)),
      w.onDidChange((u) => {
        if (!vscode.workspace.textDocuments.some((d) => d.uri.toString() === u.toString() && d.isDirty)) {
          void this.updateFromDisk(u);
        }
      }),
      w.onDidDelete((u) => this.remove(u)),
    );
  }

  async discoverAll(): Promise<void> {
    const cfg = getConfig();
    const uris = await vscode.workspace.findFiles(cfg.featureGlob, cfg.exclude);
    const seen = new Set(uris.map((u) => u.toString()));
    this.controller.items.forEach((item) => {
      if (!seen.has(item.id)) this.remove(item.uri!);
    });
    await Promise.all(uris.map((u) => this.updateFromDisk(u)));
    this.ctx.log.appendLine(`[tests] discovered ${uris.length} feature files`);
  }

  private onDocument(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file' || !doc.uri.fsPath.endsWith('.feature')) return;
    const key = doc.uri.toString();
    clearTimeout(this.docTimers.get(key));
    this.docTimers.set(key, setTimeout(() => this.update(doc.uri, doc.getText()), 300));
  }

  private async updateFromDisk(uri: vscode.Uri): Promise<void> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return this.update(uri, open.getText());
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.update(uri, Buffer.from(bytes).toString('utf8'));
    } catch {
      this.remove(uri);
    }
  }

  private remove(uri: vscode.Uri): void {
    this.controller.items.delete(uri.toString());
    this.knownTags.delete(uri.toString());
  }

  private update(uri: vscode.Uri, text: string): void {
    const parsed = parseFeature(text);
    const id = uri.toString();
    let fileItem = this.controller.items.get(id);
    const rel = vscode.workspace.asRelativePath(uri, true);
    if (!fileItem) {
      fileItem = this.controller.createTestItem(id, path.basename(uri.fsPath), uri);
      this.controller.items.add(fileItem);
    }
    this.knownTags.set(id, new Set(parsed.tags.map((t) => t.name)));
    fileItem.description = rel;
    fileItem.error = undefined;
    if (parsed.error || !parsed.root) {
      fileItem.label = path.basename(uri.fsPath);
      fileItem.children.replace([]);
      if (parsed.error) fileItem.error = parsed.error;
      return;
    }
    const root = parsed.root;
    fileItem.label = root.label;
    fileItem.range = new vscode.Range(root.line - 1, 0, root.line - 1, 0);
    fileItem.tags = toTestTags(root.tags);
    fileItem.sortText = rel;
    this.data.set(fileItem, { kind: 'feature', fsPath: uri.fsPath, line: root.line, tags: root.tags });
    fileItem.children.replace(root.children.map((n, i) => this.toItem(uri, n, i)));
  }

  private toItem(uri: vscode.Uri, node: ModelNode, index: number): vscode.TestItem {
    const item = this.controller.createTestItem(`${uri.toString()}#${node.line}`, ICON[node.kind] + node.label, uri);
    item.range = new vscode.Range(node.line - 1, 0, Math.max(node.line, node.endLine) - 1, 0);
    item.description = [node.description, node.ownTags.join(' ')].filter(Boolean).join('  ');
    item.tags = toTestTags(node.tags);
    item.sortText = String(index).padStart(5, '0');
    this.data.set(item, { kind: node.kind, fsPath: uri.fsPath, line: node.line, tags: node.tags });
    item.children.replace(node.children.map((c, i) => this.toItem(uri, c, i)));
    return item;
  }

  allTags(): string[] {
    const s = new Set<string>();
    for (const set of this.knownTags.values()) set.forEach((t) => s.add(t));
    return [...s].sort();
  }

  // ---------------------------------------------------------------- running

  /** Prompt for a tag expression (shows known tags) and remember it. */
  async promptTagExpression(initial?: string): Promise<string | undefined> {
    const tags = this.allTags();
    const expr = await vscode.window.showInputBox({
      title: 'Cucumber tag expression',
      prompt: tags.length ? `Known tags: ${tags.slice(0, 30).join(' ')}${tags.length > 30 ? ' …' : ''}` : 'e.g. @smoke and not @wip',
      placeHolder: '@smoke and not @wip',
      value: initial ?? this.lastTagExpression,
      validateInput: validateTagExpression,
      ignoreFocusOut: true,
    });
    if (expr) this.lastTagExpression = expr;
    return expr;
  }

  private async runWithPrompt(request: vscode.TestRunRequest, token: vscode.CancellationToken, debug: boolean) {
    const expr = await this.promptTagExpression();
    if (!expr) return;
    await this.run(request, token, { debug, tagExpression: expr });
  }

  /** Run every scenario in the workspace that matches a tag expression. */
  async runTagExpression(expr: string, debug: boolean): Promise<void> {
    if (this.controller.items.size === 0) await this.discoverAll();
    this.lastTagExpression = expr;
    const cts = new vscode.CancellationTokenSource();
    const request = new vscode.TestRunRequest(undefined, undefined, undefined, false);
    try {
      await this.run(request, cts.token, { debug, tagExpression: expr });
    } finally {
      cts.dispose();
    }
  }

  private collectLeaves(request: vscode.TestRunRequest): vscode.TestItem[] {
    const excluded = new Set(request.exclude ?? []);
    const out: vscode.TestItem[] = [];
    const walk = (item: vscode.TestItem) => {
      if (excluded.has(item)) return;
      if (item.children.size === 0) {
        const d = this.data.get(item);
        if (d && (d.kind === 'scenario' || d.kind === 'row')) out.push(item);
        return;
      }
      item.children.forEach(walk);
    };
    if (request.include) request.include.forEach(walk);
    else this.controller.items.forEach(walk);
    return [...new Set(out)];
  }

  async run(request: vscode.TestRunRequest, token: vscode.CancellationToken, opts: RunOptions): Promise<void> {
    if (opts.debug && !hasJavaDebugger()) {
      const pick = await vscode.window.showErrorMessage(
        'Debugging Cucumber scenarios needs the "Debugger for Java" extension.',
        'Install Debugger for Java',
      );
      if (pick) await vscode.commands.executeCommand('workbench.extensions.installExtension', 'vscjava.vscode-java-debug');
      return;
    }
    // Save dirty feature/step files so the run sees what is on screen.
    await vscode.workspace.saveAll(false);

    const cfg = getConfig();
    let leaves = this.collectLeaves(request);
    const tagExpr = combineTagExpressions(cfg.tags, opts.tagExpression);
    if (tagExpr) {
      let filter;
      try {
        filter = compileTagExpression(tagExpr);
      } catch (e: any) {
        void vscode.window.showErrorMessage(`Invalid tag expression "${tagExpr}": ${e?.message ?? e}`);
        return;
      }
      leaves = leaves.filter((l) => filter.evaluate(this.data.get(l)!.tags));
    }
    if (!leaves.length) {
      void vscode.window.showInformationMessage(
        tagExpr ? `No scenarios match the tag expression "${tagExpr}".` : 'No scenarios to run.',
      );
      return;
    }

    const run = this.controller.createTestRun(request, tagExpr ? `Cucumber ${tagExpr}` : undefined, true);
    try {
      leaves.forEach((l) => run.enqueued(l));
      if (tagExpr) run.appendOutput(`Tag filter: ${tagExpr} → ${leaves.length} scenario(s)\r\n`);

      // Group by build project, then by feature file.
      const groups = new Map<string, { project: JavaProject; byFile: Map<string, vscode.TestItem[]> }>();
      for (const leaf of leaves) {
        const d = this.data.get(leaf)!;
        const project = detectProject(d.fsPath, cfg.buildTool);
        if (!project) {
          run.errored(
            leaf,
            new vscode.TestMessage(`No ${cfg.buildTool === 'auto' ? 'pom.xml or build.gradle' : cfg.buildTool + ' build file'} found above ${d.fsPath}.`),
          );
          continue;
        }
        const key = projectKey(project);
        const g = groups.get(key) ?? { project, byFile: new Map() };
        groups.set(key, g);
        const list = g.byFile.get(d.fsPath) ?? [];
        list.push(leaf);
        g.byFile.set(d.fsPath, list);
      }

      for (const g of groups.values()) {
        const allItems = [...g.byFile.values()].flat();
        if (token.isCancellationRequested) {
          allItems.forEach((i) => run.skipped(i));
          continue;
        }
        const leafMap = new Map<string, vscode.TestItem>();
        const selections: FeatureSelection[] = [];
        for (const [fsPath, items] of g.byFile) {
          for (const i of items) leafMap.set(caseKey(fsPath, this.data.get(i)!.line), i);
          const fileItem = this.controller.items.get(vscode.Uri.file(fsPath).toString()) ?? items[0].parent;
          const total = fileItem ? this.countLeaves(fileItem) : -1;
          const wholeFile = !tagExpr && !(request.exclude?.length) && items.length === total;
          selections.push({ path: fsPath, lines: wholeFile ? undefined : items.map((i) => this.data.get(i)!.line) });
        }
        await runGroup(this.ctx, { project: g.project, selections, leaves: leafMap, run, token, debug: opts.debug, cfg });
      }
    } catch (e: any) {
      run.appendOutput(`\r\nUnexpected error: ${e?.stack ?? e}\r\n`);
      this.ctx.log.appendLine(`[run] unexpected error: ${e?.stack ?? e}`);
    } finally {
      run.end();
    }
  }

  private countLeaves(item: vscode.TestItem): number {
    if (item.children.size === 0) {
      const k = this.data.get(item)?.kind;
      return k === 'scenario' || k === 'row' ? 1 : 0;
    }
    let n = 0;
    item.children.forEach((c) => (n += this.countLeaves(c)));
    return n;
  }

  dispose(): void {
    for (const t of this.docTimers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}

function toTestTags(tags: string[]): vscode.TestTag[] {
  return tags.map((t) => new vscode.TestTag(t.replace(/^@/, '')));
}

