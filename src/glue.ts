// Glue package resolution (pure).
import { splitGlueValue, stripComments, unescapeJavaString } from './stepParser';

/** Extract glue declared on a runner class (JUnit 5 suite or JUnit 4 / TestNG @CucumberOptions). */
export function parseRunnerGlue(source: string): string[] {
  const text = stripComments(source);
  const out: string[] = [];
  // @ConfigurationParameter(key = GLUE_PROPERTY_NAME, value = "com.example")
  const cpRe = /@ConfigurationParameter\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = cpRe.exec(text))) {
    const args = m[1];
    if (!/key\s*=\s*(?:(?:[\w.]+\.)?GLUE_PROPERTY_NAME|"cucumber\.glue")/.test(args)) continue;
    const v = /value\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(args);
    if (v) out.push(...splitGlueValue(unescapeJavaString(v[1])));
  }
  // @CucumberOptions(glue = {"a", "b"}) / glue = "a"
  const coRe = /@CucumberOptions\s*\(/g;
  while ((m = coRe.exec(text))) {
    const rest = text.slice(m.index + m[0].length);
    const g = /\bglue\s*=\s*(\{[^}]*\}|"(?:[^"\\]|\\.)*")/.exec(rest);
    if (!g) continue;
    for (const s of g[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.push(...splitGlueValue(unescapeJavaString(s[1])));
  }
  return [...new Set(out)];
}

/** Reduce a set of packages to the shortest set of roots (a.b covers a.b.c). */
export function minimizePackages(pkgs: Iterable<string>): string[] {
  const sorted = [...new Set([...pkgs].filter(Boolean))].sort();
  const out: string[] = [];
  for (const p of sorted) {
    if (!out.some((r) => p === r || p.startsWith(r + '.'))) out.push(p);
  }
  return out;
}

export interface GlueInputs {
  configured: string[];
  properties: Record<string, string>;
  runnerGlue: string[];
  detectedPackages: string[];
}

export interface ResolvedGlue {
  glue: string[];
  source: 'setting' | 'properties' | 'runner' | 'detected' | 'none';
}

export function resolveGlue(i: GlueInputs): ResolvedGlue {
  if (i.configured.length) return { glue: i.configured, source: 'setting' };
  const prop = i.properties['cucumber.glue'];
  if (prop?.trim()) return { glue: splitGlueValue(prop), source: 'properties' };
  if (i.runnerGlue.length) return { glue: i.runnerGlue, source: 'runner' };
  const detected = minimizePackages(i.detectedPackages);
  if (detected.length) return { glue: detected, source: 'detected' };
  return { glue: [], source: 'none' };
}
