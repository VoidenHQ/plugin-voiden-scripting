/**
 * Voiden Scripting — Main-Process Extension
 *
 * Registers three script-runner IPC handlers inside the plugin itself,
 * exposed as plugin IPC so any other plugin can invoke them:
 *
 *   ext:voiden-scripting:script:executeNode   — Node.js (worker_threads)
 *   ext:voiden-scripting:script:executePython — Python subprocess
 *   ext:voiden-scripting:script:executeShell  — Bash subprocess (macOS/Linux)
 *
 * All runners share the same result shape and persist modified variables to
 * .voiden/.process.env.json in the active project directory.
 */

import type { ElectronExtensionContext, ElectronPlugin } from "@voiden/sdk/electron";
import { spawn, execFile } from "child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── Constants ────────────────────────────────────────────────────────────────

const SCRIPT_TIMEOUT_MS = 10_000;

/**
 * Fallback extended PATH so Electron GUI apps on macOS/Linux have a chance of
 * finding Homebrew / nvm / volta / fnm binaries even when the login-shell
 * resolution below (the primary strategy) is unavailable or fails.
 */
const EXTENDED_PATH = [
  process.env.PATH || "",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  path.join(process.env.HOME || "~", ".volta/bin"),
  path.join(process.env.HOME || "~", ".fnm/current/bin"),
  path.join(process.env.HOME || "~", ".local/bin"),
  path.join(process.env.HOME || "~", ".pyenv/shims"),
].join(path.delimiter);

const COMMON_NODE_PATHS =
  process.platform === "win32"
    ? [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Program Files (x86)\\nodejs\\node.exe",
        path.join(process.env.LOCALAPPDATA || "", "Volta\\bin\\node.exe"),
        path.join(process.env.USERPROFILE || "", "scoop\\apps\\nodejs\\current\\node.exe"),
        path.join(process.env.USERPROFILE || "", "scoop\\shims\\node.exe"),
      ]
    : [
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
        path.join(process.env.HOME || "~", ".volta/bin/node"),
        path.join(process.env.HOME || "~", ".fnm/current/bin/node"),
        path.join(process.env.HOME || "~", ".local/bin/node"),
      ];

const COMMON_PYTHON_PATHS =
  process.platform === "win32"
    ? [
        path.join(process.env.LOCALAPPDATA || "", "Programs\\Python\\Python312\\python.exe"),
        path.join(process.env.LOCALAPPDATA || "", "Programs\\Python\\Python311\\python.exe"),
        path.join(process.env.USERPROFILE || "", "scoop\\shims\\python.exe"),
      ]
    : [
        "/usr/local/bin/python3",
        "/opt/homebrew/bin/python3",
        "/usr/bin/python3",
        path.join(process.env.HOME || "~", ".pyenv/shims/python3"),
      ];

// ─── Login-shell PATH resolution ───────────────────────────────────────────────
//
// The #1 real-world cause of "Node.js not found" despite `node -v` working
// fine in a terminal: Electron apps launched from Finder/Dock/Taskbar inherit
// a minimal PATH (roughly /usr/bin:/bin:/usr/sbin:/sbin) that never sources
// ~/.zshrc, ~/.bash_profile, nvm.sh, etc. — so nvm/asdf/mise/pyenv-managed
// installs are invisible no matter how many hardcoded fallback paths we guess.
// Spawning the user's own $SHELL in login+interactive mode sources those same
// rc files and gives us their *real* PATH, not a guess. macOS/Linux only —
// Windows PATH is set via environment variables the OS already inherits
// correctly, so this specific failure mode doesn't apply there.
let cachedShellPath: string | null | undefined = undefined; // undefined = not yet attempted this session

