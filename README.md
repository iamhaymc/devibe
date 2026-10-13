<table>
<tbody>
<tr>
<td><img src="./data/_brand/logo_1.svg" width="64px"/></td>
<td><h1 style="color:#234;">DEVIBE</h1></td>
</tr>
</tbody>
</table>

See how a codebase is built, check it for problems, and reshape it — fast, even when most of it was generated and nobody has read it yet.

devibe scans one or more local repos and draws them as one zoomable, GPU-rendered map: folders hold files, files hold types and functions, and zooming in turns colored blocks into real, highlighted code. The same map stands up as a 3D city where each function is a tower over its own code, and the code sits on the roofs. Links show what uses what, down to the line. Checks flag the usual debris of generated code (copies, loops, stubs, secrets, unused code, versioned names, files that always change together). Select anything — parts, links, line ranges, a legend color, a query — and the Act bar offers what fits: explain, tidy, split, fix, test, document, decouple, merge, extract. Every edit is staged so you review a diff before anything touches disk.

![Map](test/shots/02-map.png)

| Read code in place | Check findings | Reshape with the agent |
| --- | --- | --- |
| ![Code](test/shots/04-code.png) | ![Check](test/shots/15-check.png) | ![Agent](test/shots/17-agent.png) |

| City | Code on the roofs | Links in 3D |
| --- | --- | --- |
| ![City](test/shots/30-city-open.png) | ![Reading in City](test/shots/31-city-read.png) | ![City links](test/shots/33-city-links.png) |

| A link and where it happens | Grow the set | Act one by one |
| --- | --- | --- |
| ![Link](test/shots/34-link-select.png) | ![Grow](test/shots/35-grow.png) | ![One by one](test/shots/39-act-each.png) |

| Code sheet | Layers | Phone |
| --- | --- | --- |
| ![Code sheet](test/shots/40-code-edit.png) | ![Layers](test/shots/10-layers.png) | ![Phone](test/shots/44-phone-act.png) |

Every view is in [`test/shots/`](test/shots).

## Quickstart

Needs Node.js 20+ and git. `util/setup.sh` (Mac/Linux) or `util/setup.ps1` (Windows) installs nvm and uses it to install Node.js LTS, alongside uv, Python 3.12 and clang.

```sh
npm install
node app/server.mjs ~/code/my-repo ~/code/other-repo --open
```

Then open http://127.0.0.1:4747. No repo handy? `node app/server.mjs --demo` opens a small sample shop with planted problems. In VS Code, run the `serve` task (**Tasks: Run Task**) and enter folders or keep `--demo`.

### Set up the agent

Any OpenAI-compatible endpoint works. For OpenRouter:

```sh
export DEVIBE_ENDPOINT=https://openrouter.ai/api/v1
export DEVIBE_MODEL=deepseek/deepseek-v4.1-flash   # any model that supports tool calls
export DEVIBE_API_KEY=sk-or-...
node app/server.mjs ~/code/my-repo
```

Or set them in **Settings** in the app (saved to `~/.devibe/config.json`). Check the exact model name on your provider's model list.

### Exact parsing (optional)

`npm install` also installs `@vscode/tree-sitter-wasm`, an optional package. Pick **Tree-sitter** under **Settings → Parser** (or set `DEVIBE_PARSER=tree-sitter`) to read exact syntax trees for C#, C/C++, Go, Java, JavaScript, PHP, Python, Ruby, Rust, and TypeScript: macros, templates, decorators, and nested lambdas come out right, at the cost of slower scans. The built-in parser stays the default and covers every language.

devibe skips cache and package folders (`node_modules`, `.venv`, `__pycache__`, …) everywhere, build output (`dist`, `build`, `bin`, …) unless it is committed, and anything a `.gitignore` excludes.

## Use it

- **Zoom** with the wheel or a pinch. Keep zooming into a file to read its code. **Double-click** to zoom to a part, or to open code you can already read in the Code sheet.
- **Layouts** (`1`–`4`): Map, Graph, Layers (base code at the bottom), City (3D). In City, right-drag or Alt+drag to orbit, `V` for Tilt, Top, or Low, and Height to choose what towers measure.
- **Select** to build a set: click parts (Shift adds), click a link (Alt+click for the folders around it), click the gutter for lines, Shift+drag a box, click a legend color, or Select all on a Find query or a Check rule. The Selection panel shows its members, its interface (what it uses, what uses it, and where), and its findings.
- **Grow** the set with `]` (what it uses) and `[` (what uses it), or Path, Loop, Copies, Tests, and Inside in the panel. Sets made from a query, rule, or grow stay live as the code changes; **Sets** in the panel keeps them by name.
- **Find** (`/`) by name, file text, or a query like `kind:func cx>10 in:web`. Type `>` for every action on the set.
- **Color** (`C`) by language, size, complexity, churn, age, used by, issues, review, changes, or reach from the set.
- **Act**: the bar under the map offers the actions that fit the set. Agent actions run all at once or one by one; Explain never edits. Rename (`F2`), move (drag the grip onto a folder, or a function onto a file), and delete without the agent. Moves fix JS/TS, Python, and C# imports and namespaces as they go.
- **Check** lists findings by rule. Click a rule to light it up; Select all to act on every hit.
- **Review**: press `R` to mark the set reviewed. Marks go stale when the code changes.
- **Staged changes**: open a file in the Code sheet to edit lines in place or revert one hunk, preview the reshaped map (nothing moves; deleted files stay as ghosts), apply, undo.

Press `?` in the app for all keys.

## Test

```sh
npm test               # every suite
npm run test:server    # unit tests (parsing, Tree-sitter, receivers, checks, stage, sockets, agent loop, sets, link routes)
npm run test:client    # browser tests and workflows; rewrites the images in test/shots/
```

The browser tests use Playwright's Chromium. Run `npx playwright install chromium` once if it is missing.

## Learn more

- [DESIGN.md](DESIGN.md) — how it works, every option, message, rule, and limit.
- [TODO.md](TODO.md) — known gaps, by impact.
