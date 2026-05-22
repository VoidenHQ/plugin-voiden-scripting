/**
 * voiden-scripting — headless pipeline hook runner (voiden-runner / CI-CD).
 *
 * Uses executeHeadlessScript() — direct subprocess, no Electron IPC.
 * Same vdAPI as the Electron plugin.ts; same assertion/log output format.
 *
 *   JavaScript  → in-process AsyncFunction (no subprocess overhead)
 *   Python      → python3 subprocess (detected at runtime)
 *   Shell       → bash subprocess
 *
 * Env vars come from the CLI --env file injected by the runner into
 * editor.__cliEnv during pre-processing.
 * Runtime variables come from ~/.voiden/.process.env.json.
 *
 * Does NOT import pipelineHooks.ts — that module uses window/Electron.
 * Does NOT touch plugin.ts.
 */

import type { RunnerFactory, RunnerContext, Block, CliRequestState, CliResponseState } from '@voiden/sdk/runner'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractScript(doc: any, nodeType: string): { body: string; language: string } | null {
  if (!doc?.content) return null
  let found: { body: string; language: string } | null = null
  const walk = (node: any) => {
    if (node.type === nodeType && node.attrs?.body) {
      found = { body: node.attrs.body, language: node.attrs.language ?? 'javascript' }
    }
    node.content?.forEach?.((c: any) => walk(c))
  }
  walk(doc)
  return found
}

function stripComments(body: string, language: string): string {
  if (language === 'python') return body.replace(/#.*$/gm, '').trim()
  return body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
}

function loadVariables(): Record<string, any> {
  const path = join(homedir(), '.voiden', '.process.env.json')
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return {} }
}

function buildVdRequest(rs: CliRequestState) {
  const toArr = (v: any) => {
    if (Array.isArray(v)) return v
    if (v && typeof v === 'object') return Object.entries(v).map(([key, value]) => ({ key, value: String(value), enabled: true }))
    return []
  }
  return {
    url:         rs.url ?? '',
    method:      rs.method ?? 'GET',
    headers:     toArr(rs.headers),
    body:        rs.body,
    queryParams: toArr(rs.queryParams),
    pathParams:  toArr(rs.pathParams),
  }
}

function buildVdResponse(rs: CliResponseState) {
  const headers: Record<string, string> = {}
  // Note: CliResponseState doesn't explicitly have headers in types.ts, but they are often present in metadata or implementation
  // For now we assume they might be present on the object or we'll need to update the SDK types later.
  const rawHeaders = (rs as any).headers ?? []
  rawHeaders.forEach((h: any) => { headers[h.key] = h.value })
  return {
    status:     rs.status,
    statusText: rs.statusText,
    headers,
    body:       rs.body,
    time:       rs.durationMs ?? 0,
    size:       rs.size ?? 0,
  }
}

function applyRequestBack(vdRequest: any, requestState: CliRequestState) {
  requestState.url    = vdRequest.url
  requestState.method = vdRequest.method
  const norm = (v: any) => {
    if (Array.isArray(v)) return v
    if (v && typeof v === 'object') return Object.entries(v).map(([key, value]) => ({ key, value: String(value), enabled: true }))
    return []
  }
  requestState.headers     = norm(vdRequest.headers)
  requestState.queryParams = norm(vdRequest.queryParams)
  requestState.pathParams  = norm(vdRequest.pathParams)
  if (vdRequest.body != null && typeof vdRequest.body === 'object') {
    try { requestState.body = JSON.stringify(vdRequest.body) } catch { requestState.body = String(vdRequest.body) }
  } else {
    requestState.body = vdRequest.body
  }
}

function applyResponseBack(vdResponse: any, responseState: CliResponseState) {
  if (vdResponse.status !== undefined)     responseState.status     = vdResponse.status
  if (vdResponse.statusText !== undefined) responseState.statusText = vdResponse.statusText
  if (vdResponse.body !== undefined)       responseState.body       = vdResponse.body
}