async function resolveLoginShellPath(): Promise<string | null> {
  if (process.platform === "win32") return null;
  if (cachedShellPath !== undefined) return cachedShellPath;

  const shell = process.env.SHELL || "/bin/zsh";
  const marker = "__VOIDEN_PATH__";
  // Note: must be "${PATH}" (braced), not a bare "$PATH" — a shell parses
  // $PATH immediately followed by more identifier characters (our trailing
  // marker) as one longer, undefined variable name, silently expanding the
  // whole thing to nothing. Braces close the reference explicitly. Built via
  // concatenation, not a template literal, so JS doesn't itself try to
  // interpolate the literal "${PATH}" meant for the shell.
  const shellCmd = "echo " + marker + "${PATH}" + marker;
  try {
    const result = await new Promise<string | null>((resolve) => {
      execFile(
        shell,
        ["-ilc", shellCmd],
        { timeout: 5000 },
        (error, stdout) => {
          if (error) { resolve(null); return; }
          const match = new RegExp(`${marker}(.*)${marker}`, "s").exec(stdout);
          resolve(match ? match[1].trim() : null);
        },
      );
    });
    cachedShellPath = result;
    return result;
  } catch {
    cachedShellPath = null;
    return null;
  }
}

/**
 * nvm does NOT create a `~/.nvm/current` symlink by default (that was an
 * incorrect assumption in earlier versions of this detector) — it works
 * purely by having nvm.sh mutate PATH in the user's shell rc file, which
 * resolveLoginShellPath() above already captures. This is a last-resort
 * fallback for when shell resolution itself fails: read nvm's own default
 * alias, or fall back to the highest installed version directory.
 */
async function resolveNvmNodePath(): Promise<string | null> {
  if (process.platform === "win32") return null;
  const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || "~", ".nvm");
  const versionsDir = path.join(nvmDir, "versions", "node");

  let targetVersion: string | null = null;
  try {
    const alias = (await fs.readFile(path.join(nvmDir, "alias", "default"), "utf-8")).trim();
    if (/^v?\d+(\.\d+)*$/.test(alias)) targetVersion = alias.startsWith("v") ? alias : `v${alias}`;
  } catch { /* no alias file, or it points at a non-numeric alias like lts/* — fall through */ }

  try {
    const entries = await fs.readdir(versionsDir);
    const versionDirs = entries.filter((e) => /^v\d+\.\d+\.\d+$/.test(e));
    if (versionDirs.length === 0) return null;

    const pick = targetVersion && versionDirs.includes(targetVersion)
      ? targetVersion
      // Highest installed version wins — localeCompare's numeric mode sorts
      // "v18.9.0" before "v18.10.0" correctly (unlike a plain string sort).
      : versionDirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)!;

    const candidate = path.join(versionsDir, pick, "bin", "node");
    await fs.access(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

// ─── Binary detection (cached, revalidated) ────────────────────────────────────

let cachedNodePath: string | null = null;
let cachedPythonPath: string | null = null;

/** Confirms a previously-cached path is still there and executable before trusting it again. */
async function stillValid(cached: string | null): Promise<boolean> {
  if (!cached) return false;
  try { await fs.access(cached, fsConstants.X_OK); return true; } catch { return false; }
}

async function whichWithPath(whichCmd: string, bin: string, searchPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      whichCmd,
      [bin],
      { timeout: 3000, env: { ...process.env, PATH: searchPath } },
      (error, stdout) => resolve(error || !stdout.trim() ? null : stdout.trim().split(/\r?\n/)[0]),
    );
  });
}

/** Best-known PATH for the spawned script's own env — not just detection. */
async function runtimeSearchPath(): Promise<string> {
  const shellPath = await resolveLoginShellPath();
  return shellPath ? `${shellPath}${path.delimiter}${EXTENDED_PATH}` : EXTENDED_PATH;
}

