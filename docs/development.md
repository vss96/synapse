# Development

Synapse is developed with [Bun](https://bun.sh). The published package is plain JavaScript and runs on Node.js 20 or newer, without Bun.

```sh
curl -fsSL https://bun.sh/install | bash   # if you don't have Bun
git clone https://github.com/vss96/synapse.git
cd synapse
bun install
```

## Scripts

| Command | What it does |
|---|---|
| `bun test` | Runs the test suite (`bun:test`, in `tests/`) |
| `bun run build` | Removes `dist/`, compiles `src/` to `dist/` with `tsc`, type-checks the browser code (`tsc -p viewer`), and bundles `viewer/app.ts` to `dist/web/app.js` |
| `bun run dev` | Runs the MCP server from source with `--watch` |
| `bun run viewer` | Builds, then serves the viewer against the repository's `./data` |
| `bun run docs:dev` | Starts the docs dev server |
| `bun run docs:build` | Builds the docs to `docs/.vitepress/dist` |
| `bun run docs:preview` | Serves the built docs locally |

## Project layout

```text
src/
  index.ts         MCP server entry: server instructions, track-coding-plan prompt
  cli.ts           CLI: init / viewer / mcp
  installer.ts     Client detection and setup for `init`
  viewer.ts        Viewer HTTP + SSE server
  tools.ts         MCP tool handlers and their JSON input schemas
  store.ts         JSON store in SYNAPSE_DATA_DIR
  watcher.ts       Workspace watcher and git inspection
  renderer.ts      mermaid / text / json rendering
  model/
    kinds.ts       Enums (node types, statuses, change kinds, ...) and guards; no deps, used by the browser
    schema.ts      zod schemas: the source of the data model's types and boundary checks
    node.ts        Creating and attaching nodes
    file-touch.ts  Merging file touches and symbol-level changes
  version.ts       Package version
viewer/
  index.html       Viewer markup and CSS
  app.ts           Browser code (strict TypeScript, bundled by Bun to dist/web/app.js)
  tsconfig.json    DOM type-check for app.ts
tests/             bun:test suites: model, store-renderer, tools, viewer, installer
docs/              This site (VitePress); docs/public holds the logo and favicon
```

A few conventions:

- **`src/` is Node code.** `tsconfig.json` limits `src/` to Node types, so Bun-only APIs can't slip into code that ships.
- **`src/model/` is the single source of the data model.** `schema.ts` defines the types and validates data wherever it enters (disk, MCP tools, HTTP). `CHANGE_KINDS` and `FILE_ACTIONS` in `kinds.ts` feed the tool schemas directly, and the browser code imports the same types. If you add a change kind, also update its glyph, label, and color in the viewer and its glyph in `renderer.ts`.
- **The data files are the contract.** The MCP server and the viewer only communicate through the JSON files in the data directory. New fields must be optional so that existing mindmaps still load.
- **Installer tests are sandboxed.** `tests/installer.test.ts` runs the CLI in a child process with a temporary `HOME` and `PATH`, so it never touches your real client configs.

## Testing against a real client

Build, then point a client at your checkout's `dist/cli.js`:

```sh
bun run build
claude mcp add synapse-dev -- node /absolute/path/to/synapse/dist/cli.js mcp
```

Or run `npm link` in the repository and configure the client with `synapse-mindmap mcp`.

After every change to `src/`, rebuild, then restart or reconnect the client's MCP servers. Sessions that are already running keep the old tool list. Run the viewer (`node dist/cli.js viewer`) in a second terminal to watch updates live.

::: tip Keep your real data clean
Set `SYNAPSE_DATA_DIR` to a temporary directory, on both the MCP server and the viewer, when you test destructive changes.
:::

## Docs

The site lives in `docs/` and is built with [VitePress](https://vitepress.dev):

```sh
bun run docs:dev       # http://localhost:5173/synapse/
bun run docs:build     # fails on dead links
```

Every push to `main` that touches `docs/` deploys the site to GitHub Pages through `.github/workflows/docs.yml`. You can also run the workflow by hand. Before the first deploy, set **GitHub → Settings → Pages → Source** to **GitHub Actions** (a one-time step). Screenshots are in `docs/screenshots/`.

## Releasing

The package is published to npm as `synapse-mindmap`. It ships `dist/`, `viewer/index.html`, `docs/public/logo.png`, and `docs/public/favicon.png`, plus `README.md`, `LICENSE`, and `package.json`.

1. Bump `version` in `package.json`. The MCP server reports this version to clients.
2. Run the tests and publish:

   ```sh
   bun test
   npm publish
   ```

`prepack` runs `bun run build`, so `npm publish` and `npm pack` always ship a fresh build. Run `npm pack --dry-run` first to check exactly which files will be published.
