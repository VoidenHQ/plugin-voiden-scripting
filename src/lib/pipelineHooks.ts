/**
 * Pipeline hooks for the scripting extension.
 *
 * Three hooks:
 * 1. pre-processing (priority 5) — captures editor document
 * 2. pre-send (priority 15) — executes pre-request script
 * 3. post-processing (priority 25) — executes post-response script
 */

import { executeScript } from './scriptEngine.js';
import { buildVdRequest, buildVdResponse, applyVdRequestToState, applyVdResponseToState, buildVariablesApi, buildEnvApi } from './vdApi.js';
import { validatePythonScript, validateScript } from './validateScript.js';
import { scriptLogStore } from './logStore.js';
import type { VdApi, ScriptLanguage } from './types.js';

/** Module-level cache of the editor document captured during pre-processing. */
let cachedEditorDocument: any = null;

/**
 * Extract script body and language from editor document for a given node type.
 * Traverses the document tree and returns the body + language of the last matching node.
 */
function extractScriptFromDoc(doc: any, nodeType: string): { body: string; language: ScriptLanguage } | null {
  if (!doc || !doc.content) return null;

  let result: { body: string; language: ScriptLanguage } | null = null;

  function traverse(node: any) {
    if (node.type === nodeType && node.attrs?.body) {
      result = {
        body: node.attrs.body,
        language: node.attrs.language || 'javascript',
      };
    }
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach((child: any) => traverse(child));
    }
  }

  traverse(doc);
  return result;
}

/**
 * Strip comments from script body based on language.
 */
