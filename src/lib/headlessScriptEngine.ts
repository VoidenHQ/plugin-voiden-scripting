/**
 * Headless script engine — voiden-runner / CI-CD.
 *
 * Executes scripts via direct subprocess without Electron IPC.
 * Same vdAPI contract as the Electron engine; same stdin/stdout JSON protocol.
 *
 *   JavaScript  → in-process AsyncFunction (zero overhead, full vdAPI)
 *   Node worker → node subprocess via worker_threads (same as Electron path)
 *   Python      → python3 subprocess (uses pythonWrapperSource)
 *   Shell       → bash subprocess (uses buildBashScript)
 *
 * Entry point: executeHeadlessScript()
 */

import { spawn, execFileSync } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { workerSource, nodeHostWrapperSource, pythonWrapperSource, buildBashScript } from './scriptEngine.js'
import type { ScriptExecutionResult, ScriptLog } from './types.js'

export type HeadlessScriptLanguage = 'javascript' | 'python' | 'shell'

const TIMEOUT_MS = 10_000

// ── Runtime availability checks ───────────────────────────────────────────────

let _pythonBin: string | null | undefined

/** Finds the python3/python binary, caches the result. Returns null if not found. */
export function getPythonBin(): string | null {
  if (_pythonBin !== undefined) return _pythonBin
  for (const bin of ['python3', 'python']) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe', timeout: 3000 })
      _pythonBin = bin
      return bin
    } catch { /* try next */ }
  }
  _pythonBin = null
  return null
}

/** Check Node.js worker_threads (always available in Node ≥ 12). */
export function isNodeAvailable(): boolean {
  try { require('worker_threads'); return true } catch { return false }
}

/** Load variables from ~/.voiden/.process.env.json (best-effort). */
export function loadHeadlessVariables(): Record<string, any> {
  const path = join(homedir(), '.voiden', '.process.env.json')
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return {} }
}

// ── Subprocess helper ─────────────────────────────────────────────────────────

function runSubprocess(
  command: string,
  args: string[],
  stdinData: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ stdout: '', stderr: `Timed out after ${TIMEOUT_MS}ms`, code: -1 })
    }, TIMEOUT_MS)

    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }) })

    child.stdin.write(stdinData, 'utf-8')
    child.stdin.end()
  })
}

function parseSubprocessResult(
  stdout: string,
  stderr: string,
  code: number | null,
): ScriptExecutionResult {
  const raw = stdout.trim().split('\n').pop() ?? ''
  try {
    const r = JSON.parse(raw)
    return {
      success:          Boolean(r.success),
      logs:             Array.isArray(r.logs) ? r.logs : [],
      assertions:       Array.isArray(r.assertions) ? r.assertions : [],
      cancelled:        Boolean(r.cancelled),
      error:            r.error,
      exitCode:         code ?? 0,
      modifiedRequest:  r.modifiedRequest,
      modifiedResponse: r.modifiedResponse,
    }
  } catch {
    const errMsg = stderr.trim() || `Script output could not be parsed: ${raw.slice(0, 300)}`
    return { success: false, logs: [], error: errMsg, cancelled: false, exitCode: code ?? 1 }
  }
}

// ── JavaScript — in-process AsyncFunction ────────────────────────────────────

