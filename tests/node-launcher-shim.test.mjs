import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { transform } from "esbuild";

async function loadTs(relPath) {
  const source = await readFile(new URL(relPath, import.meta.url), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "node20" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

// Stand-in for launchers such as NVM Desktop's node.exe shim, which re-runs
// node as `cmd.exe /C node <args>`. cmd.exe ends the command line at the first
// newline, so every argument is cut there before the real node sees it.
const CMD_LIKE_SHIM = `
const { spawnSync } = require('child_process');
const args = process.argv.slice(2).map((a) => a.split(/\\r?\\n/)[0]);
const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`;

function runThroughShim(shimPath, nodeArgs, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [shimPath, ...nodeArgs], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const payload = (workerSource) => ({
  workerSource,
  scriptBody: 'voiden.request.body = { test: "ok" };',
  request: {},
  response: null,
  envVars: {},
  variables: {},
});

test("wrapper passed via -e is truncated by a cmd.exe-style launcher (the bug)", async () => {
  const { nodeHostWrapperSource, workerSource } = await loadTs("../src/lib/scriptEngine.ts");
  const dir = await mkdtemp(join(tmpdir(), "voiden-shim-test-"));
  try {
    const shim = join(dir, "shim.cjs");
    await writeFile(shim, CMD_LIKE_SHIM);
    const result = await runThroughShim(shim, ["-e", nodeHostWrapperSource.trim()], payload(workerSource));
    // Node only ran `'use strict';` — exit 0, nothing on stdout.
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wrapper passed as a temp file survives a cmd.exe-style launcher", async () => {
  const { nodeHostWrapperSource, workerSource } = await loadTs("../src/lib/scriptEngine.ts");
  const { writeWrapperFile } = await loadTs("../src/lib/wrapperFile.ts");
  const dir = await mkdtemp(join(tmpdir(), "voiden-shim-test-"));
  const wrapper = await writeWrapperFile(nodeHostWrapperSource.trim(), ".cjs");
  try {
    const shim = join(dir, "shim.cjs");
    await writeFile(shim, CMD_LIKE_SHIM);
    const result = await runThroughShim(shim, [wrapper.file], payload(workerSource));
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.modifiedRequest.body, { test: "ok" });
  } finally {
    await wrapper.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeWrapperFile cleanup removes the temp file", async () => {
  const { writeWrapperFile } = await loadTs("../src/lib/wrapperFile.ts");
  const wrapper = await writeWrapperFile("// hi", ".cjs");
  assert.equal(existsSync(wrapper.file), true);
  await wrapper.cleanup();
  assert.equal(existsSync(wrapper.file), false);
  await wrapper.cleanup(); // idempotent, never throws
});

test("user scripts can still require() packages from the project cwd", async () => {
  const { nodeHostWrapperSource, workerSource } = await loadTs("../src/lib/scriptEngine.ts");
  const { writeWrapperFile } = await loadTs("../src/lib/wrapperFile.ts");
  const project = await mkdtemp(join(tmpdir(), "voiden-proj-test-"));
  const wrapper = await writeWrapperFile(nodeHostWrapperSource.trim(), ".cjs");
  try {
    await writeFile(join(project, "helper.cjs"), 'module.exports = "from-project";');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [wrapper.file], { cwd: project, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({
        ...payload(workerSource),
        scriptBody: 'voiden.request.body = { v: require(require("path").join(process.cwd(), "helper.cjs")) };',
      }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()).modifiedRequest.body, { v: "from-project" });
  } finally {
    await wrapper.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});
