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

import { spawn, execFile } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, constants as fsConstants } from 'fs'
import { access } from 'fs/promises'
import { join, delimiter } from 'path'
import { tmpdir, homedir } from 'os'
import { workerSource, nodeHostWrapperSource, pythonWrapperSource, buildBashScript } from './scriptEngine.js'
import type { ScriptExecutionResult, ScriptLog } from './types.js'

export type HeadlessScriptLanguage = 'javascript' | 'python' | 'shell'

const TIMEOUT_MS = 10_000

// ── PATH resolution ────────────────────────────────────────────────────────────
//
// This engine runs inside `voiden mcp-stdio`/`voiden-runner mcp serve` —
// itself a subprocess spawned by whatever MCP client (Claude Code, Codex,
// etc.) configured it, over a plain `command`/`args` entry. That client is
// frequently a GUI app launched from a desktop icon, which — same as the
// Electron main-process engine's own detectNodePath()/detectPythonPath()
// (see main-process.ts) — inherits a minimal PATH (roughly
// /usr/bin:/bin:/usr/sbin:/sbin) that never sources ~/.zshrc,
// ~/.bash_profile, nvm.sh, etc. A `node`/`python3`/`bash` genuinely
// installed via nvm/asdf/mise/pyenv/Homebrew is invisible to a bare
// `spawn('node', ...)` in that environment even though it works fine from
// any terminal — this was already fixed for the Electron app's own script
// execution, but never ported here, so the exact same class of failure was
// still open on this, the only path `voiden-runner`/mcp-stdio actually use.
const EXTENDED_PATH = [
  process.env.PATH || '',
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  join(process.env.HOME || '~', '.volta/bin'),
  join(process.env.HOME || '~', '.fnm/current/bin'),
  join(process.env.HOME || '~', '.local/bin'),
  join(process.env.HOME || '~', '.pyenv/shims'),
].join(delimiter)

let cachedShellPath: string | null | undefined = undefined // undefined = not yet attempted this session

/** Spawns the user's own $SHELL in login+interactive mode, which sources the
 *  same rc files a terminal's `node -v` would — macOS/Linux only, Windows
 *  PATH doesn't have this failure mode. */
async function resolveLoginShellPath(): Promise<string | null> {
  if (process.platform === 'win32') return null
  if (cachedShellPath !== undefined) return cachedShellPath

  const shell = process.env.SHELL || '/bin/zsh'
  const marker = '__VOIDEN_PATH__'
  // Must be "${PATH}" (braced) — a bare "$PATH" immediately followed by the
  // marker's own leading characters parses as one longer, undefined variable
  // name, silently expanding to nothing.
  const shellCmd = 'echo ' + marker + '${PATH}' + marker
  const result = await new Promise<string | null>((resolve) => {
    execFile(shell, ['-ilc', shellCmd], { timeout: 5000 }, (error, stdout) => {
      if (error) { resolve(null); return }
      const match = new RegExp(`${marker}(.*)${marker}`, 's').exec(stdout)
      resolve(match ? match[1].trim() : null)
    })
  })
  cachedShellPath = result
  return result
}

async function resolveSearchPath(): Promise<string> {
  const shellPath = await resolveLoginShellPath()
  return shellPath ? `${shellPath}${delimiter}${EXTENDED_PATH}` : EXTENDED_PATH
}

function whichWithPath(bin: string, searchPath: string): Promise<string | null> {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  return new Promise((resolve) => {
    execFile(whichCmd, [bin], { timeout: 3000, env: { ...process.env, PATH: searchPath } }, (error, stdout) => {
      resolve(error || !stdout.trim() ? null : stdout.trim().split(/\r?\n/)[0])
    })
  })
}

// ── Runtime availability checks ───────────────────────────────────────────────

let _pythonBin: string | null | undefined
let _resolvedSearchPath: string | undefined

/** Best-known PATH for spawned subprocesses — resolved once per process, not
 *  just for detection but for the actual script run too. */
