import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onStdout?(text: string): void;
  onStderr?(text: string): void;
}

export interface RunningProcess {
  child: ChildProcess;
  exit: Promise<number>;
  kill(): void;
}

const isWin = process.platform === 'win32';

function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

function needsShell(command: string): boolean {
  if (!isWin) return false;
  const ext = path.extname(command).toLowerCase();
  return ext === '.cmd' || ext === '.bat' || ext === '';
}

/** Spawn a process, streaming output, with a kill() that takes down the whole tree. */
export function startProcess(o: SpawnOptions): RunningProcess {
  let command = o.command;
  let args = o.args;
  // A wrapper checked out without the executable bit: run it through sh.
  if (!isWin && path.isAbsolute(command) && /(?:mvnw|gradlew)$/.test(command)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
    } catch {
      args = [command, ...args];
      command = 'sh';
    }
  }
  const shell = needsShell(command);
  const child = shell
    ? spawn([quoteForCmd(command), ...args.map(quoteForCmd)].join(' '), {
        cwd: o.cwd,
        env: o.env,
        shell: true,
        windowsHide: true,
      })
    : spawn(command, args, { cwd: o.cwd, env: o.env, detached: !isWin, windowsHide: true });

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => o.onStdout?.(d));
  child.stderr?.on('data', (d: string) => o.onStderr?.(d));

  const exit = new Promise<number>((resolve) => {
    child.on('error', (err) => {
      o.onStderr?.(`\nFailed to start "${command}": ${err.message}\n`);
      resolve(-1);
    });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 130 : -1)));
  });

  let killed = false;
  const kill = () => {
    if (killed || child.exitCode !== null || child.pid === undefined) return;
    killed = true;
    try {
      if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  return { child, exit, kill };
}

/** Run a command to completion and capture its combined output. */
export function runCapture(command: string, args: string[], cwd?: string): { code: number; output: string } {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, shell: needsShell(command) });
  return { code: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
