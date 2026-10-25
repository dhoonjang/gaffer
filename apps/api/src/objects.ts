import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { Config } from "./config";
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export interface ObjectStore {
  list(prefix: string): Promise<string[]>;
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}
export function objectStore(c: Config): ObjectStore {
  if (c.GAFFER_MODE === "local") {
    const root = resolve(c.GAFFER_DATA_DIR, "objects");
    const path = (key: string) => {
      if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes(".."))
        throw new Error("Invalid object key");
      return resolve(root, key);
    };
    return {
      list: async (prefix) => {
        const base = path(prefix);
        const walk = async (dir: string): Promise<string[]> => {
          try {
            return (
              await Promise.all(
                (await readdir(dir, { withFileTypes: true })).map(async (entry) =>
                  entry.isDirectory()
                    ? walk(resolve(dir, entry.name))
                    : [resolve(dir, entry.name).slice(root.length + 1)],
                ),
              )
            ).flat();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          }
        };
        return walk(base);
      },
      put: async (k, b) => {
        const p = path(k);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, b, { flag: "wx" });
      },
      get: (k) => readFile(path(k)),
      delete: (k) => rm(path(k), { force: true }),
    };
  }
  const client = new S3Client({
    region: "auto",
    endpoint: c.R2_ENDPOINT!,
    credentials: { accessKeyId: c.R2_ACCESS_KEY_ID!, secretAccessKey: c.R2_SECRET_ACCESS_KEY! },
  });
  return {
    list: async (Prefix) => {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: c.R2_BUCKET!,
            Prefix,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
        for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key);
        token = page.NextContinuationToken;
      } while (token);
      return keys;
    },
    put: async (Key, Body) => {
      await client.send(
        new PutObjectCommand({
          Bucket: c.R2_BUCKET!,
          Key,
          Body,
          ContentType: "application/gzip",
          IfNoneMatch: "*",
        }),
      );
    },
    get: async (Key) => {
      const r = await client.send(new GetObjectCommand({ Bucket: c.R2_BUCKET!, Key }));
      if (!r.Body) throw new Error("Object missing");
      return r.Body.transformToByteArray();
    },
    delete: async (Key) => {
      await client.send(new DeleteObjectCommand({ Bucket: c.R2_BUCKET!, Key }));
    },
  };
}
export const encode = (value: unknown) => gzipSync(Buffer.from(JSON.stringify(value)));
export function decode(bytes: Uint8Array, checksum?: string): unknown {
  if (checksum && hash(bytes) !== checksum) throw new Error("Snapshot checksum mismatch");
  return JSON.parse(
    gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }).toString(),
  ) as unknown;
}