async function executeJs(
  scriptBody: string,
  request: any,
  response: any,
  envVars: Record<string, string>,
  variables: Record<string, any>,
): Promise<ScriptExecutionResult> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const logs: ScriptLog[] = []
  const assertions: any[] = []
  let cancelled = false
  const localVars = { ...variables }
  const modifiedVariables: Record<string, any> = {}

  const normalizeOp = (op: string): string | null => {
    const map: Record<string, string> = {
      '==':'==','===':'===','eq':'==','equal':'==',
      '!=':'!=','!==':'!==','neq':'!=','notequal':'!=',
      '>':'>','>=':'>=','<':'<','<=':'<=',
      'greater':'>','greaterthan':'>','gte':'>=',
      'less':'<','lessthan':'<','lte':'<=',
      'contains':'contains','includes':'contains',
      'matches':'matches','regex':'matches',
      'truthy':'truthy','falsy':'falsy',
    }
    return map[op.trim().toLowerCase().replace(/\s+/g, '')] ?? null
  }

  const evalOp = (actual: any, op: string, expected: any): boolean => {
    try {
      switch (op) {
        case '==': return actual == expected
        case '===': return actual === expected
        case '!=': return actual != expected
        case '!==': return actual !== expected
        case '>': return actual > expected
        case '>=': return actual >= expected
        case '<': return actual < expected
        case '<=': return actual <= expected
        case 'contains':
          return typeof actual === 'string'
            ? actual.includes(String(expected))
            : Array.isArray(actual) && actual.includes(expected)
        case 'matches': return new RegExp(String(expected)).test(String(actual))
        case 'truthy': return Boolean(actual)
        case 'falsy': return !actual
        default: return Boolean(actual)
      }
    } catch { return false }
  }

  const toText = (v: any) => { try { return JSON.stringify(v) } catch { return String(v) } }

  const voiden = {
    request,
    response,
    env: {
      get: (key: string) => envVars[key],
    },
    variables: {
      get: (key: string) => localVars[key],
      set: (key: string, value: any) => { localVars[key] = value; modifiedVariables[key] = value },
    },
    log: (levelOrMsg: any, ...args: any[]) => {
      const lvls = ['log', 'info', 'debug', 'warn', 'warning', 'error']
      const isLevel = typeof levelOrMsg === 'string' && lvls.includes(levelOrMsg.toLowerCase())
      const lvl: ScriptLog['level'] = isLevel ? (levelOrMsg === 'warning' ? 'warn' : levelOrMsg) : 'log'
      logs.push({ level: lvl, args: isLevel ? args : [levelOrMsg, ...args] })
    },
    assert: (actual: any, op: string, expected: any, message?: string) => {
      const normalized = normalizeOp(op)
      if (!normalized) {
        assertions.push({ passed: false, message: message ?? '', reason: `Unsupported operator: ${op}`, actualValue: actual, operator: op, expectedValue: expected })
        return
      }
      assertions.push({
        passed: evalOp(actual, normalized, expected),
        message: message ?? '',
        condition: `${toText(actual)} ${normalized} ${toText(expected)}`,
        actualValue: actual, operator: normalized, expectedValue: expected,
      })
    },
    cancel: () => { cancelled = true },
  }

  try {
    const fn = new AsyncFunction('voiden', 'vd', scriptBody)
    await fn(voiden, voiden)
    return { success: true, logs, assertions, cancelled, exitCode: 0, modifiedRequest: voiden.request, modifiedResponse: voiden.response, modifiedVariables }
  } catch (err: any) {
    return { success: false, logs, assertions, error: String(err?.stack || err?.message || err), cancelled, exitCode: 1, modifiedVariables }
  }
}

// ── Node.js subprocess — worker_threads (same as Electron path) ──────────────

async function executeNodeWorker(
  scriptBody: string,
  request: any,
  response: any,
  envVars: Record<string, string>,
  variables: Record<string, any>,
): Promise<ScriptExecutionResult> {
  const payload = JSON.stringify({
    scriptBody,
    workerSource,          // the worker_threads source (nodeHostWrapperSource reads this)
    request:  request ?? {},
    response: response ?? null,
    envVars,
    variables,
  })
  const { stdout, stderr, code } = await runSubprocess('node', ['-e', nodeHostWrapperSource], payload)
  return parseSubprocessResult(stdout, stderr, code)
}

// ── Python subprocess ─────────────────────────────────────────────────────────

async function executePython(
  scriptBody: string,
  request: any,
  response: any,
  envVars: Record<string, string>,
  variables: Record<string, any>,
): Promise<ScriptExecutionResult> {
  const python = getPythonBin()
  if (!python) {
    return {
      success:   false,
      logs:      [],
      error:     'python3 not found in PATH. Install Python 3 to run Python scripts in voiden-runner.',
      cancelled: false,
      exitCode:  -1,
    }
  }
  const payload = JSON.stringify({
    scriptBody,
    request:  request ?? {},
    response: response ?? null,
    envVars,
    variables,
  })
  const { stdout, stderr, code } = await runSubprocess(python, ['-c', pythonWrapperSource], payload)
  return parseSubprocessResult(stdout, stderr, code)
}

// ── Shell subprocess ──────────────────────────────────────────────────────────

