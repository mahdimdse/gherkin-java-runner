import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseJavaMajorVersion } from './commandBuilder';
import { runCapture } from './process';

export interface JavaRuntime {
  executable: string;
  major: number;
  source: string;
}

const cache = new Map<string, number>();

function javaIn(home: string): string | undefined {
  const exe = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  return fs.existsSync(exe) ? exe : undefined;
}

export function resolveJava(configuredHome: string): JavaRuntime {
  const jdtHome = vscode.workspace.getConfiguration('java.jdt.ls.java').get<string>('home');
  const candidates: [string | undefined, string][] = [
    [configuredHome, 'gherkinRunner.javaHome'],
    [process.env.JAVA_HOME, 'JAVA_HOME'],
    [jdtHome, 'java.jdt.ls.java.home'],
  ];
  let executable = 'java';
  let source = 'PATH';
  for (const [home, src] of candidates) {
    const exe = home?.trim() ? javaIn(home.trim()) : undefined;
    if (exe) {
      executable = exe;
      source = src;
      break;
    }
  }
  let major = cache.get(executable);
  if (major === undefined) {
    const { output } = runCapture(executable, ['-version']);
    major = parseJavaMajorVersion(output) ?? 11;
    cache.set(executable, major);
  }
  return { executable, major, source };
}
