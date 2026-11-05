// Builds executor.ts against a mocked vscode API and drives it with fake `mvn` and `java` executables.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const esbuild = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
const common = ['--bundle', '--platform=node', '--format=cjs', '--log-level=warning'];
execFileSync(esbuild, ['src/executor.ts', ...common, '--external:vscode', `--outfile=${path.join(here, 'executor.bundle.js')}`], { cwd: root, stdio: 'inherit' });
execFileSync(esbuild, ['src/gherkinModel.ts', ...common, `--outfile=${path.join(here, 'gherkin.bundle.js')}`], { cwd: root, stdio: 'inherit' });
fs.mkdirSync(path.join(here, 'node_shim', 'vscode'), { recursive: true });
fs.copyFileSync(path.join(here, 'vscode-mock.js'), path.join(here, 'node_shim', 'vscode', 'index.js'));
execFileSync(process.execPath, [path.join(here, 'harness.js')], {
  stdio: 'inherit',
  env: { ...process.env, NODE_PATH: path.join(here, 'node_shim') },
});