async function getResolvedSearchPath(): Promise<string> {
  if (_resolvedSearchPath === undefined) _resolvedSearchPath = await resolveSearchPath()
  return _resolvedSearchPath
}

/** Finds the python3/python binary, caches the result. Returns null if not found. */
export async function getPythonBin(): Promise<string | null> {
  if (_pythonBin !== undefined) return _pythonBin
  const searchPath = await getResolvedSearchPath()
  for (const candidate of ['python3', 'python']) {
    const result = await whichWithPath(candidate, searchPath)
    if (result) { _pythonBin = result; return result }
  }
  for (const candidate of process.platform === 'win32' ? [] : ['/usr/local/bin/python3', '/opt/homebrew/bin/python3', '/usr/bin/python3']) {
    try { await access(candidate, fsConstants.X_OK); _pythonBin = candidate; return candidate } catch { continue }
  }
  _pythonBin = null
  return null
}

/** Check Node.js worker_threads (always available in Node ≥ 12) — this is
 *  the CURRENT process's own Node runtime, not whether a `node` binary is
 *  reachable on PATH for a subprocess (see getResolvedSearchPath for that). */
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
  searchPath?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: searchPath ? { ...process.env, PATH: searchPath } : process.env,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ stdout: '', stderr: `Timed out after ${TIMEOUT_MS}ms`, code: -1 })
    }, TIMEOUT_MS)

    const settle = (result: { stdout: string; stderr: string; code: number | null }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    // Without this, a command that can't even be spawned (ENOENT — the
    // binary genuinely isn't reachable via the given PATH) never fires
    // 'close' at all, so the promise silently hung until the 10s timeout
    // and reported a misleading "Timed out" instead of the real cause.
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle({ stdout: '', stderr: `Failed to run "${command}": ${err.message}`, code: -1 })
    })
    child.on('close', (code) => settle({ stdout, stderr, code }))

    try {
      child.stdin.write(stdinData, 'utf-8')
      child.stdin.end()
    } catch { /* child may have already failed to spawn — 'error' above handles it */ }
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
  const searchPath = await getResolvedSearchPath()
  const { stdout, stderr, code } = await runSubprocess('node', ['-e', nodeHostWrapperSource], payload, searchPath)
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
  const python = await getPythonBin()
  if (!python) {
    return {
      success:   false,
      logs:      [],
      error:     'python3 not found. Checked your login shell\'s PATH (sourcing .zshrc/.bash_profile/etc.), Homebrew, volta/fnm/pyenv, and common install locations — install Python 3 or make sure it\'s reachable from a terminal.',
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
  const searchPath = await getResolvedSearchPath()
  const { stdout, stderr, code } = await runSubprocess(python, ['-c', pythonWrapperSource], payload, searchPath)
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

  const searchPath = await getResolvedSearchPath()
  return new Promise((resolve) => {
    const child = spawn('bash', [wrapperFile], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: searchPath } })
    let settled = false
    const settle = (result: ScriptExecutionResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ success: false, logs: [], error: `Shell script timed out after ${TIMEOUT_MS}ms`, cancelled: false, exitCode: -1 })
    }, TIMEOUT_MS)

    // Same "would otherwise hang until timeout" gap as runSubprocess — bash
    // is nearly universal, but a search PATH so minimal even that lookup
    // fails should report the real cause, not "timed out".
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle({ success: false, logs: [], error: `Failed to run bash: ${err.message}`, cancelled: false, exitCode: -1 })
    })

    child.on('close', (code) => {
      const logs       = readTsvLogs(logFile)
      const assertions = readTsvAssertions(assertFile)
      const modReq     = readTsvRequest(reqFile, request)
      const modResp    = readTsvResponse(respFile, response)
      const cancelled  = existsSync(cancelFile)
      settle({ success: code === 0, logs, assertions, cancelled, exitCode: code ?? 0, modifiedRequest: modReq, modifiedResponse: modResp })
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