async function detectNodePath(): Promise<string | null> {
  if (await stillValid(cachedNodePath)) return cachedNodePath;
  cachedNodePath = null;

  const whichCmd = process.platform === "win32" ? "where" : "which";

  // 1. The user's real login-shell PATH — sources nvm/asdf/mise/pyenv rc files, etc.
  const shellPath = await resolveLoginShellPath();
  if (shellPath) {
    const result = await whichWithPath(whichCmd, "node", shellPath);
    if (result) { cachedNodePath = result; return result; }
  }

  // 2. Extended-guess PATH (Homebrew, volta, fnm, common dirs)
  const result = await whichWithPath(whichCmd, "node", EXTENDED_PATH);
  if (result) { cachedNodePath = result; return result; }

  // 3. nvm's actual on-disk layout (no `current` symlink assumed)
  const nvmPath = await resolveNvmNodePath();
  if (nvmPath) { cachedNodePath = nvmPath; return nvmPath; }

  // 4. Hardcoded common install locations, as a last resort
  for (const candidate of COMMON_NODE_PATHS) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      cachedNodePath = candidate;
      return candidate;
    } catch { continue; }
  }
  return null;
}

async function detectPythonPath(): Promise<string | null> {
  if (await stillValid(cachedPythonPath)) return cachedPythonPath;
  cachedPythonPath = null;

  const whichCmd = process.platform === "win32" ? "where" : "which";

  const shellPath = await resolveLoginShellPath();
  for (const searchPath of [shellPath, EXTENDED_PATH].filter((p): p is string => !!p)) {
    for (const candidate of ["python3", "python"]) {
      const result = await whichWithPath(whichCmd, candidate, searchPath);
      if (result) { cachedPythonPath = result; return result; }
    }
  }

  for (const candidate of COMMON_PYTHON_PATHS) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      cachedPythonPath = candidate;
      return candidate;
    } catch { continue; }
  }
  return null;
}

// ─── Variable persistence ─────────────────────────────────────────────────────

async function loadProjectVariables(projectPath: string | null | undefined): Promise<Record<string, any>> {
  if (!projectPath) return {};
  try {
    const content = await fs.readFile(
      path.join(projectPath, ".voiden", ".process.env.json"),
      "utf-8",
    );
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

async function persistProjectVariables(
  projectPath: string | null | undefined,
  next: Record<string, any>,
): Promise<void> {
  if (!projectPath) return;
  try {
    const dir = path.join(projectPath, ".voiden");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, ".process.env.json"),
      JSON.stringify(next, null, 2),
      "utf-8",
    );
  } catch { /* best-effort */ }
}

// ─── Shell helpers ────────────────────────────────────────────────────────────

function readTsvB64(file: string): string[][] {
  try {
    return fsSync
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) =>
        l.split("\t").map((col) => {
          try { return Buffer.from(col.trim(), "base64").toString("utf-8"); }
          catch { return col.trim(); }
        }),
      );
  } catch { return []; }
}

function safeJson(val: string, fallback: any): any {
  try { return JSON.parse(val); } catch { return fallback; }
}

// ─── Shared result types ──────────────────────────────────────────────────────

interface ScriptResult {
  success: boolean;
  logs: Array<{ level: string; args: any[] }>;
  error?: string;
  cancelled: boolean;
  exitCode?: number;
  assertions?: any[];
  modifiedRequest?: any;
  modifiedResponse?: any;
  modifiedVariables?: Record<string, any>;
}

// ─── Plugin factory ───────────────────────────────────────────────────────────

