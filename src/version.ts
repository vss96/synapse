import { createRequire } from "node:module";

// package.json sits one level above both src/ and dist/. It ships with this code, so its shape is
// known and the cast of require()'s `any` is safe.
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