async function executeShell(
  scriptBody: string,
  request: any,
  response: any,
  envVars: Record<string, string>,
  variables: Record<string, any>,
): Promise<ScriptExecutionResult> {
  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const dir = join(tmpdir(), `voiden-runner-${uid}`)
  mkdirSync(dir, { recursive: true })

  const logFile      = join(dir, 'log.tsv')
  const varFile      = join(dir, 'vars.tsv')
  const assertFile   = join(dir, 'assertions.tsv')
  const cancelFile   = join(dir, 'cancel')
  const reqFile      = join(dir, 'request.tsv')
  const respFile     = join(dir, 'response.tsv')
  const scriptFile   = join(dir, 'user.sh')
  const wrapperFile  = join(dir, 'wrapper.sh')

  writeFileSync(scriptFile, scriptBody, 'utf-8')
  for (const f of [logFile, varFile, assertFile, reqFile, respFile]) writeFileSync(f, '', 'utf-8')

  const bashScript = buildBashScript({
    request: request ?? {}, response: response ?? null,
    envVars, variables,
    logFile, varFile, assertFile, cancelFile, reqFile, respFile,
    userScriptFile: scriptFile,
  })
  writeFileSync(wrapperFile, bashScript, 'utf-8')

  return new Promise((resolve) => {
    const child = spawn('bash', [wrapperFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      cleanup()
      resolve({ success: false, logs: [], error: `Shell script timed out after ${TIMEOUT_MS}ms`, cancelled: false, exitCode: -1 })
    }, TIMEOUT_MS)

    child.on('close', (code) => {
      clearTimeout(timer)
      const logs       = readTsvLogs(logFile)
      const assertions = readTsvAssertions(assertFile)
      const modReq     = readTsvRequest(reqFile, request)
      const modResp    = readTsvResponse(respFile, response)
      const cancelled  = existsSync(cancelFile)
      cleanup()
      resolve({ success: code === 0, logs, assertions, cancelled, exitCode: code ?? 0, modifiedRequest: modReq, modifiedResponse: modResp })
    })
  })

  function cleanup() {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// ── TSV readers for shell output files ───────────────────────────────────────

function b64d(s: string): string {
  return Buffer.from(s ?? '', 'base64').toString('utf-8')
}

function readTsvLogs(file: string): ScriptLog[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(line => {
    const [b64Level, b64Msg] = line.split('\t')
    return { level: (b64d(b64Level) || 'log') as ScriptLog['level'], args: [b64d(b64Msg)] }
  })
}

function readTsvAssertions(file: string): any[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t').map(b64d)
    const [passedStr, actual, operator, expected, message] = parts
    return { passed: passedStr === 'true', actualValue: actual, operator, expectedValue: expected, message: message ?? '' }
  })
}

function readTsvRequest(file: string, original: any): any {
  if (!existsSync(file)) return original
  const result: Record<string, any> = { ...original }
  readFileSync(file, 'utf-8').split('\n').filter(Boolean).forEach(line => {
    const [b64k, b64v] = line.split('\t')
    const key = b64d(b64k)
    const val = b64d(b64v)
    if (!key) return
    if (['headers', 'queryParams', 'pathParams'].includes(key)) {
      try { result[key] = JSON.parse(val) } catch { result[key] = val }
    } else {
      result[key] = val
    }
  })
  return result
}

function readTsvResponse(file: string, original: any): any {
  if (!existsSync(file) || !original) return original
  const result: Record<string, any> = { ...original }
  readFileSync(file, 'utf-8').split('\n').filter(Boolean).forEach(line => {
    const [b64k, b64v] = line.split('\t')
    const key = b64d(b64k)
    const val = b64d(b64v)
    if (!key) return
    if (key === 'status') {
      result[key] = parseInt(val, 10) || 0
    } else if (key === 'body') {
      try { result[key] = JSON.parse(val) } catch { result[key] = val }
    } else {
      result[key] = val
    }
  })
  return result
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Execute a script headlessly — no IPC, no Electron, pure subprocess.
 *
 * @param scriptBody   The user script source
 * @param language     'javascript' | 'python' | 'shell'
 * @param request      VdRequest-shaped object (current pipeline request state)
 * @param response     VdResponse-shaped object (null for pre-request scripts)
 * @param envVars      Flat key→value env vars (from --env file)
 * @param variables    Runtime variables (from ~/.voiden/.process.env.json)
 * @param useWorker    For JS: spawn a node subprocess instead of in-process AsyncFunction
 */
export async function executeHeadlessScript(
  scriptBody: string,
  language: HeadlessScriptLanguage,
  request: any,
  response: any,
  envVars: Record<string, string> = {},
  variables: Record<string, any> = {},
  useWorker = false,
): Promise<ScriptExecutionResult> {
  if (language === 'python') return executePython(scriptBody, request, response, envVars, variables)
  if (language === 'shell')  return executeShell(scriptBody, request, response, envVars, variables)
  if (useWorker)             return executeNodeWorker(scriptBody, request, response, envVars, variables)
  return executeJs(scriptBody, request, response, envVars, variables)
}