export default function createVoidenScriptingMainPlugin(
  ctx: ElectronExtensionContext,
): ElectronPlugin {
  return {
    async onload() {

      // ── Node.js script runner ─────────────────────────────────────────────
      // Exposed as: ext:voiden-scripting:script:executeNode
      ctx.ipc.handle(
        "script:executeNode",
        async (event: any, payload: any): Promise<ScriptResult> => {
          const nodePath = await detectNodePath();
          if (!nodePath) {
            return {
              success: false, logs: [],
              error:
                "Node.js not found. Checked your login shell's PATH, Homebrew/volta/fnm locations, " +
                "nvm's installed versions, and common install paths — none had a working `node`. " +
                "If Node is installed somewhere else, add it to your shell's PATH (the same PATH " +
                "`node -v` in a terminal resolves) and restart Voiden.",
              cancelled: false, exitCode: -1,
            };
          }

          const nodeHostWrapper = payload.nodeHostWrapper?.trim();
          if (!nodeHostWrapper) {
            return {
              success: false, logs: [],
              error: "Node host wrapper source missing from payload.",
              cancelled: false, exitCode: -1,
            };
          }

          const projectPath = await ctx.project.getActive(event);
          const baseVariables = await loadProjectVariables(projectPath);
          const mergedPayload = {
            ...payload,
            variables: { ...baseVariables, ...(payload.variables || {}) },
          };
          const searchPath = await runtimeSearchPath();

          return new Promise<ScriptResult>((resolve) => {
            const child = spawn(nodePath, ["-e", nodeHostWrapper], {
              timeout: SCRIPT_TIMEOUT_MS,
              stdio: ["pipe", "pipe", "pipe"],
              cwd: projectPath || undefined,
              env: { ...process.env, PATH: searchPath },
            });

            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
            child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

            child.on("close", async (code) => {
              const exitCode = code ?? -1;
              if (code !== 0 && !stdout) {
                resolve({
                  success: false, logs: [],
                  error: stderr || `Node.js exited with code ${code}`,
                  cancelled: false, exitCode,
                });
                return;
              }
              try {
                const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
                const result = JSON.parse(lines[lines.length - 1] || stdout) as ScriptResult;
                result.exitCode = result.success === false && exitCode === 0 ? 1 : exitCode;
                if (result.modifiedVariables && Object.keys(result.modifiedVariables).length > 0) {
                  const current = await loadProjectVariables(projectPath);
                  await persistProjectVariables(projectPath, { ...current, ...result.modifiedVariables });
                }
                resolve(result);
              } catch {
                resolve({
                  success: false, logs: [],
                  error: `Failed to parse Node.js output: ${stdout.slice(0, 500)}`,
                  cancelled: false, exitCode,
                });
              }
            });

            child.on("error", (err) => {
              resolve({
                success: false, logs: [],
                error: `Failed to spawn Node.js: ${err.message}`,
                cancelled: false, exitCode: -1,
              });
            });

            child.stdin.write(JSON.stringify(mergedPayload));
            child.stdin.end();
          });
        },
      );

      // ── Python script runner ──────────────────────────────────────────────
      // Exposed as: ext:voiden-scripting:script:executePython
      ctx.ipc.handle(
        "script:executePython",
        async (event: any, payload: any): Promise<ScriptResult> => {
          const pythonPath = await detectPythonPath();
          if (!pythonPath) {
            return {
              success: false, logs: [],
              error:
                "Python not found. Checked your login shell's PATH, Homebrew/pyenv locations, " +
                "and common install paths for `python3`/`python` — none had a working interpreter. " +
                "If Python is installed somewhere else, add it to your shell's PATH (the same PATH " +
                "`python3 --version` in a terminal resolves) and restart Voiden.",
              cancelled: false, exitCode: -1,
            };
          }

          const pythonWrapper = payload.pythonWrapper?.trim();
          if (!pythonWrapper) {
            return {
              success: false, logs: [],
              error: "Python wrapper source missing from payload.",
              cancelled: false, exitCode: -1,
            };
          }

          const projectPath = await ctx.project.getActive(event);
          const baseVariables = await loadProjectVariables(projectPath);
          const mergedPayload = {
            ...payload,
            variables: { ...baseVariables, ...(payload.variables || {}) },
          };
          const searchPath = await runtimeSearchPath();

          return new Promise<ScriptResult>((resolve) => {
            const child = spawn(pythonPath, ["-c", pythonWrapper], {
              timeout: SCRIPT_TIMEOUT_MS,
              stdio: ["pipe", "pipe", "pipe"],
              cwd: projectPath || undefined,
              env: { ...process.env, PATH: searchPath },
            });

            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
            child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

            child.on("close", async (code) => {
              const exitCode = code ?? -1;
              if (code !== 0 && !stdout) {
                resolve({
                  success: false, logs: [],
                  error: stderr || `Python exited with code ${code}`,
                  cancelled: false, exitCode,
                });
                return;
              }
              try {
                const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
                const result = JSON.parse(lines[lines.length - 1] || stdout) as ScriptResult;
                result.exitCode = result.success === false && exitCode === 0 ? 1 : exitCode;
                if (result.modifiedVariables && Object.keys(result.modifiedVariables).length > 0) {
                  const current = await loadProjectVariables(projectPath);
                  await persistProjectVariables(projectPath, { ...current, ...result.modifiedVariables });
                }
                resolve(result);
              } catch {
                resolve({
                  success: false, logs: [],
                  error: `Failed to parse Python output: ${stdout.slice(0, 500)}`,
                  cancelled: false, exitCode,
                });
              }
            });

            child.on("error", (err) => {
              resolve({
                success: false, logs: [],
                error: `Failed to spawn Python: ${err.message}`,
                cancelled: false, exitCode: -1,
              });
            });

            child.stdin.write(JSON.stringify(mergedPayload));
            child.stdin.end();
          });
        },
      );

      // ── Shell script runner ───────────────────────────────────────────────
      // Exposed as: ext:voiden-scripting:script:executeShell
      // Directly spawns bash — no intermediate Node.js subprocess.
      // Receives a pre-built bash script from the renderer (buildBashScript).
      // Placeholder paths (__VD_LOG__, etc.) are replaced here with real tmpDir paths.
      ctx.ipc.handle(
        "script:executeShell",
        async (event: any, payload: any): Promise<ScriptResult> => {
          if (process.platform === "win32") {
            return {
              success: false, logs: [],
              error: "Shell scripting is not supported on Windows. Use JavaScript or Python.",
              cancelled: false, exitCode: -1,
            };
          }

          let bashScript: string = payload.bashScript || "";
          const scriptBody: string = payload.scriptBody || "";
          if (!bashScript.trim()) {
            return {
              success: false, logs: [],
              error: "No bash script provided.",
              cancelled: false, exitCode: -1,
            };
          }

          const projectPath = await ctx.project.getActive(event);

          // Create isolated temp directory for this execution
          const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "voiden-shell-"));
          const scriptFile     = path.join(tmpDir, "script.sh");
          const userScriptFile = path.join(tmpDir, "user-script.sh");
          const logFile        = path.join(tmpDir, "logs.tsv");
          const varFile        = path.join(tmpDir, "vars.tsv");
          const assertFile     = path.join(tmpDir, "asserts.tsv");
          const cancelFile     = path.join(tmpDir, "cancel");
          const reqFile        = path.join(tmpDir, "request.tsv");
          const respFile       = path.join(tmpDir, "response.tsv");

          // Replace placeholder paths embedded by buildBashScript() in scriptEngine.ts
          bashScript = bashScript
            .split("__VD_LOG__").join(logFile)
            .split("__VD_VAR__").join(varFile)
            .split("__VD_ASSERT__").join(assertFile)
            .split("__VD_CANCEL__").join(cancelFile)
            .split("__VD_REQUEST__").join(reqFile)
            .split("__VD_RESPONSE__").join(respFile)
            .split("__VD_USERSCRIPT__").join(userScriptFile);

          // Write user script to its own file so bash syntax errors don't abort the wrapper
          fsSync.writeFileSync(userScriptFile, scriptBody, { mode: 0o644 });
          fsSync.writeFileSync(scriptFile, bashScript, { mode: 0o755 });
          fsSync.writeFileSync(logFile, "");
          fsSync.writeFileSync(varFile, "");
          fsSync.writeFileSync(assertFile, "");
          fsSync.writeFileSync(reqFile, "");
          fsSync.writeFileSync(respFile, "");

          const cleanup = () => {
            try { fsSync.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
          };

          return new Promise<ScriptResult>((resolve) => {
            let stderr = "";
            const killTimer = setTimeout(() => { child.kill("SIGKILL"); }, SCRIPT_TIMEOUT_MS);

            const child = spawn("bash", [scriptFile], {
              stdio: ["ignore", "ignore", "pipe"],
              cwd: projectPath || undefined,
              env: { ...process.env, PATH: EXTENDED_PATH },
            });
            child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

            child.on("close", async (code) => {
              clearTimeout(killTimer);

              const logRows    = readTsvB64(logFile);
              const varRows    = readTsvB64(varFile);
              const assertRows = readTsvB64(assertFile);
              const reqRows    = readTsvB64(reqFile);
              const respRows   = readTsvB64(respFile);
              const cancelled  = fsSync.existsSync(cancelFile);

              const logs: Array<{ level: string; args: any[] }> =
                logRows.map((row) => ({ level: row[0] || "log", args: [row[1] || ""] }));
              if (stderr.trim()) logs.push({ level: "error", args: [`[stderr] ${stderr.trim()}`] });

              const assertions = assertRows.map((row) => ({
                passed: row[0] === "true",
                message: row[4] || "",
                condition: `${row[1] || ""} ${row[2] || ""} ${row[3] || ""}`,
                actualValue: row[1] || "",
                operator: row[2] || "",
                expectedValue: row[3] || "",
              }));

              const modifiedVariables: Record<string, any> = {};
              varRows.forEach((row) => { if (row[0]) modifiedVariables[row[0]] = row[1] || ""; });

              const reqMap: Record<string, string> = {};
              reqRows.forEach((row) => { if (row[0]) reqMap[row[0]] = row[1] || ""; });
              const modifiedRequest = Object.keys(reqMap).length > 0
                ? {
                    url: reqMap["url"] || "",
                    method: reqMap["method"] || "GET",
                    body: reqMap["body"] ?? undefined,
                    headers: safeJson(reqMap["headers"], []),
                    queryParams: safeJson(reqMap["queryParams"], []),
                    pathParams: safeJson(reqMap["pathParams"], []),
                  }
                : undefined;

              const respMap: Record<string, string> = {};
              respRows.forEach((row) => { if (row[0]) respMap[row[0]] = row[1] || ""; });
              const modifiedResponse = Object.keys(respMap).length > 0
                ? {
                    status: respMap["status"] !== undefined ? (Number(respMap["status"]) || respMap["status"]) : undefined,
                    statusText: respMap["statusText"] ?? undefined,
                    body: respMap["body"] !== undefined ? safeJson(respMap["body"], respMap["body"]) : undefined,
                  }
                : undefined;

              if (modifiedVariables && Object.keys(modifiedVariables).length > 0) {
                const current = await loadProjectVariables(projectPath);
                await persistProjectVariables(projectPath, { ...current, ...modifiedVariables });
              }

              cleanup();
              resolve({
                success: code === 0,
                logs,
                assertions,
                cancelled,
                exitCode: code ?? -1,
                modifiedRequest,
                modifiedResponse,
                modifiedVariables,
              });
            });

            child.on("error", (err) => {
              clearTimeout(killTimer);
              cleanup();
              resolve({
                success: false, logs: [],
                error: `Failed to spawn bash: ${err.message}`,
                cancelled: false, exitCode: -1,
              });
            });
          });
        },
      );
    },

    async onunload() {
      ctx.ipc.removeHandler("script:executeNode");
      ctx.ipc.removeHandler("script:executePython");
      ctx.ipc.removeHandler("script:executeShell");
    },
  };
}
