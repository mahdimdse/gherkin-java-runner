// Pure parser for Java/Kotlin step definition sources (no vscode import).

export interface StepDefinition {
  expression: string;
  /** Annotation / method keyword, e.g. Given. */
  keyword: string;
  /** 0-based line of the annotation. */
  line: number;
  /** 0-based column of the annotation. */
  column: number;
  /** Name of the annotated method, if found. */
  methodName?: string;
}

export interface ParameterTypeDefinition {
  name: string;
  regexps: string[];
  line: number;
  column: number;
}

export interface SourceInfo {
  packageName: string;
  className: string;
  /** True when the file uses Cucumber glue APIs (steps, hooks, DI config). */
  isGlue: boolean;
  steps: StepDefinition[];
  parameterTypes: ParameterTypeDefinition[];
}

const ENGLISH_KEYWORDS = new Set(['Given', 'When', 'Then', 'And', 'But', 'Step']);
const NOT_STEP_ANNOTATIONS = new Set([
  'Override', 'SuppressWarnings', 'Deprecated', 'DisplayName', 'Test', 'ParameterType', 'DataTableType',
  'DocStringType', 'DefaultParameterTransformer', 'DefaultDataTableEntryTransformer',
  'DefaultDataTableCellTransformer', 'Before', 'After', 'BeforeStep', 'AfterStep', 'BeforeAll', 'AfterAll',
  'Transpose', 'Format', 'ConfigurationParameter', 'CucumberOptions', 'Suite', 'IncludeEngines',
  'SelectClasspathResource', 'SelectPackages', 'CucumberContextConfiguration', 'SpringBootTest',
  'ContextConfiguration', 'Autowired', 'Inject', 'Value', 'JvmStatic', 'Throws', 'Nested', 'Tag', 'Timeout',
]);

/**
 * Replace comments with spaces (keeping line/column positions) but keep string
 * literals intact. Handles Java/Kotlin text blocks ("""...""").
 */
export function stripComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
    } else if (c === '/' && next === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
    } else if (c === '"' && src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      i = end < 0 ? n : end + 3;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
    } else {
      i++;
    }
  }
  return out.join('');
}

export function unescapeJavaString(body: string): string {
  return body.replace(/\\(u+[0-9a-fA-F]{4}|[0-7]{1,3}|.)/g, (_m, e: string) => {
    if (e[0] === 'u') return String.fromCharCode(parseInt(e.replace(/^u+/, ''), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    switch (e) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 's': return ' ';
      default: return e; // \\ \" \' \$ ...
    }
  });
}

/** Parse `"a" + "b"` (possibly multi-line) into the concatenated string value. */
function parseConcatenatedLiterals(s: string): string {
  const parts: string[] = [];
  const re = /"((?:[^"\\\n]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) parts.push(unescapeJavaString(m[1]));
  return parts.join('');
}

function positionOf(text: string, offset: number): { line: number; column: number } {
  let line = 0;
  let last = -1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) { line++; last = i; }
  return { line, column: offset - last - 1 };
}

/** Index of the parenthesis closing the one at `open`, skipping strings. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Name of the first method/function declared after `from` (skipping annotations). */
function methodNameAfter(text: string, from: number): string | undefined {
  const re = /(@\s*)?((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\s*\(/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) {
      const close = matchParen(text, m.index + m[0].length - 1);
      if (close < 0) return undefined;
      re.lastIndex = close + 1;
      continue;
    }
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'new'].includes(m[2])) return undefined;
    return m[2];
  }
  return undefined;
}

const STRING_ARG = String.raw`((?:"(?:[^"\\\n]|\\.)*"\s*\+?\s*)+)`;

