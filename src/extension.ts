import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  FEATURE_SELECTOR,
  StepDefinitionProvider,
  StepHoverProvider,
  TagCodeLensProvider,
  UndefinedStepDiagnostics,
} from './editorFeatures';
import { StepIndex } from './stepIndex';
import { FeatureTestController } from './testController';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Gherkin Runner for Java');
  const storageDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  fs.mkdirSync(storageDir, { recursive: true });

  const index = new StepIndex(log);
  const tests = new FeatureTestController({ storageDir, log, index });
  const codeLens = new TagCodeLensProvider();

  context.subscriptions.push(
    log,
    index,
    tests,
    new UndefinedStepDiagnostics(index),
    vscode.languages.registerDefinitionProvider(FEATURE_SELECTOR, new StepDefinitionProvider(index)),
    vscode.languages.registerHoverProvider(FEATURE_SELECTOR, new StepHoverProvider(index)),
    vscode.languages.registerCodeLensProvider(FEATURE_SELECTOR, codeLens),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gherkinRunner.codeLens')) codeLens.refresh();
      if (e.affectsConfiguration('gherkinRunner.stepDefinitionGlob') || e.affectsConfiguration('gherkinRunner.exclude')) {
        void index.rebuild();
      }
    }),

    vscode.commands.registerCommand('gherkinRunner.runTagExpression', async () => {
      const expr = await tests.promptTagExpression();
      if (expr) await tests.runTagExpression(expr, false);
    }),
    vscode.commands.registerCommand('gherkinRunner.debugTagExpression', async () => {
      const expr = await tests.promptTagExpression();
      if (expr) await tests.runTagExpression(expr, true);
    }),
    vscode.commands.registerCommand('gherkinRunner.runTag', (expr: string, debug: boolean) =>
      tests.runTagExpression(expr, !!debug),
    ),
    vscode.commands.registerCommand('gherkinRunner.reindexSteps', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Indexing Cucumber step definitions' },
        () => index.rebuild(),
      );
      void vscode.window.showInformationMessage(`Indexed ${index.stepCount()} step definitions.`);
    }),
    vscode.commands.registerCommand('gherkinRunner.refreshTests', () => tests.discoverAll()),
    vscode.commands.registerCommand('gherkinRunner.showOutput', () => log.show()),
  );

  void tests.discoverAll();
  void index.whenReady;
}

export function deactivate(): void {
  /* disposables handle cleanup */
}
