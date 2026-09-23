/**
 * Static validation for script bodies.
 * Checks argument counts, operator validity, and common mistakes.
 * JavaScript env/variable access is synchronous (no await needed).
 */

export interface ScriptValidationError {
  line: number;
  column: number;
  method?: string;
  message: string;
  severity?: 'error' | 'warning' | 'info';
}

/** Supported function calls exposed by the scripting runtime. */
const SUPPORTED_VD_CALLS = new Set([
  'voiden.env.get',
  'voiden.variables.set',
  'voiden.variables.get',
  'voiden.request.headers.push',
  'voiden.request.queryParams.push',
  'voiden.request.pathParams.push',
  'voiden.log',
  'voiden.assert',
  'voiden.cancel',
]);

const SUPPORTED_ASSERT_OPERATORS = new Set([
  '==', '===', 'eq', 'equal',
  '!=', '!==', 'neq', 'notequal',
  'greater', 'greaterthan', 'gte',
  'less', 'lessthan', 'lte',
  '>', '>=', '<', '<=',
  'contains', 'includes',
  'matches', 'regex',
  'truthy', 'falsy',
]);

type VdCallWithArgs = {
  method: string;
  column: number;
  openParenIndex: number;
  closeParenIndex: number;
  argsRaw: string;
};

function isLikelyPlainTextLine(trimmedLine: string, language: 'javascript' | 'python'): boolean {
  if (!trimmedLine) return false;

  const jsKeywords = /^(const|let|var|if|else|for|while|do|return|await|async|function|try|catch|finally|throw|switch|case|break|continue|class|new|import|export|voiden)\b/;
  const pyKeywords = /^(if|elif|else|for|while|return|await|async|def|class|try|except|finally|raise|import|from|pass|break|continue|lambda|with|voiden)\b/;
  const keywordPattern = language === 'javascript' ? jsKeywords : pyKeywords;

  if (keywordPattern.test(trimmedLine)) return false;

  // If it clearly contains strong code symbols, treat as code.
  if (/[=()[\]{};+*/%<>$&|]/.test(trimmedLine)) return false;
  // Obvious call/access patterns should not be treated as plain text.
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+\s*(\(|$)/.test(trimmedLine)) return false;
  if (/^[A-Za-z_$][\w$]*\s*\(/.test(trimmedLine)) return false;

  // Allow sentence punctuation and detect prose-like content.
  const normalized = trimmedLine.replace(/[.,!?;:]+$/g, '').trim();
  if (!normalized) return false;

  // Two or more words with letters and spaces are likely accidental prose.
  if (/^[A-Za-z][A-Za-z0-9_'"\-]*(\s+[A-Za-z0-9_'"\-]+)+$/.test(normalized)) {
    return true;
  }

  // Single-word bare identifiers can still be accidental text in scripts.
  // Keep this conservative to avoid false positives.
  return /^[A-Za-z]{3,}$/.test(normalized);
}

function findMatchingParen(line: string, openIndex: number): number {
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;

  for (let i = openIndex; i < line.length; i++) {
    const ch = line[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelArgs(argsRaw: string): string[] {
  const trimmed = argsRaw.trim();
  if (!trimmed) return [];

  const args: string[] = [];
  let current = '';
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inString: string | null = null;
  let escaped = false;

  for (let i = 0; i < argsRaw.length; i++) {
    const ch = argsRaw[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      current += ch;
      escaped = true;
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      current += ch;
      inString = ch;
      continue;
    }

    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);

    if (ch === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim() || argsRaw.endsWith(',')) {
    args.push(current.trim());
  }

  return args.filter((a) => a.length > 0);
}

function findVdCallsWithArgs(line: string): VdCallWithArgs[] {
  const regex = /(^|[^.\w])((?:voiden)(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g;
  const calls: VdCallWithArgs[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    const prefixLen = match[1]?.length ?? 0;
    const method = match[2];
    const methodStart = match.index + prefixLen;
    const column = methodStart + 1;
    const openParenIndex = line.indexOf('(', methodStart + method.length);
    if (openParenIndex === -1) continue;
    const closeParenIndex = findMatchingParen(line, openParenIndex);
    if (closeParenIndex === -1) continue;
    const argsRaw = line.slice(openParenIndex + 1, closeParenIndex);
    calls.push({ method, column, openParenIndex, closeParenIndex, argsRaw });
  }

  return calls;
}

function lintVdCallArguments(
  method: string,
  args: string[],
  line: number,
  column: number,
): ScriptValidationError[] {
  const errors: ScriptValidationError[] = [];
  const argCount = args.length;

  if (method === 'voiden.log') {
    if (argCount < 1) {
      errors.push({
        line,
        column,
        severity: 'warning',
        method,
        message: "voiden.log expects at least 1 argument. Use: voiden.log(message) or voiden.log(level, ...args).",
      });
    }
    return errors;
  }

  if (method === 'voiden.cancel') {
    if (argCount !== 0) {
      errors.push({
        line,
        column,
        severity: 'warning',
        method,
        message: "voiden.cancel does not take any arguments. Use: voiden.cancel().",
      });
    }
    return errors;
  }

  if (method === 'voiden.variables.get') {
    if (argCount !== 1) {
      errors.push({
        line,
        column,
        severity: 'warning',
        method,
        message: "voiden.variables.get expects 1 argument: key.",
      });
    }
    return errors;
  }

  if (method === 'voiden.env.get') {
    if (argCount !== 1) {
      errors.push({
        line,
        column,
        severity: 'warning',
        method,
        message: "voiden.env.get expects 1 argument: key.",
      });
    }
    return errors;
  }

  if (method === 'voiden.variables.set') {
    if (argCount !== 2) {
      errors.push({
        line,
        column,
        severity: 'warning',
        method,
        message: "voiden.variables.set expects 2 arguments: key, value.",
      });
    }
    return errors;
  }

  if (method === 'voiden.assert') {
    if (argCount < 3 || argCount > 4) {
      errors.push({
        line,
        column,
        severity: 'warning',
        method,
        message: "voiden.assert expects 3 or 4 arguments: actual, operator, expectedValue, message?.",
      });
      return errors;
    }

    const operatorArg = args[1]?.trim() ?? '';
    const strMatch = operatorArg.match(/^(['"`])(.*)\1$/);
    if (strMatch) {
      const operator = strMatch[2].trim().toLowerCase().replace(/\s+/g, '');
      if (!SUPPORTED_ASSERT_OPERATORS.has(operator)) {
        errors.push({
          line,
          column,
          severity: 'warning',
          method,
          message: `Unknown assert operator '${strMatch[2]}'. This assertion will fail at runtime.`,
        });
      }
    }
    return errors;
  }

  if (
    method === 'voiden.request.headers.push' ||
    method === 'voiden.request.queryParams.push' ||
    method === 'voiden.request.pathParams.push'
  ) {
    if (argCount < 1) {
      errors.push({
        line,
        column,
        severity: 'warning',
        method,
        message: `${method} expects at least 1 argument. Use push({ key: "name", value: "value" }).`,
      });
      return errors;
    }
    if (argCount > 1) {
      errors.push({
        line,
        column,
        severity: 'warning',
        method,
        message: `${method} accepts one entry per call. Use push({ key, value }) or call push multiple times.`,
      });
    }
    return errors;
  }

  return errors;
}

/**
 * Remove single-line comments (//) and block comments from a line,
 * respecting string literals so commented-out code inside strings isn't stripped.
 */
function stripLineComments(line: string): string {
  let result = '';
  let inString: string | null = null;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }
    if (inString) {
      result += ch;
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      result += ch;
      continue;
    }
    // Single-line comment — skip rest of line
    if (ch === '/' && i + 1 < line.length && line[i + 1] === '/') {
      break;
    }
    result += ch;
  }

  return result;
}

/** Replace string/comment contents with spaces, preserving length and newlines. */
function maskStringsAndComments(source: string): string {
  let result = '';
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      result += ch === '\n' ? '\n' : ' ';
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        result += '  ';
        i++;
      } else {
        result += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        result += ' ';
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        result += ' ';
        continue;
      }
      if (ch === inString) inString = null;
      result += ch === '\n' ? '\n' : ' ';
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      result += '  ';
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      result += '  ';
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      result += ' ';
      continue;
    }

    result += ch;
  }

  return result;
}

function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function indexToLineCol(lineStarts: number[], index: number): { line: number; column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - lineStarts[lo] + 1 };
}

const isIdentChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_$]/.test(c);

/**
 * Detects `await` used inside a JS function (declaration, expression, or
 * arrow) that isn't itself marked `async`. The engine wraps the whole
 * script body in an implicit async function, so top-level `await` is
 * always fine — but any function the user defines inside it (a
 * forEach/map callback, a helper function, a curried arrow) needs its own
 * `async` keyword. Getting this wrong throws a SyntaxError at compile
 * time, before any of the script runs, and V8 attaches no line/column to
 * that error at all — so this has to be caught here, statically, or the
 * user just sees "await is only valid in async functions..." with no way
 * to tell which line it's on.
 *
 * A function-body-opening '{' is identified purely by the token right
 * before it: ')' (end of a parameter list, only when the word before that
 * '(' is `function`) or '=>' (arrow). Any other preceding token is a
 * plain block/object/destructuring brace and inherits its enclosing
 * function's async-ness. Concise arrow bodies (no braces, e.g.
 * `x => await f(x)`) are tracked separately since they never open a '{'.
 * Object/class method shorthand (`foo() { ... }`) is not recognized as
 * its own function boundary — a known miss (it inherits the enclosing
 * scope instead), not a false positive.
 */
export function checkAwaitOutsideAsyncFunction(scriptBody: string): ScriptValidationError[] {
  if (!scriptBody || scriptBody.indexOf('await') === -1) return [];

  const masked = maskStringsAndComments(scriptBody);
  const lineStarts = buildLineStarts(scriptBody);

  function wordBefore(pos: number): { word: string; start: number } {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(masked[j])) j--;
    const end = j + 1;
    while (j >= 0 && isIdentChar(masked[j])) j--;
    return { word: masked.slice(j + 1, end), start: j + 1 };
  }

  // Mirrors the JS spec's "NamedEvaluation" — an otherwise-anonymous function
  // or arrow still gets a usable name when it's the direct right-hand side of
  // `const x = ...` / `x = ...` / an object property (`{ x: ... }`). `exprStart`
  // is the leftmost position of the function expression itself (the start of
  // `async`, or of `function`/the params if there's no `async`).
  function inferAssignedName(exprStart: number): string | undefined {
    let j = exprStart - 1;
    while (j >= 0 && /\s/.test(masked[j])) j--;
    if (j < 0) return undefined;

    if (masked[j] === ':') {
      // Object property shorthand: `{ name: (x) => { ... } }`
      return wordBefore(j).word || undefined;
    }

    if (masked[j] === '=') {
      // Rule out `==`, `=>`, and compound assignment (`+=`, `&&=`, etc.) —
      // only a plain, standalone `=` names its right-hand side.
      if (masked[j + 1] === '=' || masked[j + 1] === '>') return undefined;
      let p = j - 1;
      while (p >= 0 && /\s/.test(masked[p])) p--;
      // Excludes compound assignment (`+=`, `&&=`, ...) and comparisons whose
      // second character is this same '=' (`==`, `!=`, `<=`, `>=`).
      if (p >= 0 && '+-*/%&|^<>!~='.includes(masked[p])) return undefined;
      return wordBefore(j).word || undefined;
    }

    return undefined;
  }

  // `equalsPos` is the index of the '=' in this arrow's '=>'.
  function analyzeArrowSignature(equalsPos: number): { isAsync: boolean; exprStart: number } {
    let j = equalsPos - 1;
    while (j >= 0 && /\s/.test(masked[j])) j--;
    let paramsStart: number;
    if (masked[j] === ')') {
      let depth = 1;
      let p = j - 1;
      while (p >= 0 && depth > 0) {
        if (masked[p] === ')') depth++;
        else if (masked[p] === '(') depth--;
        p--;
      }
      paramsStart = p + 1;
    } else if (isIdentChar(masked[j])) {
      let e = j;
      while (e >= 0 && isIdentChar(masked[e])) e--;
      paramsStart = e + 1;
    } else {
      return { isAsync: false, exprStart: equalsPos };
    }
    const before = wordBefore(paramsStart);
    const isAsync = before.word === 'async';
    return { isAsync, exprStart: isAsync ? before.start : paramsStart };
  }

  function classifyBrace(bracePos: number): { isAsync: boolean; name?: string; isArrow?: boolean } | null {
    let k = bracePos - 1;
    while (k >= 0 && /\s/.test(masked[k])) k--;
    if (k < 0) return null;

    // Arrow function block body: (...) => { or ident => {
    if (masked[k] === '>' && masked[k - 1] === '=') {
      const { isAsync, exprStart } = analyzeArrowSignature(k - 1);
      return { isAsync, name: inferAssignedName(exprStart), isArrow: true };
    }

    // function keyword body: function name(...) { / function (...) { / function* (...) {
    if (masked[k] === ')') {
      let depth = 1;
      let p = k - 1;
      while (p >= 0 && depth > 0) {
        if (masked[p] === ')') depth++;
        else if (masked[p] === '(') depth--;
        p--;
      }
      let q = p; // index right before the matching '('
      while (q >= 0 && /\s/.test(masked[q])) q--;
      if (masked[q] === '*') {
        q--;
        while (q >= 0 && /\s/.test(masked[q])) q--;
      }

      // The identifier immediately before '(' (or '*') is either the
      // function's name, or — for an anonymous function — the word
      // "function" itself (e.g. `function (x) {`, no name in between).
      const identEnd = q + 1;
      while (q >= 0 && isIdentChar(masked[q])) q--;
      const identStart = q + 1;
      const ident = masked.slice(identStart, identEnd);

      if (ident === 'function') {
        const asyncWord = wordBefore(identStart);
        const isAsync = asyncWord.word === 'async';
        const exprStart = isAsync ? asyncWord.start : identStart;
        return { isAsync, name: inferAssignedName(exprStart) };
      }

      const before = wordBefore(identStart);
      if (before.word === 'function') {
        const isAsync = wordBefore(before.start).word === 'async';
        return { isAsync, name: ident };
      }
      return null;
    }

    return null;
  }

  type ScopeFrame = {
    isAsync: boolean;
    kind: 'top' | 'function' | 'concise' | 'block';
    name?: string;
    pos?: number;
    depthAtStart?: number;
  };
  const scopeStack: ScopeFrame[] = [{ isAsync: true, kind: 'top' }]; // the script's own top level is implicitly async
  let containerDepth = 0;
  const errors: ScriptValidationError[] = [];

  function popConciseAtCurrentDepth(): void {
    while (scopeStack.length > 1) {
      const top = scopeStack[scopeStack.length - 1];
      if (top.kind === 'concise' && top.depthAtStart === containerDepth) scopeStack.pop();
      else break;
    }
  }

  // Builds a synthetic "stack trace" for a flagged `await`: the chain of
  // enclosing functions from innermost to outermost. There's no real call
  // stack here — the script never ran — so this is assembled purely from
  // the static scope nesting captured above, which is the only trace that
  // actually exists for a compile-time SyntaxError.
  function describeScopeChain(): string {
    const frames: string[] = [];
    for (let s = scopeStack.length - 1; s >= 0; s--) {
      const frame = scopeStack[s];
      if (frame.kind === 'block') continue;
      if (frame.kind === 'top') {
        frames.push('    at the script\'s top level');
        continue;
      }
      const { line, column } = indexToLineCol(lineStarts, frame.pos!);
      const label = frame.kind === 'concise'
        ? frame.name ? `arrow function ${frame.name}` : 'arrow function'
        : frame.name ? `function ${frame.name}` : 'anonymous function';
      frames.push(`    at ${label} (Line ${line}:${column})`);
    }
    return frames.join('\n');
  }

  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];

    if (ch === '(' || ch === '[') {
      containerDepth++;
      continue;
    }
    if (ch === ')' || ch === ']') {
      popConciseAtCurrentDepth();
      containerDepth--;
      continue;
    }
    if (ch === ',' || ch === ';') {
      popConciseAtCurrentDepth();
      continue;
    }
    if (ch === '{') {
      const info = classifyBrace(i);
      containerDepth++;
      if (info) {
        scopeStack.push({
          isAsync: info.isAsync,
          kind: info.isArrow ? 'concise' : 'function',
          name: info.name,
          pos: i,
        });
      } else {
        scopeStack.push({ isAsync: scopeStack[scopeStack.length - 1].isAsync, kind: 'block' });
      }
      continue;
    }
    if (ch === '}') {
      popConciseAtCurrentDepth();
      containerDepth--;
      if (scopeStack.length > 1) scopeStack.pop();
      continue;
    }
    if (ch === '=' && masked[i + 1] === '>') {
      let j = i + 2;
      while (j < masked.length && /\s/.test(masked[j])) j++;
      if (masked[j] !== '{') {
        const { isAsync, exprStart } = analyzeArrowSignature(i);
        scopeStack.push({
          isAsync,
          kind: 'concise',
          pos: i,
          depthAtStart: containerDepth,
          name: inferAssignedName(exprStart),
        });
      }
      i++; // consume '>' too
      continue;
    }
    if (
      ch === 'a' &&
      masked.slice(i, i + 5) === 'await' &&
      !isIdentChar(masked[i - 1]) &&
      !isIdentChar(masked[i + 5])
    ) {
      if (!scopeStack[scopeStack.length - 1].isAsync) {
        const { line, column } = indexToLineCol(lineStarts, i);
        errors.push({
          line,
          column,
          message:
            "'await' is used inside a function that isn't marked async, so this will fail with a SyntaxError before the script runs. Add 'async', e.g. arr.forEach(async (x) => { await ... }).\n" +
            describeScopeChain(),
        });
      }
      i += 4; // consume the rest of 'await'
      continue;
    }
  }

  return errors;
}

