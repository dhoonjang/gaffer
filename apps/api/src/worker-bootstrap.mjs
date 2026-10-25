import { URL } from "node:url";
import { register } from "tsx/esm/api";
register({ tsconfig: new URL("../tsconfig.json", import.meta.url).pathname });
await import("./worker-entry.ts");
