// Minimal vscode API surface used by executor.ts
class Position { constructor(l, c) { this.line = l; this.character = c; } translate(dl = 0, dc = 0) { return new Position(this.line + dl, this.character + dc); } }
class Range { constructor(a, b, c, d) { this.start = new Position(a, b); this.end = new Position(c, d); } }
class Location { constructor(uri, pos) { this.uri = uri; this.range = pos; } }
class TestMessage { constructor(m) { this.message = m; } static diff(m, e, a) { const t = new TestMessage(m); t.expectedOutput = e; t.actualOutput = a; return t; } }
class TestMessageStackFrame { constructor(label, uri, position) { this.label = label; this.uri = uri; this.position = position; } }
const Uri = { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => 'file://' + p }) };
const listeners = { start: [], end: [] };
module.exports = {
  Position, Range, Location, TestMessage, TestMessageStackFrame, Uri,
  workspace: { getWorkspaceFolder: () => undefined, getConfiguration: () => ({ get: () => undefined }) },
  extensions: { getExtension: () => ({}) },
  debug: {
    onDidStartDebugSession: (f) => { listeners.start.push(f); return { dispose() {} }; },
    onDidTerminateDebugSession: (f) => { listeners.end.push(f); return { dispose() {} }; },
    startDebugging: async (_folder, config) => { module.exports.__lastDebug = config; const s = { configuration: config }; listeners.start.forEach((f) => f(s)); return true; },
    stopDebugging: async () => {},
  },
};