function pushToReportEntries(metadata: any, result: any, logs: any[]) {
  if (!Array.isArray(metadata.reportEntries)) metadata.reportEntries = []
  const entries: any[] = metadata.reportEntries

  // Assertions
  for (const a of (result.assertions ?? [])) {
    entries.push({
      type:     'assertion',
      message:  a.message || a.condition || 'Script assertion',
      passed:   a.passed,
      actual:   a.actualValue,
      expected: a.expectedValue,
      operator: a.operator,
    })
  }

  // Logs
  for (const log of logs) {
    const message = Array.isArray(log.args)
      ? log.args.map((a: any) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
      : String(log.args ?? '')
    if (message) entries.push({ type: 'log', message, level: log.level ?? 'log' })
  }

  // Script errors
  if (result.error) {
    entries.push({ type: 'log', message: `Script error: ${result.error}`, level: 'error' })
  }
}

// ── Runner factory ────────────────────────────────────────────────────────────

const createVoidenScriptingRunner: RunnerFactory = (context: RunnerContext) => {
  return {
    onload() {
      // Per-load-cycle state — reset on each loadEnabledPlugins() call.
      let cachedDoc: any = null
      let cliEnv: Record<string, string> = {}

      // ── Stage 1: Pre-processing (priority 5) ────────────────────────────────
      // Capture editor document, CLI env, and runtime vars injected by the runner.
      context.pipeline.registerHook(
        'pre-processing',
        (ctx: any) => {
          if (!ctx.editor) return
          if (!ctx.requestState.metadata) ctx.requestState.metadata = {}
          const doc = ctx.editor.getJSON()
          ctx.requestState.metadata.editorDocument = doc
          cachedDoc = doc
          // runner.ts injects env via editor.__cliEnv
          cliEnv = (ctx.editor as any).__cliEnv ?? {}
          // runner.ts injects the shared runtimeVars reference via editor.__cliVars
          // Stash it so pre-send and post-processing hooks can read/write it.
          ctx.requestState.metadata._cliVarsRef = (ctx.editor as any).__cliVars ?? {}
        },
        5,
      )

      // ── Stage 2: Pre-send (priority 15) ─────────────────────────────────────
      // Execute pre-request script headlessly.
      context.pipeline.registerHook(
        'pre-send',
        async (ctx: any) => {
          if (!cachedDoc) return
          const scriptInfo = extractScript(cachedDoc, 'pre_script')
          if (!scriptInfo || !stripComments(scriptInfo.body, scriptInfo.language)) return

          const { executeHeadlessScript } = await import('./lib/headlessScriptEngine.js')
          // Merge persistent vars (~/.voiden/.process.env.json) with in-memory runtime vars.
          // The cliVarsRef is a shared reference — mutations propagate to the run loop.
          const cliVarsRef: Record<string, any> = ctx.requestState.metadata?._cliVarsRef ?? {}
          const variables = { ...loadVariables(), ...cliVarsRef }
          const vdReq = buildVdRequest(ctx.requestState)

          const result = await executeHeadlessScript(
            scriptInfo.body,
            scriptInfo.language as any,
            vdReq,
            null,
            cliEnv,
            variables,
          )

          // Apply request mutations back to pipeline state
          if (result.success && result.modifiedRequest) {
            applyRequestBack(result.modifiedRequest, ctx.requestState)
          }

          // Write script variable mutations back into the shared runtime vars map
          if (result.modifiedVariables) {
            Object.assign(cliVarsRef, result.modifiedVariables)
          }

          // Stash logs and assertions for the post-processing reportEntries hook
          if (!ctx.requestState.metadata) ctx.requestState.metadata = {}
          ctx.requestState.metadata.preScriptLogs       = result.logs ?? []
          ctx.requestState.metadata.preScriptAssertions = result.assertions ?? []
          if (result.error) ctx.requestState.metadata.preScriptError = result.error

          // Cancel if script called vd.cancel()
          if (result.cancelled) {
            ctx.requestState.metadata.scriptCancelled = true
            throw new Error('Request cancelled by pre-request script')
          }
        },
        15,
      )

      // ── Stage 3: Post-processing (priority 25) ───────────────────────────────
      // Execute post-response script headlessly.
      context.pipeline.registerHook(
        'post-processing',
        async (ctx: any) => {
          if (!ctx.responseState.metadata) ctx.responseState.metadata = {}
          const rm = ctx.responseState.metadata

          if (!cachedDoc) return
          const scriptInfo = extractScript(cachedDoc, 'post_script')
          if (!scriptInfo || !stripComments(scriptInfo.body, scriptInfo.language)) return

          const { executeHeadlessScript } = await import('./lib/headlessScriptEngine.js')
          const cliVarsRef: Record<string, any> = ctx.requestState?.metadata?._cliVarsRef ?? {}
          const variables = { ...loadVariables(), ...cliVarsRef }
          const vdReq = buildVdRequest(ctx.requestState)
          const vdRes = buildVdResponse(ctx.responseState)

          const result = await executeHeadlessScript(
            scriptInfo.body,
            scriptInfo.language as any,
            vdReq,
            vdRes,
            cliEnv,
            variables,
          )

          // Apply response mutations back
          if (result.success && result.modifiedResponse) {
            applyResponseBack(result.modifiedResponse, ctx.responseState)
          }

          // Write script variable mutations back into the shared runtime vars map
          if (result.modifiedVariables) {
            Object.assign(cliVarsRef, result.modifiedVariables)
          }

          rm.postScriptLogs       = result.logs ?? []
          rm.postScriptAssertions = result.assertions ?? []
          if (result.error) rm.postScriptError = result.error

          cachedDoc = null
        },
        25,
      )

      // ── Stage 4: Post-processing (priority 60) ───────────────────────────────
      // Merge all script results → reportEntries (read by CLI, CSV, mail).
      context.pipeline.registerHook(
        'post-processing',
        (ctx: any) => {
          const rs = ctx.responseState
          if (!rs) return
          if (!rs.metadata) rs.metadata = {}

          const preLogs   = ctx.requestState?.metadata?.preScriptLogs ?? []
          const preAssert = ctx.requestState?.metadata?.preScriptAssertions ?? []
          const postLogs  = rs.metadata.postScriptLogs ?? []
          const postAssert = rs.metadata.postScriptAssertions ?? []
          const preErr    = ctx.requestState?.metadata?.preScriptError
          const postErr   = rs.metadata.postScriptError

          const combinedResult = {
            assertions: [...preAssert, ...postAssert],
            error: postErr ?? preErr,
          }
          const combinedLogs = [...preLogs, ...postLogs]

          pushToReportEntries(rs.metadata, combinedResult, combinedLogs)
        },
        60,
      )
    },
  }
}

export default createVoidenScriptingRunner