function stripComments(body: string, language: ScriptLanguage): string {
  if (language === 'python') {
    return body.replace(/#.*$/gm, '').trim();
  }
  return body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

/**
 * Format runtime script errors into a clean, user-script-only trace: the
 * message, then one "at functionName (Line N:C)" per frame that actually
 * ran inside the user's own script — so a syntax/runtime error shows not
 * just where it happened but which of the user's own functions led there.
 * Engine/worker-internal frames (self.onmessage, MessagePort, node:internal/...)
 * and native calls with no real position (e.g. "at JSON.parse (<anonymous>)")
 * are dropped; they're never useful to the user and were the entire original
 * complaint (a raw stack that was ALL such frames, with zero user-script
 * content, e.g. "at new AsyncFunction (<anonymous>)").
 */
function formatScriptRuntimeError(rawError: unknown, scriptBody: string, language: ScriptLanguage): string {
  const text = String(rawError || '').trim();
  if (!text) return 'Script execution failed';

  const lines = text.split('\n');
  const messageLine = lines.find(Boolean)?.trim() || 'Script execution failed';

  if (language !== 'javascript') {
    // Python's own traceback already lists file/line/function per frame in
    // human-readable form; just surface the message with its own line
    // number when present, same as before.
    const pythonLineMatch = text.match(/line\s+(\d+)/i);
    if (pythonLineMatch) return `Line ${pythonLineMatch[1]}: ${messageLine}`;
    return messageLine;
  }

  // `new AsyncFunction('voiden', 'vd', 'require', scriptBody)` compiles to
  // an implicit `async function anonymous(voiden,vd,require\n) {\n<body>`,
  // so the user's own source line 1 is compiled-line 3 — every reported
  // <anonymous>:LINE:COL is always exactly +2 from the user's real line,
  // not just "when it looks out of range" (a raw line can coincidentally
  // still fall inside the script's own line count and wrongly skip
  // adjustment — verified against real V8 stacks from this exact wrapper).
  const scriptLineCount = scriptBody.split('\n').length;
  const frames: string[] = [];
  for (const raw of lines.slice(1)) {
    const posMatch = raw.match(/<anonymous>:(\d+):(\d+)/);
    if (!posMatch) continue; // not a user-script frame — skip.

    const nameMatch = raw.match(/^\s*at\s+([^(]+?)\s*\(/);
    let name = nameMatch ? nameMatch[1].trim() : null;
    if (name === 'eval' || name === '<anonymous>') name = null; // top-level script code, not a user-named function

    // Clamped, not just offset: if some future engine version ever changes
    // the wrapper's line overhead, this still can't report a line number
    // that doesn't exist in the user's own script.
    const line = Math.min(Math.max(1, Number(posMatch[1]) - 2), scriptLineCount);
    const col = Number(posMatch[2]);
    frames.push(name ? `    at ${name} (Line ${line}:${col})` : `    at Line ${line}:${col}`);
  }

  // No user-script frame captured — most commonly a SyntaxError, which
  // throws at compile time before any of the script ever runs, so there's
  // no execution position to report at all.
  if (frames.length === 0) return messageLine;

  return [messageLine, ...frames].join('\n');
}

function didScriptChangePayload(before: any, after: any): boolean {
  try {
    return JSON.stringify(before) !== JSON.stringify(after);
  } catch {
    // If serialization fails, be safe and treat as changed.
    return true;
  }
}

/**
 * Pre-processing hook: Capture editor document with expanded linked blocks.
 * Checks if already set by another extension (e.g. simple-assertions) to avoid overwriting.
 */
export async function preProcessingScriptHook(context: any): Promise<void> {
  if (!context.editor) return;

  if (!context.requestState) {
    return;
  }
  if (!context.requestState.metadata) {
    context.requestState.metadata = {};
  }

  // Don't overwrite if another extension already captured the document
  if (context.requestState.metadata.editorDocument) {
    cachedEditorDocument = context.requestState.metadata.editorDocument;
    return;
  }

  let editorJson = context.editor.getJSON();

  try {
    // @ts-ignore - Path resolved at runtime in app context
    const { expandLinkedBlocksInDoc } = await import(/* @vite-ignore */ '@/core/editors/voiden/utils/expandLinkedBlocks');
    editorJson = await expandLinkedBlocksInDoc(editorJson, { forceRefresh: true });
  } catch {
    // Continue with unexpanded document
  }

  context.requestState.metadata.editorDocument = editorJson;
  cachedEditorDocument = editorJson;
}

/**
 * Pre-send hook: Execute pre-request script.
 * Runs after faker (priority 10) so scripts see faker-replaced values.
 */
export async function preSendScriptHook(context: any): Promise<void> {
  const { requestState } = context;
  const doc = cachedEditorDocument;
  if (!doc) return;

  const scriptInfo = extractScriptFromDoc(doc, 'pre_script');
  if (!scriptInfo || !scriptInfo.body.trim()) return;

  const { body: scriptBody, language } = scriptInfo;

  // Skip comment-only scripts
  const stripped = stripComments(scriptBody, language);
  if (!stripped) return;

  // Block execution if static validation fails
  if (language === 'javascript' || language === 'python') {
    const errors = language === 'python'
      ? validatePythonScript(scriptBody)
      : validateScript(scriptBody);
    const blockingErrors = errors.filter((e) => (e.severity || 'error') === 'error');
    if (blockingErrors.length > 0) {
      if (!requestState.metadata) requestState.metadata = {};
      const msg = blockingErrors.map(e => `Line ${e.line}: ${e.message}`).join('\n');
      const errMsg = `Script validation failed:\n${msg}`;
      requestState.metadata.preScriptError = errMsg;
      scriptLogStore.push('pre', [], errMsg, 1);
      return;
    }
  }

  const vdRequest = buildVdRequest(requestState);
  const vdRequestBeforeScript = JSON.parse(JSON.stringify(vdRequest));
  const activeEnvKey = await (window as any).electron?.variables?.getActiveEnvKey?.();
  console.log('[preSendScriptHook] activeEnvKey:', activeEnvKey);
  const variablesApi = buildVariablesApi(activeEnvKey);
  const envApi = buildEnvApi();

  const vdApi: VdApi = {
    request: vdRequest,
    response: undefined,
    env: envApi,
    variables: variablesApi,
    log: () => {},
    cancel: () => {},
  };

  const result = await executeScript(scriptBody, vdApi, language);

  // Apply request modifications back to pipeline state
  if (
    result.success &&
    result.modifiedRequest &&
    didScriptChangePayload(vdRequestBeforeScript, result.modifiedRequest)
  ) {
    applyVdRequestToState(result.modifiedRequest, requestState);
  }

  // Store logs and errors in metadata
  if (!requestState.metadata) requestState.metadata = {};
  requestState.metadata.preScriptLogs = result.logs;
  // formatScriptRuntimeError trims the raw engine-wrapper stack (e.g.
  // "at new AsyncFunction (<anonymous>)... at self.onmessage (...)", which
  // has no reference to the user's own script) down to the actual line in
  // the script + message; the "Pre-request script" prefix identifies which
  // of the two script phases raised it, since a request can have both.
  const preError = result.error
    ? `Pre-request script — ${formatScriptRuntimeError(result.error, scriptBody, language)}`
    : undefined;
  if (preError) requestState.metadata.preScriptError = preError;

  // Store assertion results
  if (result.assertions && result.assertions.length > 0) {
    const total = result.assertions.length;
    const passed = result.assertions.filter(a => a.passed).length;
    requestState.metadata.preScriptAssertions = {
      results: result.assertions,
      totalAssertions: total,
      passedAssertions: passed,
      failedAssertions: total - passed,
    };
  }

  // Push to sidebar log store
  scriptLogStore.push('pre', result.logs, preError, result.exitCode);

  // Handle cancellation
  if (result.cancelled) {
    requestState.metadata.scriptCancelled = true;
    throw new Error('Request cancelled by pre-request script');
  }
}

/**
 * Post-processing hook: Execute post-response script.
 * Runs after assertions (priority 15) so scripts can read assertion results.
 */
export async function postProcessScriptHook(context: any): Promise<void> {
  const { requestState, responseState } = context;
  const doc = cachedEditorDocument;

  // Always carry pre-script assertions into response metadata, even when no post script runs.
  if (!responseState.metadata) responseState.metadata = {};
  if (!responseState.metadata.scriptAssertionResults && requestState?.metadata?.preScriptAssertions) {
    responseState.metadata.scriptAssertionResults = requestState.metadata.preScriptAssertions;
  }

  if (!doc) return;

  const scriptInfo = extractScriptFromDoc(doc, 'post_script');
  if (!scriptInfo || !scriptInfo.body.trim()) return;

  const { body: scriptBody, language } = scriptInfo;

  // Skip comment-only scripts
  const stripped = stripComments(scriptBody, language);
  if (!stripped) return;

  // Block execution if static validation fails
  if (language === 'javascript' || language === 'python') {
    const errors = language === 'python'
      ? validatePythonScript(scriptBody)
      : validateScript(scriptBody);
    const blockingErrors = errors.filter((e) => (e.severity || 'error') === 'error');
    if (blockingErrors.length > 0) {
      const msg = blockingErrors.map(e => `Line ${e.line}: ${e.message}`).join('\n');
      const errMsg = `Script validation failed:\n${msg}`;
      responseState.metadata.postScriptError = errMsg;
      scriptLogStore.push('post', [], errMsg, 1);
      return;
    }
  }

  const vdRequest = buildVdRequest(requestState);
  const vdResponse = buildVdResponse(responseState);
  const vdResponseBeforeScript = JSON.parse(JSON.stringify(vdResponse));
  const activeEnvKey = await (window as any).electron?.variables?.getActiveEnvKey?.();
  console.log('[postProcessScriptHook] activeEnvKey:', activeEnvKey);
  const variablesApi = buildVariablesApi(activeEnvKey);
  const envApi = buildEnvApi();

  const vdApi: VdApi = {
    request: vdRequest,
    response: vdResponse,
    env: envApi,
    variables: variablesApi,
    log: () => {},
    cancel: () => {},
  };

  const result = await executeScript(scriptBody, vdApi, language);

  // Apply response modifications back to pipeline state
  if (
    result.success &&
    result.modifiedResponse &&
    didScriptChangePayload(vdResponseBeforeScript, result.modifiedResponse)
  ) {
    applyVdResponseToState(result.modifiedResponse, responseState);
  }

  // Store logs and errors in response metadata
  responseState.metadata.postScriptLogs = result.logs;
  // See the matching comment in preSendScriptHook — same cleanup, "Post-response
  // script" prefix instead since this is the other of the two script phases.
  const postError = (result.error || result.success === false)
    ? `Post-response script — ${formatScriptRuntimeError(result.error || 'Script execution failed', scriptBody, language)}`
    : undefined;
  if (postError) responseState.metadata.postScriptError = postError;

  // Store assertion results (merge pre + post)
  if (result.assertions && result.assertions.length > 0) {
    const preAssertions = requestState?.metadata?.preScriptAssertions;
    const allResults = [
      ...(preAssertions?.results || []),
      ...result.assertions,
    ];
    const total = allResults.length;
    const passed = allResults.filter((a: any) => a.passed).length;
    responseState.metadata.scriptAssertionResults = {
      results: allResults,
      totalAssertions: total,
      passedAssertions: passed,
      failedAssertions: total - passed,
    };
  }

  // Push to sidebar log store
  scriptLogStore.push('post', result.logs, postError, result.exitCode);

  // Clear cached document after post-processing
  cachedEditorDocument = null;
}
