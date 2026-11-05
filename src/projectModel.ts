// Build-tool project detection (uses fs, no vscode import).
import * as fs from 'fs';
import * as path from 'path';

export type BuildTool = 'maven' | 'gradle';

export interface JavaProject {
  tool: BuildTool;
  /** Directory of the module that owns the feature file (has pom.xml / build.gradle). */
  moduleDir: string;
  /** Directory the build is launched from (reactor root / settings.gradle dir). */
  rootDir: string;
  /** Wrapper script (mvnw / gradlew) if found. */
  wrapper?: string;
  /** Maven: module path relative to root for -pl. Gradle: project path like ":api". */
  modulePath: string;
}

const exists = (p: string) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

const GRADLE_BUILD = ['build.gradle', 'build.gradle.kts'];
const GRADLE_SETTINGS = ['settings.gradle', 'settings.gradle.kts'];

function hasAny(dir: string, names: string[]): boolean {
  return names.some((n) => exists(path.join(dir, n)));
}

function findUp(start: string, pred: (dir: string) => boolean, stopAt?: string): string | undefined {
  let dir = start;
  for (;;) {
    if (pred(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || (stopAt && dir === stopAt)) return undefined;
    dir = parent;
  }
}

function findWrapper(fromDir: string, base: string, stopAt?: string): string | undefined {
  const names = process.platform === 'win32' ? [`${base}.cmd`, `${base}.bat`, base] : [base];
  const dir = findUp(fromDir, (d) => names.some((n) => exists(path.join(d, n))), stopAt);
  if (!dir) return undefined;
  return names.map((n) => path.join(dir, n)).find(exists);
}

/** Module names listed in a pom.xml <modules> section (normalized, forward slashes). */
export function pomModules(pomXml: string): string[] {
  const out: string[] = [];
  const re = /<module>\s*([^<]+?)\s*<\/module>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pomXml))) out.push(m[1].replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''));
  return out;
}

function detectMaven(moduleDir: string, stopAt?: string): JavaProject {
  // Climb while the parent pom aggregates the current directory as a <module>.
  let root = moduleDir;
  let cur = moduleDir;
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur || (stopAt && cur === stopAt)) break;
    const parentPom = path.join(parent, 'pom.xml');
    if (!exists(parentPom)) break;
    const rel = path.relative(parent, cur).split(path.sep).join('/');
    let xml = '';
    try {
      xml = fs.readFileSync(parentPom, 'utf8');
    } catch {
      break;
    }
    if (!pomModules(xml).includes(rel)) break;
    root = parent;
    cur = parent;
  }
  return {
    tool: 'maven',
    moduleDir,
    rootDir: root,
    wrapper: findWrapper(root, 'mvnw', stopAt),
    modulePath: path.relative(root, moduleDir).split(path.sep).join('/'),
  };
}

function detectGradle(moduleDir: string, stopAt?: string): JavaProject {
  const root = findUp(moduleDir, (d) => hasAny(d, GRADLE_SETTINGS), stopAt) ?? moduleDir;
  const rel = path.relative(root, moduleDir);
  const modulePath = rel ? ':' + rel.split(path.sep).join(':') : ':';
  return { tool: 'gradle', moduleDir, rootDir: root, wrapper: findWrapper(root, 'gradlew', stopAt), modulePath };
}

/**
 * Find the build project for a feature file.
 * @param preferred 'auto' picks whichever build file is nearest (Maven wins a tie).
 */
export function detectProject(featurePath: string, preferred: 'auto' | BuildTool = 'auto'): JavaProject | undefined {
  const start = path.dirname(featurePath);
  const isMaven = (d: string) => exists(path.join(d, 'pom.xml'));
  const isGradle = (d: string) => hasAny(d, GRADLE_BUILD) || hasAny(d, GRADLE_SETTINGS);
  const pred =
    preferred === 'maven' ? isMaven : preferred === 'gradle' ? isGradle : (d: string) => isMaven(d) || isGradle(d);
  const moduleDir = findUp(start, pred);
  if (!moduleDir) return undefined;
  const useMaven = preferred === 'maven' || (preferred === 'auto' && isMaven(moduleDir));
  return useMaven ? detectMaven(moduleDir) : detectGradle(moduleDir);
}

export function projectKey(p: JavaProject): string {
  return `${p.tool}:${p.moduleDir}`;
}

/** Read cucumber.* keys from the usual property files of a module. */
export function readCucumberProperties(moduleDir: string): Record<string, string> {
  const files = [
    'src/test/resources/junit-platform.properties',
    'src/test/resources/cucumber.properties',
  ];
  const props: Record<string, string> = {};
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(moduleDir, f), 'utf8');
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(parseProperties(text))) {
      if (k.startsWith('cucumber.')) props[k] = v;
    }
  }
  return props;
}

export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\\\r?\n\s*/g, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const m = /^((?:\\.|[^=:\s])+)\s*[=:\s]\s*(.*)$/.exec(line);
    if (m) out[m[1].replace(/\\(.)/g, '$1')] = m[2].trim();
  }
  return out;
}
