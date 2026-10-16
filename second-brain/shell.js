/**
 * Run one command on this Mac and collect its output.
 */

import { spawn } from "node:child_process";

export function runCommand(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `${bin} failed`).slice(0, 500)));
    });
  });
}