/**
 * Validate a JavaScript script body for unawaited async vd calls.
 * Returns an array of errors (empty = valid).
 */
export function validateScript(scriptBody: string): ScriptValidationError[] {
  if (!scriptBody || !scriptBody.trim()) return [];

  const errors: ScriptValidationError[] = [];
  errors.push(...checkAwaitOutsideAsyncFunction(scriptBody));
  const lines = scriptBody.split('\n');
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Handle block comments
    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx === -1) continue; // entire line is inside block comment
      line = line.substring(endIdx + 2);
      inBlockComment = false;
    }

    // Strip block comment starts within this line
    let cleaned = '';
    let j = 0;
    while (j < line.length) {
      if (line[j] === '/' && j + 1 < line.length && line[j + 1] === '*') {
        const endIdx = line.indexOf('*/', j + 2);
        if (endIdx === -1) {
          inBlockComment = true;
          break;
        }
        j = endIdx + 2;
        continue;
      }
      cleaned += line[j];
      j++;
    }
    if (inBlockComment) continue;

    // Strip single-line comments (respecting strings)
    cleaned = stripLineComments(cleaned);
    const trimmed = cleaned.trim();
    if (!trimmed) continue;

    if (isLikelyPlainTextLine(trimmed, 'javascript')) {
      errors.push({
        line: i + 1,
        column: 1,
        severity: 'warning',
        message: "This line looks like plain text. Comment it with '//' or wrap it in quotes.",
      });
    }

    // Detect unknown vd function calls + argument lint for supported calls.
    for (const call of findVdCallsWithArgs(cleaned)) {
      if (!SUPPORTED_VD_CALLS.has(call.method)) {
        errors.push({
          line: i + 1,
          column: call.column,
          method: call.method,
          severity: 'warning',
          message: `Unknown function '${call.method}()'. Supported: voiden.env.get, voiden.variables.get/set, voiden.request.headers/queryParams/pathParams.push, voiden.log, voiden.assert, voiden.cancel.`,
        });
        continue;
      }

      errors.push(
        ...lintVdCallArguments(
          call.method,
          splitTopLevelArgs(call.argsRaw),
          i + 1,
          call.column,
        ),
      );
    }
  }

  return errors;
}

