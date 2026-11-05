// Pure command-line builders for Maven, Gradle and the Cucumber CLI.
import * as path from 'path';
import type { JavaProject } from './projectModel';

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
}

export const GRADLE_TASK = 'gherkinRunnerClasspath';
export const GRADLE_OUT_PROPERTY = 'gherkinRunnerOut';

/** Gradle init script that adds a task printing the test runtime classpath to a file. */
export const GRADLE_INIT_SCRIPT = `// Added by the Gherkin Runner for Java VS Code extension. Safe to delete.
allprojects {
    plugins.withId('java') {
        def outPath = project.findProperty('${GRADLE_OUT_PROPERTY}')
        def cp = project.sourceSets.test.runtimeClasspath
        project.tasks.register('${GRADLE_TASK}') {
            group = 'verification'
            description = 'Writes the test runtime classpath to a file (Gherkin Runner).'
            dependsOn project.tasks.named('testClasses')
            outputs.upToDateWhen { false }
            doLast {
                if (outPath == null) {
                    throw new GradleException('Missing -P${GRADLE_OUT_PROPERTY}=<file>')
                }
                def f = new File(outPath.toString())
                f.parentFile.mkdirs()
                f.text = cp.files.collect { it.absolutePath }.join(File.pathSeparator)
            }
        }
    }
}
`;

export function mavenExecutable(project: JavaProject, configured: string): string {
  return configured.trim() || project.wrapper || 'mvn';
}

export function gradleExecutable(project: JavaProject, configured: string): string {
  return configured.trim() || project.wrapper || 'gradle';
}

export function mavenClasspathCommand(
  project: JavaProject,
  executable: string,
  outFile: string,
  extraArgs: string[] = [],
): CommandSpec {
  const args = ['-B', '-ntp'];
  if (project.modulePath) {
    args.push('-f', path.join(project.rootDir, 'pom.xml'), '-pl', project.modulePath, '-am');
  } else {
    args.push('-f', path.join(project.moduleDir, 'pom.xml'));
  }
  args.push(
    ...extraArgs,
    'test-compile',
    'dependency:build-classpath',
    `-Dmdep.outputFile=${outFile}`,
    '-Dmdep.includeScope=test',
  );
  return { command: executable, args, cwd: project.rootDir };
}

/** Maven's dependency classpath excludes the module's own output folders; prepend them. */
export function mavenFullClasspath(moduleDir: string, dependencyClasspath: string, sep = path.delimiter): string[] {
  return [
    path.join(moduleDir, 'target', 'test-classes'),
    path.join(moduleDir, 'target', 'classes'),
    ...dependencyClasspath.split(sep).map((s) => s.trim()).filter(Boolean),
  ];
}

export function gradleTaskPath(project: JavaProject): string {
  return project.modulePath === ':' ? `:${GRADLE_TASK}` : `${project.modulePath}:${GRADLE_TASK}`;
}

export function gradleClasspathCommand(
  project: JavaProject,
  executable: string,
  initScript: string,
  outFile: string,
  extraArgs: string[] = [],
): CommandSpec {
  return {
    command: executable,
    args: [
      '--console=plain',
      '-I',
      initScript,
      ...extraArgs,
      gradleTaskPath(project),
      `-P${GRADLE_OUT_PROPERTY}=${outFile}`,
    ],
    cwd: project.rootDir,
  };
}

export interface FeatureSelection {
  path: string;
  /** Lines to run; undefined = the whole file. */
  lines?: number[];
}

export function featureArgument(sel: FeatureSelection): string {
  if (!sel.lines || !sel.lines.length) return sel.path;
  return `${sel.path}:${[...new Set(sel.lines)].sort((a, b) => a - b).join(':')}`;
}

export interface CucumberArgsInput {
  messageFile: string;
  pretty: boolean;
  glue: string[];
  extraArgs: string[];
  features: FeatureSelection[];
}

export function cucumberArgs(i: CucumberArgsInput): string[] {
  const args: string[] = ['--plugin', `message:${i.messageFile}`];
  if (i.pretty) args.push('--plugin', 'pretty');
  for (const g of i.glue) args.push('--glue', g);
  args.push(...i.extraArgs);
  args.push(...i.features.map(featureArgument));
  return args;
}

export const CUCUMBER_MAIN = 'io.cucumber.core.cli.Main';

/** System properties read from junit-platform.properties that must not be forwarded. */
const NOT_FORWARDED = /^cucumber\.(features|filter\.|glue$|execution\.|junit-platform\.)/;

export function forwardedSystemProperties(props: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { 'cucumber.publish.quiet': 'true' };
  for (const [k, v] of Object.entries(props)) if (!NOT_FORWARDED.test(k)) out[k] = v;
  return out;
}

export function jdwpArgument(port: number, javaMajor: number): string {
  const address = javaMajor >= 9 ? `127.0.0.1:${port}` : String(port);
  return `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=${address}`;
}

export interface JvmArgsInput {
  vmArgs: string[];
  systemProperties: Record<string, string>;
  debugPort?: number;
  javaMajor: number;
}

export function jvmArgs(i: JvmArgsInput): string[] {
  const args = [...i.vmArgs];
  for (const [k, v] of Object.entries(i.systemProperties)) args.push(`-D${k}=${v}`);
  if (i.debugPort !== undefined) args.push(jdwpArgument(i.debugPort, i.javaMajor));
  return args;
}

/** Quote one argument for a Java @argfile. */
export function quoteArgFileArg(arg: string): string {
  return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ') + '"';
}

export function argFileContent(args: string[]): string {
  return args.map(quoteArgFileArg).join('\n') + '\n';
}

export function parseJavaMajorVersion(versionOutput: string): number | undefined {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(versionOutput);
  if (!m) return undefined;
  const major = Number(m[1]);
  return major === 1 && m[2] ? Number(m[2]) : major;
}
