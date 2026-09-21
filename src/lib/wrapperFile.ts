/**
 * Runs a wrapper script from a temp file instead of `node -e <source>`.
 *
 * Passing a multi-line script on the command line breaks whenever `node` is
 * not a real binary but a launcher that re-executes it through `cmd.exe /C`
 * (e.g. NVM Desktop's `%USERPROFILE%\.nvmd\bin\node.exe` shim): cmd.exe ends
 * the command line at the first newline, so Node only ever sees the first
 * line of the wrapper, runs it, and exits 0 without printing anything — which
 * surfaces as "Failed to parse Node.js output:" with an empty body.
 * A file path is a single short line, so it survives any launcher.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface WrapperFile {
  file: string;
  /** Removes the temp file and its directory. Never throws. */
  cleanup: () => Promise<void>;
}

export async function writeWrapperFile(source: string, ext: string): Promise<WrapperFile> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voiden-script-"));
  const file = path.join(dir, `wrapper${ext}`);
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    await fs.writeFile(file, source, "utf-8");
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { file, cleanup };
}