/**
 * Validate a Python script body with lightweight static checks.
 * Returns an array of errors (empty = valid).
 */
export function validatePythonScript(scriptBody: string): ScriptValidationError[] {
  if (!scriptBody || !scriptBody.trim()) return [];

  const errors: ScriptValidationError[] = [];
  const lines = scriptBody.split('\n');
  const stack: Array<{ ch: string; line: number; column: number }> = [];
  const openToClose: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const closeToOpen: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

  const stripPyComments = (line: string): string => {
    let result = '';
    let inString: string | null = null;
    let escaped = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escaped) {
        result += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        result += ch;
        escaped = true;
        continue;
      }
      if (inString) {
        result += ch;
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        result += ch;
        continue;
      }
      if (ch === '#') break;
      result += ch;
    }
    return result;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const cleaned = stripPyComments(raw);
    const trimmed = cleaned.trim();
    if (!trimmed) continue;

    if (isLikelyPlainTextLine(trimmed, 'python')) {
      errors.push({
        line: i + 1,
        column: 1,
        severity: 'warning',
        message: "This line looks like plain text. Comment it with '#' or wrap it in quotes.",
      });
    }

    // Python scripts are executed synchronously in this runtime.
    const awaitIdx = cleaned.indexOf('await ');
    if (awaitIdx >= 0) {
      errors.push({
        line: i + 1,
        column: awaitIdx + 1,
        message: "Python scripts run synchronously here; remove 'await'.",
      });
    }

    // Detect mixed tab/space indentation (common source of Python errors).
    const indentMatch = raw.match(/^[\t ]+/);
    if (indentMatch && indentMatch[0].includes('\t') && indentMatch[0].includes(' ')) {
      errors.push({
        line: i + 1,
        column: 1,
        message: 'Mixed tabs and spaces in indentation.',
      });
    }

    // Bracket pairing checks.
    let inString: string | null = null;
    let escaped = false;
    for (let j = 0; j < cleaned.length; j++) {
      const ch = cleaned[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (inString) {
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        continue;
      }

      if (openToClose[ch]) {
        stack.push({ ch, line: i + 1, column: j + 1 });
      } else if (closeToOpen[ch]) {
        const last = stack[stack.length - 1];
        if (!last || last.ch !== closeToOpen[ch]) {
          errors.push({
            line: i + 1,
            column: j + 1,
            message: `Unexpected '${ch}'.`,
          });
        } else {
          stack.pop();
        }
      }
    }

    // Detect unknown vd function calls + argument lint for supported calls.
    // voiden.assert is the same spelling as every other language here too —
    // the runtime's own Python wrapper rewrites `voiden.assert(` to its
    // internal `voiden.assert_(` right before execution (assert is a
    // reserved keyword in Python, so `.assert` can't be written directly),
    // but that's invisible plumbing a user should never type themselves, so
    // the linter must not recognize or suggest `assert_`.
    for (const call of findVdCallsWithArgs(cleaned)) {
      if (!SUPPORTED_VD_CALLS.has(call.method)) {
        errors.push({
          line: i + 1,
          column: call.column,
          method: call.method,
          severity: 'warning',
          message: `Unknown function '${call.method}()'. Supported: voiden.env.get, voiden.variables.get/set, voiden.request.headers/queryParams/pathParams.push, voiden.log, voiden.assert, voiden.cancel.`,
        });
        continue;
      }

      errors.push(
        ...lintVdCallArguments(
          call.method,
          splitTopLevelArgs(call.argsRaw),
          i + 1,
          call.column,
        ),
      );
    }
  }

  for (const unclosed of stack) {
    errors.push({
      line: unclosed.line,
      column: unclosed.column,
      message: `Unclosed '${unclosed.ch}'.`,
    });
  }

  return errors;
}

