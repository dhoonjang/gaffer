import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { dataDir } from "./catalog/paths";

/**
 * Advisory process-shared mutex for the entire read → change → save transaction.
 * Each attempt owns a unique record. Bakery ordering avoids compare-and-delete on a
 * reusable path: reclaiming a dead attempt can never unlink its successor.
 * Live/remote owners never expire; a time-based takeover needs fencing at the save boundary.
 */
interface LockRecord {
  pid: number;
  host: string;
  token: string;
  /** Zero means this attempt is choosing its ticket. */
  ticket: number;
}

const RETRY_MS = 25;
export interface SaveLockHandle {
  release(): void;
}

export function saveLockPath(id: string): string {
  return path.join(dataDir(), `${id}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readRecord(file: string): LockRecord | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const { pid, host, token, ticket } = raw as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof host !== "string" || typeof token !== "string") return null;
    if (typeof ticket !== "number" || !Number.isSafeInteger(ticket) || ticket < 0) return null;
    return { pid, host, token, ticket };
  } catch {
    return null;
  }
}

/** Publish only complete records, including the choosing marker. */
function publish(file: string, record: LockRecord): void {
  const temporary = `${file}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function contenders(dir: string): Array<LockRecord | null> {
  const records: Array<LockRecord | null> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const record = readRecord(file);
    if (record?.host === hostname() && !pidAlive(record.pid)) {
      // This filename belongs to one attempt for its entire lifetime, never a later holder.
      rmSync(file, { force: true });
      continue;
    }
    if (record === null) {
      // A released contender may disappear between listing and reading. A corrupt existing
      // record blocks safely; it is never treated as proof that its owner died.
      try {
        readFileSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
    }
    records.push(record);
  }
  return records;
}

/** Wait at most waitMs; timeout withdraws only this attempt. */
export async function acquireSaveLock(id: string, waitMs: number): Promise<SaveLockHandle | null> {
  const dir = saveLockPath(id);
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(16).toString("hex");
  const file = path.join(dir, `${token}.json`);
  const record: LockRecord = { pid: process.pid, host: hostname(), token, ticket: 0 };
  const deadline = Date.now() + Math.max(0, waitMs);
  let retained = false;
  try {
    publish(file, record);
    record.ticket = Math.max(0, ...contenders(dir).map((r) => r?.ticket ?? 0)) + 1;
    if (!Number.isSafeInteger(record.ticket)) throw new Error("Save lock ticket exhausted");
    publish(file, record);
    for (;;) {
      const blocked = contenders(dir).some(
        (other) =>
          other === null ||
          (other.token !== token &&
            (other.ticket === 0 ||
              other.ticket < record.ticket ||
              (other.ticket === record.ticket && other.token < token))),
      );
      if (!blocked) {
        retained = true;
        let released = false;
        return {
          release() {
            if (released) return;
            released = true;
            rmSync(file, { force: true });
          },
        };
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(RETRY_MS, Math.max(1, deadline - Date.now()))),
      );
    }
  } finally {
    if (!retained) rmSync(file, { force: true });
  }
}
