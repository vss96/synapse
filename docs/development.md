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
| `bun run test` | Type-checks the tests, bundles the viewer app (the viewer tests need it), and runs the test suite (`bun:test`, in `tests/`) |
| `bun run build` | Removes `dist/`, compiles `src/` to `dist/` with `tsc`, type-checks the browser code (`tsc -p viewer`), and bundles `viewer/app.ts` to `dist/web/app.js` with esbuild. It doesn't need Bun, so `npm run build` works too |
| `bun run build:web` | Only bundles `viewer/app.ts` to `dist/web/app.js` |
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
  errors.ts        errorCode(): the code of a Node.js system error
  model/
    kinds.ts       Enums (node types, statuses, change kinds, ...) and guards; no deps, used by the browser
    schema.ts      zod schemas: the source of the data model's types and boundary checks
    node.ts        Creating and attaching nodes
    file-touch.ts  Recording file touches on nodes, and which node they attach to
    file-stats.ts  Merging and aggregating file touches, and auto-detection; no deps, used by the browser
  version.ts       Package version
viewer/
  index.html       Viewer markup and CSS
  app.ts           Entry point (bundled by esbuild to dist/web/app.js): composes render(), toolbar, live events
  state.ts         What the viewer is showing; modules change it and call render()
  canvas.ts        The camera on the page: pan, zoom, bringing cards into view
  svg-render.ts    Drawing the map, and clicks and keys on it
  sidebar.ts       The Inspector, Changes and Activity tabs
  sessions.ts      The session list, and opening sessions
  find.ts          The find box
  panels.ts        Showing and hiding the session list, sidebar and legend
  collapse.ts      Folded branches, remembered per session
  toast.ts         Short messages, with an optional Undo
  display.ts       Labels, glyphs, tones and tallies
  dom.ts           DOM and text helpers
  layout.ts        Tree layout: views, folding, card positions, wrapped grids (pure, unit-tested)
  link-routing.ts  Flow link curves and label pills (pure, unit-tested)
  text-fit.ts      Fitting card text to a pixel width (pure, unit-tested)
  camera.ts        Pan/zoom math (pure, unit-tested)
  search.ts        Matching cards for the find box (pure, unit-tested)
  session-filter.ts  What the session list shows (pure, unit-tested)
  session-groups.ts  Grouping the session list by repository (pure, unit-tested)
  session-link.ts  The session ID in a URL hash (pure, unit-tested)
  local-file.ts    Checking a mindmap file opened from disk (pure, unit-tested)
  tsconfig.json    DOM type-check, starting from app.ts
tests/             bun:test suites, including viewer-dom, which runs the built page in a simulated DOM
docs/              This site (VitePress); docs/public holds the logo and favicon
```

A few conventions:

- **`src/` is Node code.** `tsconfig.json` limits `src/` to Node types, so Bun-only APIs can't slip into code that ships.
- **`src/model/` is the single source of the data model.** `schema.ts` defines the types and validates data wherever it enters (disk, MCP tools, HTTP). `CHANGE_KINDS` and `FILE_ACTIONS` in `kinds.ts` feed the tool schemas directly, and the browser code imports the same types. If you add a change kind, also update its glyph, label, and color in the viewer and its glyph in `renderer.ts`.
- **TypeScript is strict.** [TypeScript](typescript.md) covers the compiler settings, the patterns to follow and the rules: no `any`, parse untrusted data, and a comment on every cast.
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

Releases are staged by GitHub Actions ([`.github/workflows/publish.yml`](https://github.com/vss96/synapse/blob/main/.github/workflows/publish.yml)) when a `v*` tag is pushed, and go live once a maintainer approves them:

1. Bump `version` in `package.json` in a pull request and merge it. The MCP server reports this version to clients.
2. Tag the merged commit on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag v1.2.0
   git push origin v1.2.0
   ```

3. When the workflow has finished, approve the staged version. Approving asks for your npm two-factor code:

   ```sh
   npm stage list synapse-mindmap
   npm stage approve <stage-id>
   ```

   To inspect it first, `npm stage download <stage-id>` saves the tarball. `npm stage reject <stage-id>` discards it.

The workflow fails unless the tag is `v` plus the `package.json` version. It runs the typecheck and tests, then `npm stage publish --provenance`. `prepack` runs `npm run build`, so the published package is always a fresh build. Run `npm pack --dry-run` locally to check exactly which files will be published.

The workflow has no npm token. It authenticates with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), and npm records provenance linking each version to the commit and workflow run that built it. It can only stage: nothing reaches npm users without a maintainer's two-factor approval, so a leaked GitHub credential or a stray tag can't publish on its own.

### One-time setup

Trusted publishing is configured per package, so the package has to exist on npm first:

1. Publish the first version by hand: `npm login`, then `npm publish --access public`.
2. On npmjs.com, open the package's **Settings → Trusted publishing**, choose **GitHub Actions**, and enter owner `vss96`, repository `synapse`, workflow `publish.yml`. Leave **Allow npm publish** and **Allow npm dist-tag** unchecked, so the workflow can only stage.
3. Optionally, under **Publishing access**, require two-factor authentication and disallow tokens, so releases only come from the workflow plus your approval.