/**
 * Validate a Shell (bash) script body with lightweight static checks.
 * Returns an array of errors (empty = valid).
 */
export function validateShellScript(scriptBody: string): ScriptValidationError[] {
  if (!scriptBody || !scriptBody.trim()) return [];

  const errors: ScriptValidationError[] = [];
  const lines = scriptBody.split('\n');

  const stripShComments = (line: string): string => {
    let result = '';
    let inString: string | null = null;
    let escaped = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escaped) {
        result += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        result += ch;
        escaped = true;
        continue;
      }
      if (inString) {
        result += ch;
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        result += ch;
        continue;
      }
      if (ch === '#') break;
      result += ch;
    }
    return result;
  };

  const VOIDEN_SH_KEYWORDS = /^(voiden_log|voiden_env_get|voiden_variables_get|voiden_variables_set|voiden_assert|voiden_cancel|if|elif|else|fi|for|while|do|done|case|esac|function|return|export|local|echo|printf|source|\.)\b/;
  const SH_CODE_SYMBOLS = /[=\$\(\)\[\]{};|&<>]/;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const cleaned = stripShComments(raw);
    const trimmed = cleaned.trim();
    if (!trimmed) continue;

    // Plain text detection for shell
    if (!VOIDEN_SH_KEYWORDS.test(trimmed) && !SH_CODE_SYMBOLS.test(trimmed)) {
      if (/^[A-Za-z][A-Za-z0-9_'"\-]*(\s+[A-Za-z0-9_'"\-]+)+$/.test(trimmed)) {
        errors.push({
          line: i + 1,
          column: 1,
          severity: 'warning',
          message: "This line looks like plain text. Comment it with '#' or quote it.",
        });
      }
    }

  }

  return errors;
}