export function parseStepSource(source: string): SourceInfo {
  const text = stripComments(source);
  const packageName = /^\s*package\s+([\w.]+)\s*;?/m.exec(text)?.[1] ?? '';
  const className = /\b(?:class|object|interface)\s+([A-Za-z_$][\w$]*)/.exec(text)?.[1] ?? '';

  // Annotations imported from io.cucumber.java.<lang> (supports any Gherkin language).
  const imported = new Set<string>();
  let wildcardLanguageImport = false;
  const importRe = /^\s*import\s+(?:static\s+)?io\.cucumber\.java8?\.[a-z_]+\.(\*|[A-Z][\w$]*)/gm;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(text))) {
    if (im[1] === '*') wildcardLanguageImport = true;
    else imported.add(im[1]);
  }

  const cucumberImports = [...text.matchAll(/^\s*import\s+(?:static\s+)?(io\.cucumber\.[\w.*]+)/gm)].map((m) => m[1]);
  const isGlue = cucumberImports.some(
    (i) => !/^io\.cucumber\.(junit|testng|core\.options|core\.cli|plugin)\b/.test(i),
  );

  const isStepAnnotation = (name: string) =>
    ENGLISH_KEYWORDS.has(name) || imported.has(name) || (wildcardLanguageImport && !NOT_STEP_ANNOTATIONS.has(name));

  const steps: StepDefinition[] = [];

  // Annotation style: @Given("...") / @Given(value = "...") / @io.cucumber.java.en.Given("...")
  const annRe = new RegExp(String.raw`@((?:[\w$]+\.)*([A-Z][\w$]*))\s*\(\s*(?:value\s*=\s*)?` + STRING_ARG, 'g');
  let m: RegExpExecArray | null;
  while ((m = annRe.exec(text))) {
    const fq = m[1];
    const name = m[2];
    const qualifiedCucumber = /^io\.cucumber\.java\.[a-z_]+\./.test(fq);
    if (!qualifiedCucumber && !isStepAnnotation(name)) continue;
    if (!qualifiedCucumber && fq.includes('.')) continue;
    const pos = positionOf(text, m.index);
    const close = matchParen(text, text.indexOf('(', m.index + 1));
    steps.push({
      expression: parseConcatenatedLiterals(m[3]),
      keyword: name,
      line: pos.line,
      column: pos.column,
      methodName: close > 0 ? methodNameAfter(text, close + 1) : undefined,
    });
  }

  // cucumber-java8 lambda style: Given("...", (String x) -> { ... });
  if (/io\.cucumber\.java8/.test(text)) {
    const lambdaRe = new RegExp(String.raw`(?<![@.\w$])([A-Z][\w$]*)\s*\(\s*` + STRING_ARG + String.raw`\s*,`, 'g');
    while ((m = lambdaRe.exec(text))) {
      if (!ENGLISH_KEYWORDS.has(m[1]) && !imported.has(m[1]) && !wildcardLanguageImport) continue;
      if (NOT_STEP_ANNOTATIONS.has(m[1])) continue;
      const pos = positionOf(text, m.index);
      steps.push({ expression: parseConcatenatedLiterals(m[2]), keyword: m[1], line: pos.line, column: pos.column });
    }
  }

  // @ParameterType("regex") / @ParameterType(value = "regex", name = "color")
  const parameterTypes: ParameterTypeDefinition[] = [];
  const ptRe = /@(?:io\.cucumber\.java\.)?ParameterType\s*\(/g;
  while ((m = ptRe.exec(text))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close < 0) continue;
    const args = text.slice(open + 1, close);
    const nameAttr = /\bname\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(args)?.[1];
    const valueAttr = new RegExp(String.raw`(?:^|[,(\s])value\s*=\s*` + STRING_ARG).exec(args)?.[1];
    let regex: string | undefined;
    if (valueAttr) regex = parseConcatenatedLiterals(valueAttr);
    else {
      const first = new RegExp(String.raw`^\s*` + STRING_ARG).exec(args)?.[1];
      if (first) regex = parseConcatenatedLiterals(first);
    }
    if (regex === undefined) continue;
    const name = nameAttr ? unescapeJavaString(nameAttr) : methodNameAfter(text, close + 1);
    if (!name) continue;
    const pos = positionOf(text, m.index);
    parameterTypes.push({ name, regexps: [regex], line: pos.line, column: pos.column });
  }

  // cucumber-java8: ParameterType("name", "regex", ...)
  if (/io\.cucumber\.java8/.test(text)) {
    const re = /(?<![@.\w$])ParameterType\s*\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;
    while ((m = re.exec(text))) {
      const pos = positionOf(text, m.index);
      parameterTypes.push({
        name: unescapeJavaString(m[1]),
        regexps: [unescapeJavaString(m[2])],
        line: pos.line,
        column: pos.column,
      });
    }
  }

  return { packageName, className, isGlue, steps, parameterTypes };
}

/** Parse `cucumber.glue` style values: comma/whitespace separated, `classpath:` prefixes allowed. */
export function splitGlueValue(v: string): string[] {
  return v
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
