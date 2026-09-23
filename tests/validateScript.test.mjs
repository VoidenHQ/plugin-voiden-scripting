import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transform } from "esbuild";

async function loadTs(relPath) {
  const source = await readFile(new URL(relPath, import.meta.url), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "node20" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const { validateScript } = await loadTs("../src/lib/validateScript.ts");

function lines(errors) {
  return errors.map((e) => e.line).sort((a, b) => a - b);
}

test("flags await inside a plain (non-async) function callback", () => {
  const body = [
    "const arr = [1, 2, 3];",
    "arr.forEach(function (x) {",
    "  await x;",
    "});",
  ].join("\n");
  const errors = validateScript(body);
  assert.deepEqual(lines(errors), [3]);
});

test("flags await inside a non-async block-bodied arrow callback", () => {
  const body = [
    "const arr = [1, 2, 3];",
    "arr.forEach((x) => {",
    "  await x;",
    "});",
  ].join("\n");
  assert.deepEqual(lines(validateScript(body)), [3]);
});

test("flags await inside a non-async concise arrow", () => {
  const body = "arr.forEach(x => await doThing(x));";
  assert.deepEqual(lines(validateScript(body)), [1]);
});

test("flags await inside a plain named function declaration", () => {
  const body = ["function helper() {", "  await doThing();", "}"].join("\n");
  assert.deepEqual(lines(validateScript(body)), [2]);
});

test("does not flag top-level await", () => {
  const body = "const x = await voiden.env.get('key');";
  assert.deepEqual(validateScript(body), []);
});

test("does not flag await inside an async function callback", () => {
  const body = [
    "const arr = [1, 2, 3];",
    "arr.forEach(async function (x) {",
    "  await x;",
    "});",
  ].join("\n");
  assert.deepEqual(validateScript(body), []);
});

test("does not flag await inside an async arrow callback", () => {
  const body = [
    "const arr = [1, 2, 3];",
    "arr.forEach(async (x) => {",
    "  await x;",
    "});",
  ].join("\n");
  assert.deepEqual(validateScript(body), []);
});

test("does not flag await inside an async concise arrow", () => {
  const body = "arr.forEach(async x => await doThing(x));";
  assert.deepEqual(validateScript(body), []);
});

test("does not flag await inside an async named function declaration", () => {
  const body = ["async function helper() {", "  await doThing();", "}"].join("\n");
  assert.deepEqual(validateScript(body), []);
});

test("does not flag await inside if/for/try blocks nested in an async function", () => {
  const body = [
    "async function helper(list) {",
    "  if (list.length) {",
    "    for (const x of list) {",
    "      try {",
    "        await doThing(x);",
    "      } catch (e) {",
    "        await logError(e);",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(validateScript(body), []);
});

test("does not flag await at the script's own top level inside if/for/try blocks", () => {
  const body = [
    "if (voiden.env.get('flag')) {",
    "  for (const x of [1, 2]) {",
    "    await doThing(x);",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(validateScript(body), []);
});

test("does not misclassify destructured params as a block boundary", () => {
  const body = [
    "arr.forEach(async ({ a, b }) => {",
    "  await doThing(a, b);",
    "});",
  ].join("\n");
  assert.deepEqual(validateScript(body), []);
});

test("still flags await when destructured params are used but the callback isn't async", () => {
  const body = [
    "arr.forEach(({ a, b }) => {",
    "  await doThing(a, b);",
    "});",
  ].join("\n");
  assert.deepEqual(lines(validateScript(body)), [2]);
});

test("ignores await mentioned inside a string or comment", () => {
  const body = [
    "// await this later",
    "const msg = 'please await response';",
    "voiden.log(msg);",
  ].join("\n");
  assert.deepEqual(validateScript(body), []);
});

test("includes a synthetic scope-chain trace for a plain function callback", () => {
  const body = [
    "const arr = [1, 2, 3];",
    "arr.forEach(function (x) {",
    "  await x;",
    "});",
  ].join("\n");
  const [error] = validateScript(body);
  assert.equal(error.line, 3);
  assert.match(error.message, /at anonymous function \(Line 2:\d+\)/);
  assert.match(error.message, /at the script's top level/);
});

test("includes the function's name in the trace when it's a named declaration", () => {
  const body = ["function helper() {", "  await doThing();", "}"].join("\n");
  const [error] = validateScript(body);
  assert.match(error.message, /at function helper \(Line 1:\d+\)/);
});

test("trace lists nested curried arrows innermost-first, naming the assigned outer one", () => {
  const body = "const f = a => b => await c(a, b);";
  const [error] = validateScript(body);
  const trace = error.message.split("\n").slice(1);
  assert.equal(trace.length, 3);
  // Inner arrow (b => ...) has no assignment target of its own — stays anonymous.
  assert.match(trace[0], /^ {4}at arrow function \(Line 1:\d+\)$/);
  // Outer arrow (a => ...) is the direct right-hand side of `const f =` — inferred name "f".
  assert.match(trace[1], /^ {4}at arrow function f \(Line 1:\d+\)$/);
  assert.match(trace[2], /^ {4}at the script's top level$/);
});

test("infers a name for an anonymous callback assigned to a variable", () => {
  const body = [
    "const handler = (x) => {",
    "  await x;",
    "};",
  ].join("\n");
  const [error] = validateScript(body);
  assert.match(error.message, /at arrow function handler \(Line 1:\d+\)/);
});

test("infers a name for an anonymous function expression assigned to a variable", () => {
  const body = [
    "const helper = function (x) {",
    "  await x;",
    "};",
  ].join("\n");
  const [error] = validateScript(body);
  assert.match(error.message, /at function helper \(Line 1:\d+\)/);
});

test("infers a name from an object property shorthand", () => {
  const body = [
    "const handlers = {",
    "  onSuccess: (res) => {",
    "    await res;",
    "  },",
    "};",
  ].join("\n");
  const [error] = validateScript(body);
  assert.match(error.message, /at arrow function onSuccess \(Line 2:\d+\)/);
});

test("does not infer a name from a compound assignment", () => {
  const body = "total += x => await f(x);";
  const [error] = validateScript(body);
  assert.match(error.message, /^ {4}at arrow function \(Line 1:\d+\)$/m);
});

test("does not infer a name from an equality comparison", () => {
  const body = "check == x => await f(x);";
  const [error] = validateScript(body);
  assert.match(error.message, /^ {4}at arrow function \(Line 1:\d+\)$/m);
});

test("infers a name through chained assignment", () => {
  const body = "a = b = x => await f(x);";
  const [error] = validateScript(body);
  assert.match(error.message, /^ {4}at arrow function b \(Line 1:\d+\)$/m);
});

test("flags each offending await across multiple bad callbacks", () => {
  const body = [
    "arr.forEach(function (x) {",
    "  await x;",
    "});",
    "other.forEach((y) => {",
    "  await y;",
    "});",
  ].join("\n");
  assert.deepEqual(lines(validateScript(body)), [2, 5]);
});
