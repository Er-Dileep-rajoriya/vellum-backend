import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";

export function resolveEnvFileCandidates(baseDir = process.cwd()): string[] {
  const candidates = [
    path.join(baseDir, ".env"),
    path.join(baseDir, "backend", ".env"),
    path.join(baseDir, "..", "backend", ".env"),
    path.join(baseDir, "..", ".env"),
  ];

  return [...new Set(candidates)];
}

export function loadAppEnv(baseDir = process.cwd()): void {
  const candidate = resolveEnvFileCandidates(baseDir).find((file) => existsSync(file));
  if (candidate === undefined) return;

  config({ path: candidate, override: false });
}
