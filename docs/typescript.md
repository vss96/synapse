# TypeScript

How to write TypeScript in this repository so that the compiler can check it. [Development](development.md) describes the project layout.

## Compiler settings

There are three projects: `tsconfig.json` (`src/`, Node), `viewer/tsconfig.json` (`viewer/app.ts`, browser) and `tests/tsconfig.json` (extends the root and adds Bun's types). `bun run typecheck` checks all three.

The root and viewer configs turn on the same checks. Keep the two lists in sync:

| Flag | What it catches |
|---|---|
| `strict` | Includes `strictNullChecks` and `useUnknownInCatchVariables`, which makes `err` in `catch (err)` `unknown` |
| `noUncheckedIndexedAccess` | `array[i]` and `record[key]` may be `undefined` until you check them |
| `noFallthroughCasesInSwitch` | A `case` that falls into the next one by accident |
| `noImplicitReturns` | A code path that forgets to return |
| `noImplicitOverride` | A subclass method that overrides without saying `override` |
| `verbatimModuleSyntax` | Type-only imports must say `type`, so each file shows which imports are erased. esbuild, which bundles the viewer file by file without type information, reads them the same way |

Two flags are off on purpose. `exactOptionalPropertyTypes` adds little because zod already infers optional fields as `field?: T | undefined`; it would mostly force `| undefined` onto hand-written option types. `noPropertyAccessFromIndexSignature` is a style rule: `noUncheckedIndexedAccess` already makes those reads safe.

## Patterns to follow

### Validate where data enters, and get types from the schema

`src/model/schema.ts` defines the data model as zod schemas, and the TypeScript types come from them, so the two can't drift apart:

```ts
export const MindmapLink = z.object({ id: LinkId, from: NodeId, to: NodeId, label: Text, style: z.enum(LINK_STYLES), notes: z.string().optional() });
export type MindmapLink = z.infer<typeof MindmapLink>;
```

Data is parsed where it enters: documents read from disk (`MindmapDocument.safeParse` in `store.ts`), MCP tool input (each tool's `inputSchema`, in `defineTool`) and HTTP bodies (`ArchiveRequest` in `viewer.ts`). Past those points, trust the types and don't check again.

### Branded ids

`MindmapId`, `NodeId`, `LinkId` and `Timestamp` are branded strings. A plain `string` can't be passed where a `NodeId` is expected, so a mindmap id can't end up used as a node id. You get one from `NodeId.parse(...)` or `newNodeId()`. The id regex also keeps ids safe to use in file names, which `store.ts` relies on.

### Discriminated unions

When the fields that make sense depend on a kind, model each kind as its own variant instead of making fields optional and explaining them in a comment. `FileTouch` is a union on `action`: a `read` has no `changes`, and a `rename` always has a `previousPath`. `MindmapNode` is a union on `type`, where only task nodes have a `status`. Check the tag and TypeScript narrows to the variant:

```ts
const changes = touch.action === "read" ? [] : touch.changes;
```

### `as const` tuples are the single source for enums

`src/model/kinds.ts` lists each closed set once and derives everything else from it:

```ts
export const CHANGE_KINDS = ["add", "modify", "fix", "refactor", "rename", "remove", "test"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const isChangeKind = member(CHANGE_KINDS);
```

The zod schemas use `z.enum(CHANGE_KINDS)`. Tables keyed by a kind are typed `Record<ChangeKind, …>` (the viewer's glyphs and labels, `CHANGE_GLYPH` in `renderer.ts`), so adding a kind doesn't compile until every table has an entry for it.

### `kinds.ts` has no runtime dependencies

The viewer bundle imports `kinds.ts`, so it must not import any values. Its imports from `schema.ts` are `import type`, which are erased. The viewer imports from `schema.ts` with `import type` too: importing a value from it would bundle zod. That is why `viewer/app.ts` defines its own `ROOT` instead of importing `ROOT_ID`.

## Rules

### No `any`

Use `unknown` and narrow it. Look out for the `any` that library calls return without saying so: `JSON.parse`, `Response.json()` and `require()`. Assign their result to `unknown`, or parse it straight away:

```ts
const parsed: unknown = JSON.parse(raw);
if (isJsonObject(parsed)) return parsed;
```

### Parse untrusted data instead of casting it

- **In `src/`**, parse with the zod schema: `MindmapDocument.safeParse(JSON.parse(raw))`.
- **Without a schema**, narrow by hand, or write a type guard when you need the check more than once (`isJsonObject` in `installer.ts`).
- **In the viewer**, which can't use zod, narrow what the user or the browser controls: `localStorage` (the collapsed groups), the URL hash and `data-*` attributes (`nodeById`, `isChangeKind`, `SIDEBAR_TABS.find(...)`). JSON from the Synapse server goes through `serverJson<T>()`, the one place where the viewer trusts the server's types. Uploaded files are not validated yet; see the comment where they are loaded.
- **In `catch`**, `err` is `unknown`. Use `err instanceof Error ? err.message : String(err)`. Check Node error codes with `errorCode(err) === "EADDRINUSE"` (from `src/errors.ts`) instead of casting to `NodeJS.ErrnoException`.

### Avoid `as` and `!`

A cast or a non-null `!` tells the compiler to stop checking. There is usually a shape it can check instead:

| Instead of | Write |
|---|---|
| `merged[i]!.detail` | `const earlier = merged[i]; if (earlier) …` |
| `options.clients!` inside a callback | `const { clients } = options;` before the callback, so the narrowing holds inside it |
| an optional field plus `previousPath!` | a return type that is a union, where the rename variant always has `previousPath` (`combinedAction` in `file-touch.ts`) |
| `values as ClientId[]` | `values.filter(isClientId)` |
| `btn.dataset.tab as SidebarTab` | `SIDEBAR_TABS.find((t) => t === btn.dataset.tab)`, then handle `undefined` |
| `getElementById(id) as HTMLInputElement` | `byId(id, HTMLInputElement)`, which checks with `instanceof` |

A cast or `!` is fine when TypeScript can't know something that the code guarantees. Add a short comment saying why. The repo has five kinds:

- Branding a value that was just checked: `doc.nodes[id as NodeId]` right after `Object.hasOwn(doc.nodes, id)`.
- Keys that `Object.keys` and `Object.entries` widen to `string`, in `checkTree` in `schema.ts`.
- Data that ships with the code: `package.json` in `version.ts`.
- JSON from the Synapse server, in `serverJson` in the viewer.
- A rule that a zod refinement checks but the type can't express: `previousPath!` in `toFileTouch` in `tools.ts`.

Never double-cast (`x as unknown as T`). `as const` and `satisfies` aren't casts, so use them freely.

In tests, `!` on a value the test has just set up is fine, because a wrong guess fails the test. `assert.ok(value)` is better when it fits, since it also narrows.

### Make missing cases compile errors

When you handle each member of a union, make sure a new member breaks the build:

- End an `if` chain with `return value satisfies never;` (`createChild` in `node.ts`).
- Give a `switch` that returns a declared return type. A missing `case` is then a missing return (`render` in `renderer.ts`).
- In a `switch` that doesn't return, add `default: assertNever(value)` from `kinds.ts`.
- Type lookup tables as `Record<Union, …>`, like `STATUS_LABELS`.

### Prefer `satisfies` to annotations for constants

`const table = { … } satisfies Record<ChangeKind, string>` checks the object, but TypeScript keeps its exact type. An annotation (`const table: Record<ChangeKind, string> = …`) replaces the type with the wider one. Use an annotation when you want the wider type, for example `TYPE_BADGES: Partial<Record<NodeType, string>>`, which is read with any `NodeType`.

### Type exported functions explicitly

Write out the parameter and return types of exported functions:

```ts
export function combineTouches(prev: FileTouch, next: FileTouch): FileTouch
```

The signature is the contract other modules compile against. With an inferred return type, a change to the body can quietly change the API. Local helpers and callbacks can rely on inference.

### Use `readonly` where it helps

- Parameters you only read: `mergeChanges(prev: readonly CodeChange[], next: readonly CodeChange[])`. Callers can then pass `as const` tuples, and they know you won't change their arrays.
- Module-level constants: `as const`, or `readonly T[]` as in `CLIENTS`.

Don't make the data model `readonly`: the store and the tools change documents in place.
