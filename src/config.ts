import * as vscode from 'vscode';
import type { BuildTool } from './projectModel';

export interface RunnerConfig {
  buildTool: 'auto' | BuildTool;
  mavenExecutable: string;
  gradleExecutable: string;
  mavenArgs: string[];
  gradleArgs: string[];
  compileBeforeRun: boolean;
  javaHome: string;
  glue: string[];
  vmArgs: string[];
  env: Record<string, string>;
  cucumberArgs: string[];
  prettyOutput: boolean;
  summaryTable: boolean;
  tags: string;
  featureGlob: string;
  stepDefinitionGlob: string;
  exclude: string;
  undefinedStepDiagnostics: boolean;
  tagCodeLens: boolean;
  attachTimeoutSeconds: number;
}

export const SECTION = 'gherkinRunner';

export function getConfig(scope?: vscode.ConfigurationScope): RunnerConfig {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  return {
    buildTool: c.get('buildTool', 'auto'),
    mavenExecutable: c.get('mavenExecutable', ''),
    gradleExecutable: c.get('gradleExecutable', ''),
    mavenArgs: c.get('mavenArgs', []),
    gradleArgs: c.get('gradleArgs', []),
    compileBeforeRun: c.get('compileBeforeRun', true),
    javaHome: c.get('javaHome', ''),
    glue: c.get('glue', []),
    vmArgs: c.get('vmArgs', []),
    env: c.get('env', {}),
    cucumberArgs: c.get('cucumberArgs', []),
    prettyOutput: c.get('prettyOutput', true),
    summaryTable: c.get('summaryTable', true),
    tags: c.get('tags', ''),
    featureGlob: c.get('featureGlob', '**/*.feature'),
    stepDefinitionGlob: c.get('stepDefinitionGlob', '**/*.{java,kt}'),
    exclude: c.get('exclude', '**/{node_modules,target,build,out,bin,.git,.gradle}/**'),
    undefinedStepDiagnostics: c.get('diagnostics.undefinedSteps', true),
    tagCodeLens: c.get('codeLens.tags', true),
    attachTimeoutSeconds: c.get('debug.attachTimeout', 120),
  };
}
