import parseTagExpression from '@cucumber/tag-expressions';

export interface TagFilter {
  evaluate(tags: string[]): boolean;
}

/** Combine several optional tag expressions with `and`. Returns undefined if all are empty. */
export function combineTagExpressions(...exprs: (string | undefined)[]): string | undefined {
  const parts = exprs.map((e) => e?.trim()).filter((e): e is string => !!e);
  if (!parts.length) return undefined;
  if (parts.length === 1) return parts[0];
  return parts.map((p) => `(${p})`).join(' and ');
}

/** Throws a readable error for an invalid expression. */
export function compileTagExpression(expr: string): TagFilter {
  const node = parseTagExpression(expr);
  return { evaluate: (tags) => node.evaluate(tags) };
}

export function validateTagExpression(expr: string): string | undefined {
  if (!expr.trim()) return 'Enter a tag expression, e.g. @smoke and not @wip';
  try {
    parseTagExpression(expr);
    return undefined;
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}
