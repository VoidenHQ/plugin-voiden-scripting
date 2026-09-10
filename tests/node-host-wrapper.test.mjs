import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transform } from "esbuild";

async function loadScriptEngineSources() {
  const source = await readFile(new URL("../src/lib/scriptEngine.ts", import.meta.url), "utf8");
  const { code } = await transform(source, {
    format: "esm",
    loader: "ts",
    target: "node20",
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  return import(moduleUrl);
}

function runNodeWrapper(nodeHostWrapperSource, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", nodeHostWrapperSource], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test("node worker flushes large JSON results before exiting", async () => {
  const { nodeHostWrapperSource, workerSource } = await loadScriptEngineSources();
  const body = "A".repeat(4 * 1024 * 1024);
  const result = await runNodeWrapper(nodeHostWrapperSource, {
    workerSource,
    scriptBody: "voiden.request.body = voiden.request.body;",
    request: { body },
    response: null,
    envVars: {},
    variables: {},
  });

  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.success, true);
  assert.equal(parsed.modifiedRequest.body, body);
});

test("node worker preserves the failure exit code after flushing", async () => {
  const { nodeHostWrapperSource, workerSource } = await loadScriptEngineSources();
  const result = await runNodeWrapper(nodeHostWrapperSource, {
    workerSource,
    scriptBody: 'throw new Error("boom");',
    request: {},
    response: null,
    envVars: {},
    variables: {},
  });

  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.success, false);
  assert.match(parsed.error, /boom/);
});
