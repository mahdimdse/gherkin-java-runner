// Pure Gherkin parsing helpers (no vscode import, unit-testable).
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';
import type * as messages from '@cucumber/messages';

export type NodeKind = 'feature' | 'rule' | 'scenario' | 'outline' | 'examples' | 'row';

export interface ModelNode {
  kind: NodeKind;
  /** Display label. */
  label: string;
  /** Extra text shown next to the label. */
  description?: string;
  /** 1-based line of the keyword (or row). */
  line: number;
  /** 1-based last line covered by this node. */
  endLine: number;
  /** Tags declared directly on this node. */
  ownTags: string[];
  /** Tags inherited from parents plus own tags (what Cucumber evaluates). */
  tags: string[];
  children: ModelNode[];
}

export interface ExamplesTable {
  header: string[];
  rows: string[][];
}

export interface StepInfo {
  /** 1-based line. */
  line: number;
  /** 0-based column where the keyword starts. */
  keywordColumn: number;
  keyword: string;
  /** 0-based column where the step text starts. */
  textColumn: number;
  text: string;
  /** Present when the step belongs to a Scenario Outline with Examples. */
  examples?: ExamplesTable[];
}

export interface TagOccurrence {
  name: string;
  /** 1-based line. */
  line: number;
  /** 0-based column. */
  column: number;
}

export interface ParsedFeature {
  root?: ModelNode;
  steps: StepInfo[];
  tags: TagOccurrence[];
  error?: string;
  errorLine?: number;
}

function newParser(): Parser<messages.GherkinDocument> {
  return new Parser(new AstBuilder(IdGenerator.incrementing()), new GherkinClassicTokenMatcher());
}

const tagNames = (tags: readonly messages.Tag[]) => tags.map((t) => t.name);
const uniq = (xs: string[]) => [...new Set(xs)];

export function parseFeature(text: string): ParsedFeature {
  const result: ParsedFeature = { steps: [], tags: [] };
  let doc: messages.GherkinDocument;
  try {
    doc = newParser().parse(text);
  } catch (e: any) {
    result.error = String(e?.message ?? e);
    const m = /\((\d+):\d+\)/.exec(result.error);
    if (m) result.errorLine = Number(m[1]);
    return result;
  }
  const feature = doc.feature;
  if (!feature) return result;

  const collectTags = (tags: readonly messages.Tag[]) => {
    for (const t of tags) {
      result.tags.push({ name: t.name, line: t.location.line, column: (t.location.column ?? 1) - 1 });
    }
  };

  const addSteps = (steps: readonly messages.Step[], examples?: ExamplesTable[]) => {
    for (const s of steps) {
      const keywordColumn = (s.location.column ?? 1) - 1;
      result.steps.push({
        line: s.location.line,
        keywordColumn,
        keyword: s.keyword.trim(),
        textColumn: keywordColumn + s.keyword.length,
        text: s.text,
        examples,
      });
    }
  };

  const lastStepLine = (steps: readonly messages.Step[], fallback: number) => {
    let last = fallback;
    for (const s of steps) {
      last = Math.max(last, s.location.line);
      if (s.dataTable) for (const r of s.dataTable.rows) last = Math.max(last, r.location.line);
      if (s.docString) last = Math.max(last, s.docString.location.line + s.docString.content.split('\n').length + 1);
    }
    return last;
  };

  const scenarioNode = (sc: messages.Scenario, inherited: string[]): ModelNode => {
    collectTags(sc.tags);
    const own = tagNames(sc.tags);
    const tags = uniq([...inherited, ...own]);
    const isOutline = sc.examples.length > 0 || /outline|template/i.test(sc.keyword);
    const node: ModelNode = {
      kind: isOutline ? 'outline' : 'scenario',
      label: sc.name || `(${sc.keyword.trim()} at line ${sc.location.line})`,
      line: sc.location.line,
      endLine: lastStepLine(sc.steps, sc.location.line),
      ownTags: own,
      tags,
      children: [],
    };
    const tables: ExamplesTable[] = [];
    for (const ex of sc.examples) {
      collectTags(ex.tags);
      const exOwn = tagNames(ex.tags);
      const exTags = uniq([...tags, ...exOwn]);
      const header = ex.tableHeader?.cells.map((c) => c.value) ?? [];
      const rows = ex.tableBody.map((r) => r.cells.map((c) => c.value));
      tables.push({ header, rows });
      const exNode: ModelNode = {
        kind: 'examples',
        label: `${ex.keyword.trim()}${ex.name ? ': ' + ex.name : ''}`,
        line: ex.location.line,
        endLine: ex.tableBody.length ? ex.tableBody[ex.tableBody.length - 1].location.line : ex.location.line,
        ownTags: exOwn,
        tags: exTags,
        children: ex.tableBody.map((row, i) => ({
          kind: 'row' as const,
          label: '| ' + row.cells.map((c) => c.value).join(' | ') + ' |',
          description: `row ${i + 1}`,
          line: row.location.line,
          endLine: row.location.line,
          ownTags: [],
          tags: exTags,
          children: [],
        })),
      };
      node.endLine = Math.max(node.endLine, exNode.endLine);
      node.children.push(exNode);
    }
    addSteps(sc.steps, tables.length ? tables : undefined);
    return node;
  };

  collectTags(feature.tags);
  const featureTags = tagNames(feature.tags);
  const root: ModelNode = {
    kind: 'feature',
    label: feature.name || '(unnamed feature)',
    line: feature.location.line,
    endLine: text.split(/\r?\n/).length,
    ownTags: featureTags,
    tags: featureTags,
    children: [],
  };

  for (const child of feature.children) {
    if (child.background) addSteps(child.background.steps);
    if (child.scenario) root.children.push(scenarioNode(child.scenario, featureTags));
    if (child.rule) {
      const rule = child.rule;
      collectTags(rule.tags);
      const ruleOwn = tagNames(rule.tags);
      const ruleTags = uniq([...featureTags, ...ruleOwn]);
      const ruleNode: ModelNode = {
        kind: 'rule',
        label: `${rule.keyword.trim()}: ${rule.name}`,
        line: rule.location.line,
        endLine: rule.location.line,
        ownTags: ruleOwn,
        tags: ruleTags,
        children: [],
      };
      for (const rc of rule.children) {
        if (rc.background) addSteps(rc.background.steps);
        if (rc.scenario) {
          const n = scenarioNode(rc.scenario, ruleTags);
          ruleNode.children.push(n);
          ruleNode.endLine = Math.max(ruleNode.endLine, n.endLine);
        }
      }
      root.children.push(ruleNode);
    }
  }
  result.root = root;
  return result;
}

/** Leaves are the units Cucumber actually executes: plain scenarios and Examples rows. */
export function leavesOf(node: ModelNode): ModelNode[] {
  if (node.kind === 'row' || node.kind === 'scenario') return [node];
  return node.children.flatMap(leavesOf);
}

/**
 * Candidate texts for matching a step against step definitions. Outline steps
 * (`<param>`) are expanded with the values from each Examples row.
 */
export function expandStepText(step: StepInfo, maxRows = 20): string[] {
  if (!step.examples || !/<[^<>]+>/.test(step.text)) return [step.text];
  const out: string[] = [];
  for (const table of step.examples) {
    for (const row of table.rows.slice(0, maxRows)) {
      let t = step.text;
      table.header.forEach((h, i) => {
        t = t.split(`<${h}>`).join(row[i] ?? '');
      });
      out.push(t);
    }
  }
  return out.length ? uniq(out) : [step.text];
}
