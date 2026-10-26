import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
const root = resolve(import.meta.dirname, "..");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(resolve(directory, entry.name))
      : entry.name.endsWith(".ts")
        ? [resolve(directory, entry.name)]
        : [],
  );
}
export function simBuildId(): string {
  // 서버 묶음은 소스 트리 없이 돈다 — 빌드 때 굳힌 값이 있으면 그것이다 (build-server.ts)
  const baked = process.env.GAFFER_SIM_BUILD_ID;
  if (baked) return baked;
  const digest = createHash("sha256");
  for (const path of ["packages/sim/src", "packages/domain/src", "packages/engine/src/match"]
    .flatMap((p) => files(resolve(root, p)))
    .sort()) {
    digest.update(relative(root, path));
    digest.update("\0");
    digest.update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
  }
  return digest.digest("hex");
}
