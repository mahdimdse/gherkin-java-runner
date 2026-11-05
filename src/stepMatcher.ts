// Pure step matching with Cucumber Expressions / regular expressions.
import {
  CucumberExpression,
  ParameterType,
  ParameterTypeRegistry,
  RegularExpression,
} from '@cucumber/cucumber-expressions';
import type { ParameterTypeDefinition } from './stepParser';

export interface Matchable {
  expression: string;
}

interface Compiled {
  match(text: string): boolean;
}

/** Same rule as Cucumber-JVM: anchored strings (or /.../) are regular expressions. */
export function isRegularExpression(expr: string): boolean {
  return expr.startsWith('^') || expr.endsWith('$') || (expr.length > 1 && expr.startsWith('/') && expr.endsWith('/'));
}

/** Translate the bits of Java regex syntax JS does not understand. */
export function javaRegexToJs(src: string): { source: string; flags: string } {
  let source = src;
  let flags = 'u';
  const inline = /^\(\?([imsux]+)\)/.exec(source);
  if (inline) {
    source = source.slice(inline[0].length);
    if (inline[1].includes('i')) flags += 'i';
    if (inline[1].includes('s')) flags += 's';
  }
  source = source
    .replace(/\\A/g, '^')
    .replace(/\\[zZ]/g, '$')
    .replace(/(\*|\+|\?|\})\+/g, '$1') // possessive -> greedy
    .replace(/\\p\{(Alpha|L)\}/g, '\\p{L}')
    .replace(/\\p\{Digit\}/g, '\\d')
    .replace(/\\p\{(Alnum)\}/g, '[\\p{L}\\p{N}]')
    .replace(/\\p\{Punct\}/g, '[\\p{P}\\p{S}]')
    .replace(/\\p\{(Space|javaWhitespace)\}/g, '\\s');
  return { source, flags };
}

function safeRegExp(src: string): RegExp | undefined {
  const { source, flags } = javaRegexToJs(src);
  try {
    return new RegExp(source, flags);
  } catch {
    try {
      return new RegExp(source, flags.replace('u', ''));
    } catch {
      return undefined;
    }
  }
}

/** Permissive fallback when an expression cannot be compiled (e.g. unknown parameter type). */
export function lenientRegex(expr: string): RegExp {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '\\' && i + 1 < expr.length) {
      out += escapeRe(expr[i + 1]);
      i += 2;
    } else if (c === '{') {
      const end = expr.indexOf('}', i);
      out += '(.*)';
      i = end < 0 ? expr.length : end + 1;
    } else if (c === '(') {
      const end = expr.indexOf(')', i);
      const inner = end < 0 ? '' : expr.slice(i + 1, end);
      out += `(?:${escapeRe(inner)})?`;
      i = end < 0 ? expr.length : end + 1;
    } else {
      out += escapeRe(c);
      i++;
    }
  }
  return new RegExp(`^${out}$`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class StepMatcher {
  private registry = new ParameterTypeRegistry();
  private cache = new Map<string, Compiled>();

  constructor(parameterTypes: ParameterTypeDefinition[] = []) {
    this.setParameterTypes(parameterTypes);
  }

  setParameterTypes(types: ParameterTypeDefinition[]): void {
    this.registry = new ParameterTypeRegistry();
    this.cache.clear();
    for (const t of types) {
      const regexps = t.regexps.map((r) => safeRegExp(r)).filter((r): r is RegExp => !!r);
      if (!regexps.length) continue;
      try {
        this.registry.defineParameterType(
          new ParameterType(t.name, regexps, null, (s: string | null) => s, true, false),
        );
      } catch {
        // duplicate or invalid parameter type: ignore
      }
    }
  }

  private compile(expr: string): Compiled {
    let c = this.cache.get(expr);
    if (c) return c;
    if (isRegularExpression(expr)) {
      const body = expr.startsWith('/') && expr.endsWith('/') && expr.length > 1 ? expr.slice(1, -1) : expr;
      const re = safeRegExp(body);
      if (re) {
        let regular: RegularExpression | undefined;
        try {
          regular = new RegularExpression(re, this.registry);
        } catch {
          regular = undefined;
        }
        c = regular
          ? { match: (t) => safeMatch(() => regular!.match(t) !== null, () => re.test(t)) }
          : { match: (t) => re.test(t) };
      } else {
        c = { match: () => false };
      }
    } else {
      try {
        const ce = new CucumberExpression(expr, this.registry);
        const fallback = lenientRegex(expr);
        c = { match: (t) => safeMatch(() => ce.match(t) !== null, () => fallback.test(t)) };
      } catch {
        const re = lenientRegex(expr);
        c = { match: (t) => re.test(t) };
      }
    }
    this.cache.set(expr, c);
    return c;
  }

  matches(def: Matchable, text: string): boolean {
    return this.compile(def.expression).match(text);
  }

  findMatches<T extends Matchable>(defs: Iterable<T>, texts: string[]): T[] {
    const out: T[] = [];
    for (const d of defs) {
      if (texts.some((t) => this.matches(d, t))) out.push(d);
    }
    return out;
  }
}

function safeMatch(primary: () => boolean, fallback: () => boolean): boolean {
  try {
    return primary();
  } catch {
    // e.g. a transformer threw; fall back to plain regex matching
    return fallback();
  }
}
