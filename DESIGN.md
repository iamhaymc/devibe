# devibe design

devibe helps you understand, audit, and reshape codebases that grew faster than anyone could read them. This document is the complete reference: what each part does, how it works, and every option, message, rule, and limit.

## Contents

1. [Principles](#principles)
2. [Architecture](#architecture)
3. [Server](#server)
4. [Client](#client)
5. [Message reference](#message-reference)
6. [Data model reference](#data-model-reference)
7. [Checks reference](#checks-reference)
8. [Agent reference](#agent-reference)
9. [Security](#security)
10. [Testing](#testing)
11. [Naming](#naming)
12. [Limits and performance](#limits-and-performance)

## Principles

- **One view.** Everything happens on one zoomable canvas. Panels sit around it; they never replace it.
- **Zoom is the detail control.** Far out you see folders, closer you see files and their types and functions, closest you read the code itself.
- **Nothing changes without review.** Every edit, from the agent or from a direct action, is staged. You see a diff and a preview before anything is written, and every apply can be undone.
- **Plain words.** Labels say what things are: "Copied code", "Used by", "Staged changes".
- **Local first.** The server reads local folders and binds to loopback by default.

## Architecture

```
 Browser (client.html, client.css, client.mjs)            Node (server.mjs)
┌──────────────────────────────────────────────┐        ┌──────────────────────────────────┐
│ hub ── message handlers ── state             │  JSON  │ Workspace                         │
│  │                                           │◀──────▶│  repos → scan → facts (cached)    │
│  ├─ three.js: tiles, blocks, links (WebGL)   │   WS   │  buildModel → nodes, links, issues│
│  ├─ Canvas 2D "ink": labels, code, outlines  │        │  Stage (pending edits, undo)      │
│  ├─ d3: layouts, zoom, scales, transitions   │        │  Ledger (reviews, waivers)        │
│  └─ DOM panels: bar, Check, Change, Info     │        │  Agent (OpenAI Agents SDK)        │
└──────────────────────────────────────────────┘        └──────────────────────────────────┘
```

Files:

| File | Role |
| --- | --- |
| `server.mjs` | CLI, HTTP static server, WebSocket protocol, scanner, parsers, model, checks, diff, stage, ledger, agent, demo repo. |
| `server.test.mjs` | Unit tests with `node:test`. Includes a mock OpenAI-compatible endpoint. |
| `client.html` | Page shell: canvases, bar, panels, dialogs. Loads d3 and three.js from `node_modules` through the server. |
| `client.css` | Theme tokens (dark, light, system), layout, panels, responsive rules. |
| `client.mjs` | Hub, state, wire, layouts, renderer, ink, picking, panels, keys. |
| `client.test.mjs` | Playwright tests that drive every feature and save screenshots to `shots/`. |
| `package.json` | Dependencies and scripts. |

Dependencies: `ws` (WebSocket server), `@openai/agents` and `openai` (agent), `d3` and `three` (served to the browser), `playwright` (tests).

## Server

### Command line

```
node server.mjs [folders...] [--port 4747] [--host 127.0.0.1] [--open] [--demo] [--no-watch]
```

| Option | Meaning |
| --- | --- |
| `folders` | Repos or plain folders to open at start. |
| `--port`, `-p` | HTTP and WebSocket port. Default 4747. `0` picks a free port. |
| `--host` | Bind address. Default `127.0.0.1`. Anything else prints a warning. |
| `--open`, `-o` | Open the browser. |
| `--demo` | Write the sample repo to `$TMPDIR/devibe-demo` and open it. |
| `--no-watch` | Do not watch files for changes. |

### Settings

Settings come from, in order of precedence: environment, `~/.devibe/config.json`, defaults.

| Setting | Environment | Default | Notes |
| --- | --- | --- | --- |
| Endpoint | `DEVIBE_ENDPOINT` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible Chat Completions endpoint. |
| Model | `DEVIBE_MODEL` | `deepseek/deepseek-v4.1-flash` | Must support tool calls. |
| API key | `DEVIBE_API_KEY`, then `OPENROUTER_API_KEY`, `OPENAI_API_KEY` | none | Never sent to the browser; the client only sees `hasKey`. |
| Style guide | — | empty | Free text sent with every agent request. |
| Max steps | — | 40 | Agent turn limit per request. |
| Home folder | `DEVIBE_HOME` | `~/.devibe` | Holds `config.json` (mode 600) and `ledger/`. |

### Scanning

1. **List files.** Inside git: `git ls-files -c -o --exclude-standard` (tracked plus untracked, minus ignored). Outside git: a walk that skips `node_modules`, `dist`, `build`, `bin`, `obj`, `target`, `vendor`, `.venv`, `__pycache__`, and other build or cache folders. At most 40,000 files.
2. **Read files** 16 at a time. Binary files (a zero byte in the first 8 KB) are skipped. Files over 2 MB are listed with an estimated line count and marked generated.
3. **Cache.** Facts are kept per file and reused while the file's size and modification time stay the same, so rescans only parse what changed.
4. **Git history.** The last 3,000 commits give each file a commit count (churn) and last change time. `git status` marks uncommitted files.
5. **Watch.** Each folder that holds scanned files gets a watcher (up to 4,000). Changes trigger a rescan of that repo after 350 ms of quiet, and the new model is pushed to every client. While devibe itself applies or undoes edits, watch events are ignored for 1.5 s.

### Parsing

Parsing is built in and heuristic: fast, dependency-free, and structural rather than compiler-exact.

**Masking.** Each code file is first copied with comments and string contents replaced by spaces, keeping every offset and newline. Later passes run on this masked copy so braces, keywords, and names inside strings or comments never confuse them. The masker knows line and block comments per language, escapes, Python and C# triple-quoted strings, C# verbatim strings, Go raw strings, JS template literals and regex literals, Rust raw strings and lifetimes.

**Symbols.** Each file yields a tree of symbols with a kind, a form, a name, and a line range.

| Kind | Forms |
| --- | --- |
| `space` | namespace, module |
| `type` | class, struct, interface, enum, record, trait, impl, object, protocol, extension, type alias, annotation |
| `func` | function, method, ctor |
| `part` | Markdown headings (`h1`–`h6`), top-level keys in JSON, YAML, and TOML |

| Family | Languages | How |
| --- | --- | --- |
| Braces | C#, Java, Kotlin, Scala, Swift, Dart, Go, Rust, C, C++, JavaScript, TypeScript, Vue/Svelte, PHP, Shell | Type and namespace patterns per language, a general "name(params) followed by `{` or `=>`" detector for functions and methods, plus extras: Go receivers attach methods to their type, Rust `impl` blocks, Kotlin and Scala expression bodies, JS arrow functions and object methods, TS type aliases, interface members and C prototypes ending in `;`. Bodies end at the matching brace. |
| Indent | Python, Ruby, Lua | `def`/`class`/`module`/`function` lines; the body ends at the next line with the same or less indent (or the matching `end`). |
| Statements | SQL | `create table/view/function/procedure/trigger/index/type` up to `;`. |
| Data | Markdown, JSON, YAML, TOML/INI | Headings and top-level keys as `part` symbols. |

Per function: **lines**, **branches** (`if`, loops, `case`, `catch`, `&&`, `||`, `??`, and `and`/`or` in Python, Ruby, Lua, plus 1), **nesting** (deepest brace or indent level inside the body), **parameters** (`self`, `this`, `cls` not counted). Types keep their **base types** (`: Base`, `extends`, `implements`, Python bases, Ruby `<`, Rust `impl Trait for`).

**Imports** are read per language and kept only when they start in code (not in a comment). **Words** (identifiers of 3+ characters that are not keywords) are indexed with their line numbers for linking and for the unused-code check.

**File flags.** `gen` marks lock files, minified files (average line over 300 characters), and files whose head says generated or "do not edit". Generated files are drawn but skipped by checks and links. `test` marks test files by path and name.

### Linking

Links connect node ids and carry a kind and a weight (how many times).

| Kind | From → to | How |
| --- | --- | --- |
| `import` | file → file | Import specifiers resolved per language: relative paths with extension and index probing (JS/TS `.js`→`.ts`), `@/` and `~/` aliases, Python dotted and relative modules, Java/Kotlin/Scala packages and wildcards, Go module paths from `go.mod`, Rust `mod` and `use crate::/super::`, C/C++ includes, PHP namespaces, Ruby and Lua requires, CSS imports, HTML `src`/`href`, Dart packages. Unresolved package names are listed as the file's packages. |
| `call` | symbol or file → function | A word in the source matches a function declared elsewhere. |
| `use` | symbol or file → type | A word matches a type or namespace declared elsewhere. |
| `base` | type → type | A base type name matches a declared type. |
| `copy` | symbol → symbol | Two places share a copied block (see [Copied code](#checks-reference)). |

Name matching stays precise by: only linking within one language family (JS/TS/HTML, JVM, C/C++, or the same language); ignoring names declared more than 4 times; preferring, when a name has several declarations, the same file, then an imported file, then the same folder; skipping a symbol's own name and links between a node and its own ancestors or descendants. C# and Swift have no file imports, so their structure comes from type and call links.

### Stage

The stage holds pending edits as `{ before, after }` per file. `before` is captured from disk on first touch; `after` is `null` for a delete. An edit that returns a file to its original text drops out of the stage.

- **Read through.** The agent and the mechanical edits read staged text first, so edits build on each other.
- **Diff.** Myers line diff (with common prefix and suffix trimmed first) grouped into hunks with 3 lines of context.
- **Apply** writes the chosen files (or all). It refuses, without writing anything, if a file changed on disk since it was staged or if the path leads outside its repo through a symlink. Folders emptied by deletes or moves are removed.
- **Undo** restores the last applied group (up to 30 groups).
- **Preview** rebuilds the model from staged text, so the map shows the reshaped code before you apply. The status bar says "Preview".

Mechanical edits (no agent):

| Edit | What it stages |
| --- | --- |
| Rename | Whole-word replacement of a type, function, or namespace name in code (not in strings or comments) across every non-data file. |
| Move | A file or folder into another folder. Files keep their relative layout. "Move + fix" also asks the agent to update imports and references. |
| Delete | Files, folders (all files inside), or symbols (their line range, plus attached attributes, decorators, and doc comments). "Remove all" in the Unused code rule deletes every unused symbol it lists. |

### Ledger

Per repo, `~/.devibe/ledger/<hash of path>.json` keeps:

- **Review marks**: node key → hash of its text (whole file, or the symbol's line range). The model reports each mark as `ok` or `stale` (text changed since review). Marking a folder marks each file in it.
- **Waivers**: `rule|key` pairs for findings marked as fine. Waived findings are hidden unless "Show waived" is on.

Coverage in the Check panel is the share of non-generated lines covered by `ok` marks.

## Client

### Messages and state

The client is message-driven. `hub.emit(type, data)` runs every handler registered with `hub.on(type, fn)`. Server messages arrive through `wire` and are emitted on the same hub, so a server push and a click are handled the same way. Handlers update `state`, then redraw what changed (panels, colors, links, or the next frame). `wire.ask(type, data)` sends a request and resolves with the reply that carries its id.

### Rendering

| Layer | Technology | Draws |
| --- | --- | --- |
| Tiles | three.js `InstancedBufferGeometry` with a custom shader | Every rectangle and circle in Map, Graph, and Layers: one instance each, with a signed-distance rounded box, antialiased edges, inner edge shading, and zoom-aware fading of file bodies as code becomes readable. Hundreds of thousands of tiles in one draw call. |
| Blocks | three.js `InstancedMesh` of boxes, Lambert lighting | City buildings and folder plinths. |
| Links | three.js `LineSegments2` (fat, antialiased screen-space lines) | Links as sampled curves with a dim-to-bright gradient from source to target. |
| Ink | Canvas 2D on top of WebGL | Text and outlines with native font rendering: labels, code minimaps, code text, issue markers, selection and hover outlines, drag ghost. Only what is visible and large enough is drawn. |

d3 provides the layouts (`treemap`, `forceSimulation`, `quadtree`), zoom and pan (`d3-zoom`, including pinch), transitions and easing, curve sampling (`curveBundle`, `curveNatural`), and formatting.

World units are chosen so that one code line is about one unit, which keeps 32-bit GPU coordinates precise at any zoom. The view transform is applied to a scene group; City adds a tilt group (pitch 0.95 rad, yaw −0.5 rad) under it, so pan and zoom stay in screen space even in 3D.

Layout changes morph: each tile animates from its previous rectangle (or its parent's) to its new one in 720 ms. City grows buildings from the ground while the view tilts.

### Layouts

| Layout | Key | What it shows | How |
| --- | --- | --- | --- |
| Map | `1` | Repos, folders, files, and the code inside, nested and sized by lines. | Squarified treemap. Folder headers scale with folder size and are never smaller than file headers. Inside each file, code is laid out in columns of 84 characters (4 for line numbers); types and functions are bands over their line ranges, indented by depth. The treemap's shape follows the screen's shape, so phones and portrait tablets fill the screen. |
| Graph | `2` | Parts at the chosen detail pulled together by their links. | Force simulation seeded from Map positions (so related folders stay near each other), with link, charge, collision, and home forces. Up to 4,000 nodes; runs at most 1.1 s before drawing. |
| Layers | `3` | Parts stacked by dependency: base code at the bottom, code that depends on it above. | Strongly connected groups share a level; each level is one more than the highest level it depends on. Rows are ordered by folder, then by four barycenter sweeps to cut crossings. Parts in a loop are tinted red. |
| City | `4` | The map in 3D. Building height shows the color measure (lines when the color is not a measure). | Map rectangles as boxes on stacked folder plinths. |

**Detail** (`D`): Folders, Files, Types, Functions. It sets the nodes of Graph and Layers and the level links are lifted to. Lifting walks a node up to the chosen level: a method's call becomes its type's or file's link.

**Links** (`L`): Off; Focus (links of the selection and the hovered part: blue for "uses", orange for "used by"; Graph and Layers also show all links faintly); All (every link at the chosen detail, colored by kind). In Map, links are bundled along the folder tree. While you read code, links fade so they do not cover the text.

### Zoom levels in Map

| What you see | When |
| --- | --- |
| Folder names centered over their area | The folder's header is too small to read and none of its children are labeled yet. |
| File names centered over their code | The file's header is too small to read and its code lines are under 1.6 px. |
| Folder and file names in their headers | Header is 8.5–9 px or taller. All files share one header height tied to the code line height, so names appear just as code becomes a minimap. |
| Code minimap (each token a bar) with type and function labels | One code line is 1.1–7.5 px tall. |
| Code text with syntax colors, line numbers (from 10 px), issue markers in the gutter, selected ranges tinted | One code line is 7.5 px or taller. |

File text is fetched on demand when a file first needs its minimap and kept for up to 400 files.

### Color

| Color | Shows | Scale |
| --- | --- | --- |
| Language | Language of each file; types violet, functions blue | Fixed hue per language for the session (first seven by size), others gray. |
| Size | Lines | Sequential blue, log scale to the 97th percentile. |
| Complexity | Branches per function; files and folders show their most complex function | Sequential blue to the 97th percentile (at least 10). |
| Churn | Commits touching the file | Sequential blue. |
| Age | Time since last change; brighter is newer | Sequential blue. |
| Issues | Worst finding inside | Status colors: high red, medium orange, low yellow, none gray. |
| Review | Reviewed, changed since review, not reviewed | Green, yellow, gray. |
| Changes | Staged new, staged edit, staged delete, uncommitted in git | Green, blue, red, dim yellow. |

The palette is a validated colorblind-safe categorical set with separate dark and light steps, a single-hue sequential ramp, and reserved status colors that always come with a label or shape (diamond high, square medium, circle low).

### Interaction

| Input | Action |
| --- | --- |
| Wheel, pinch, drag | Zoom and pan. |
| Click, tap | Select. Shift, Ctrl, or Cmd adds or removes. Long-press adds on touch. |
| Double-click, double-tap | Zoom to the part (functions zoom until code is readable). |
| Shift + drag | Box select. |
| Drag the grip | The selected file or folder shows a blue grip on its header. Drop it on a folder to stage a move. |
| Hover | Tooltip with kind, path, lines, branches, commits, issues, staged state. |
| `/`, Ctrl/Cmd + K | Find. Arrow keys and Enter pick a result. The last row searches file text. |
| `1`–`4` | Layouts. |
| `C` / Shift + `C` | Next / previous color. |
| `D` | Next detail. |
| `L` | Links: off, focus, all. |
| `F`, `0` | Fit everything. |
| Enter | Zoom to the selection. |
| `U`, Backspace | Select the parent. |
| Esc | Close a popover or diff, then clear find, then the rule spotlight, then the selection, then fit. |
| `R` | Mark the selection reviewed (or unmark). |
| `E` | Ask the agent about the selection. |
| `F2` | Rename the selected type or function. |
| `M` | Move the selected file or folder. |
| Delete | Stage a delete of the selection. |
| `O` | Open a folder. |
| `+`, `-`, arrows | Zoom and pan by steps. |
| `?` | Help. |

### Panels

- **Bar**: open, breadcrumb (selection path, or the folder at the center of the view), find, layout, detail, color, links, fit, settings, help.
- **Check**: counts by level, review progress, and findings grouped by rule (worst first). Clicking a rule spotlights it: the map dims everything else and outlines each hit in its level color. Each finding can be opened, fixed with the agent, or marked as fine. Rule actions: Fix with agent; Remove all (Unused code).
- **Change**: focus (the selection), quick asks, staged changes (apply, discard, preview, undo, open a diff), the conversation with tool steps as they happen (files the agent touches flash on the map), and the prompt.
- **Info**: kind, path and lines, facts (lines, branches, nesting, parameters, language, commits, last change, review, issues), signature, base types, actions (Zoom, Reviewed, Ask, Rename, Move, Delete, open in VS Code), findings, Uses and Used by (with link kinds and counts), outline (files), largest files (folders), packages (files).
- **Diff**: unified diff with syntax colors, previous and next file, Apply, Discard.
- **Dialogs**: Open (path, folder browser with git badges, open and recent repos, demo on first run), Settings (endpoint, model, key, max steps, style guide, theme, Test), Help.

### Responsive layout

| Width | Layout |
| --- | --- |
| Over 1240 px | Full bar, Check/Change dock on the left, Info on the right, legend and status at the bottom. |
| 761–1240 px | Breadcrumb hidden; detail, color, and links move into a View panel opened from the bar. |
| 760 px and under | Compact bar; a bottom tab bar (View, Check, Change, Info) opens each panel as a bottom sheet. The map refits above the open sheet. Touch: pinch, drag, tap, double-tap, long-press. |

## Message reference

Every message is JSON: `{ type, data, id? }`. A request with an `id` gets exactly one reply with `re: id` (type `note` with `level: "error"` on failure). Server pushes have no `re`.

### Client to server

| Type | Data | Reply |
| --- | --- | --- |
| `hello` | — | `hello` `{ config, model, stage, busy }` |
| `repo.open` | `{ path }` | `config.state` |
| `repo.shut` | `{ name }` | `config.state` |
| `repo.scan` | — | `ok` |
| `repo.demo` | — | `config.state` |
| `dir.list` | `{ path }` | `dir.items` `{ path, up, repo, items: [{ name, path, repo }] }` |
| `file.read` | `{ key }` | `file.text` `{ key, text }` (staged text in preview) |
| `text.find` | `{ query, regex?, cased? }` | `find.hits` `{ query, hits: [{ key, line, text }] }` (max 400) |
| `agent.run` | `{ prompt, focus: [key] }` | `ok`; then `agent.step` pushes and `agent.done` |
| `agent.stop` | — | `ok` |
| `agent.reset` | — | `agent.reset` |
| `agent.test` | — | `agent.tested` `{ ok, text }` |
| `stage.diff` | `{ key }` | `stage.diff` `{ key, path, state, from, lang, hunks: [{ a, b, lines: [[sign, oldLine, newLine, text]] }] }` |
| `stage.apply` | `{ keys? }` | `note` |
| `stage.discard` | `{ keys? }` | `ok` |
| `stage.undo` | — | `note` |
| `stage.rename` | `{ key, name }` | `note` |
| `stage.move` | `{ key, to }` | `note` |
| `stage.delete` | `{ keys }` | `note` |
| `stage.preview` | `{ on }` | `ok` |
| `review.mark` | `{ keys, on }` | `ok` |
| `issue.waive` | `{ rule, key, on }` | `ok` |
| `config.set` | `{ endpoint?, model?, apiKey?, style?, maxTurns? }` | `config.state` |

### Server to client (pushes)

| Type | Data |
| --- | --- |
| `repo.model` | The model (below). Sent after every scan, watch event, apply, undo, mark, waiver, and preview toggle. |
| `scan.step` | `{ repo, done, total }` |
| `stage.state` | `{ items: [{ key, path, repo, state, adds, dels, from?, conflict? }], undo, preview }` |
| `agent.step` | `{ kind: 'start', text, focus }`, `{ kind: 'text', text }` (streamed), or `{ kind: 'tool', name, args, note }` |
| `agent.done` | `{ text }` or `{ error, text }` |
| `config.state` | `{ endpoint, model, style, maxTurns, recent, hasKey, repos: [{ name, root }] }` |
| `note` | `{ level: 'info' \| 'good' \| 'error', text }` |

### Client hub messages

`view.layout`, `view.paint`, `view.detail`, `view.links`, `view.theme`; `pick.hover`, `pick.set`, `pick.drop`, `pick.clear`; `find.query`, `find.text`; `check.spot`, `check.waived`; `dock.show`, `sheet.toggle`, `box.open`; `diff.open`, `diff.close`; `agent.ask`, `agent.reset`; `review.mark`; `stage.apply`, `stage.discard`, `stage.undo`, `stage.move`, `stage.rename`, `stage.delete`; `link.up`, `link.down`.

## Data model reference

```js
{
  nodes: [Node],               // index = id; parents come before children
  links: [[from, to, kind, weight]],   // kind indexes linkKinds
  linkKinds: ['import', 'call', 'use', 'base', 'copy'],
  issues: [{ rule, node, line, note, level, waived? }],
  rules: [{ id, name, about }],
  marks: { [key]: 'ok' | 'stale' },
  langs: [{ id, name, lines }],        // by size
  stats: { files, lines, symbols, links, issues },
  preview: boolean,
  made: epochMs,
}
```

| Node field | Meaning |
| --- | --- |
| `id`, `up` | Index and parent index (`-1` for the root). |
| `kind`, `form` | See [Parsing](#parsing). Containers: `root`, `repo`, `dir`, `file`. |
| `name`, `key` | Display name; stable key `repo/path#Outer.Inner` (`~2` for repeated names). Keys survive rescans and are used for selection, reviews, and waivers. |
| `path`, `lang` | Repo-relative path; language id. |
| `lines`, `from`, `to` | Line count (folders sum their files); symbol line range. |
| `cx`, `nest`, `args` | Branches, nesting, parameters (functions). |
| `head`, `bases` | First line of the declaration; base type names. |
| `churn`, `time`, `dirty` | Commits, last change (epoch seconds), uncommitted. |
| `gen`, `test`, `ext` | Generated, test file, external packages imported. |
| `root`, `branch` | Repo folder and git branch (repos). |

## Checks reference

Levels: **high**, **medium**, **low**. Generated files are skipped. Thresholds: "mid" starts medium, "high" starts high.

| Rule | Id | Finds | Level |
| --- | --- | --- | --- |
| Possible secrets | `secret` | AWS keys, private keys, Stripe live keys, `sk-` keys, GitHub and Slack tokens, Google API keys, and `password`/`secret`/`api_key`/`token` assigned a literal of 8+ characters (placeholders like `xxx`, `your…`, `${…}`, `process.env` are ignored). Data files included. | high |
| Import loops | `loop` | Files that import each other in a circle (strongly connected import graph). | medium; high over 3 files |
| Copied code | `copy` | Blocks of 8+ lines repeated anywhere. Windows of 6 normalized code lines (comments, blank and brace-only lines dropped; mostly-import windows skipped) are hashed, matched, verified, and grown into maximal blocks. One finding per place, naming the first other place and how many more. | medium; high at 30+ lines |
| Big files | `size` | Code files over 400 lines. | medium; high over 1,000 |
| Long functions | `length` | Over 60 lines. | medium; high over 150 |
| Complex logic | `branch` | Over 12 branches. | medium; high over 25 |
| Deep nesting | `nest` | Over 4 levels. | medium; high over 6 |
| Many parameters | `args` | Over 5. | medium; high over 8 |
| Stubs and TODOs | `stub` | `TODO`, `FIXME`, `HACK`, `XXX` in comments (low); `NotImplementedException`, `NotImplementedError`, `unimplemented!`, `todo!`, "not implemented" throws and panics, Python bodies that are only `pass` or `...` (medium). | low, medium |
| Folder loops | `tangle` | Folders that depend on each other in both directions (any link kind but copies; parent and child folders excluded). | medium |
| Unused code | `unused` | A type or function whose name appears nowhere but its own declarations. Skips tests, generated files, constructors, overrides, entry points and framework hooks (`main`, `render`, `Dispose`, `ToString`, …), names starting with `test`, `on`, `handle`, `__`. | low |
| Versioned names | `version` | Files named like `_v2`, `new`, `old`, `copy`, `backup`, `final`, `tmp`, `fixed`, `improved`, `(1)` (medium); functions and types like `formatPriceV2` when `formatPrice` also exists (low). | medium, low |
| Debug leftovers | `debug` | `console.log`, `debugger`, `print(`, `breakpoint()`, `Debug.WriteLine`, `Console.WriteLine`, `System.out.println`, `printStackTrace`, `fmt.Print`, `dbg!`/`println!`, `var_dump`, `binding.pry`, and similar, outside test files. | low |
| Commented-out code | `dead` | Runs of 3+ comment lines where most look like code. | low |
| Mixed naming | `naming` | Functions whose style (snake_case, camelCase, PascalCase) differs from the 70%+ majority in that language (camel and Pascal count as one style outside C#). | low |
| Unlinked files | `lone` | Code files with no links in or out (entry-point names, data, HTML, CSS, shell, SQL, tests excluded). | low |
| Empty files | `empty` | No content (`__init__.py`, `.gitkeep` excluded). | low |
| Long lines | `wide` | Lines over 160 characters; one finding per file. | low |
| Crowded folders | `crowd` | Over 30 files directly in one folder. | low |

## Agent reference

The agent runs on the OpenAI Agents SDK (`@openai/agents`) with `OpenAIChatCompletionsModel`, so it works with any endpoint that speaks Chat Completions with tool calls (OpenRouter, OpenAI, local servers). Tracing is off. Runs stream: text deltas and tool steps are pushed to the client as they happen. The conversation history is kept until "New chat".

**Instructions** name the open repos and their size and languages, and say: read before writing, edits are staged (never claim they are applied), make the smallest complete change in the existing style, update every reference when moving or renaming, answer explain requests without editing, and end with a short bullet summary. The style guide from Settings is appended.

**Focus.** The selection is appended to the request as a list of parts with their paths and line ranges, plus their open findings.

| Tool | Parameters | Does |
| --- | --- | --- |
| `list_files` | `dir?` | Files with line counts, including staged new files. |
| `read_file` | `path, from?, to?` | Numbered lines from staged or disk text, up to 400 per call. |
| `find_text` | `pattern, regex?` | Up to 150 matching lines across all repos. |
| `show_outline` | `path` | The file's types and functions with line ranges. |
| `find_refs` | `name` | Declarations and every line that uses the name. |
| `write_file` | `path, text` | Stage a new or replaced file. |
| `edit_file` | `path, find, replace, all?` | Stage an exact text replacement; fails if the text is missing or not unique. |
| `move_file` | `from, to` | Stage a move. |
| `delete_file` | `path` | Stage a delete. |

Paths start with the repo name; with one repo open, plain repo-relative paths work too. The agent has no shell and cannot write outside the stage.

## Security

- Binds to `127.0.0.1` by default. On loopback, requests whose `Host` is not a loopback name are refused (blocks DNS rebinding), and WebSocket upgrades must come from the page's own origin (blocks other sites from driving the local server).
- The page is served with a strict Content Security Policy: scripts and styles only from the server itself (the inline import map is allowed by its hash), connections only back to the same host, no plugins, no framing.
- Only the client files and the d3 and three.js builds are served; nothing else in the project folder is reachable over HTTP.
- Every path from the client or the agent is normalized and must stay inside its repo (`..`, absolute paths, and drive letters are refused). Reads and writes that resolve through a symlink to a place outside the repo are refused.
- The API key stays on the server; `config.json` is written with mode 600.
- Nothing is written until you apply, and a file changed on disk since staging is never overwritten.

## Testing

`server.test.mjs` (`node --test`):

- Masking, symbols, and imports for every language family, including edge cases (verbatim strings, regex literals, lifetimes, control flow that looks like functions).
- The model on the demo repo: tree, every link kind, every planted finding, git history.
- Copies, loops, diff and hunks, stage apply/undo/conflict/move/delete/rename/preview, review staleness, waivers.
- Config precedence and key privacy.
- HTTP and WebSocket: static files, CSP, host and origin checks, path traversal, live watch updates.
- The agent end to end through the real SDK against a mock streaming endpoint: tool calls, staged edit, streamed text, focus and style guide in the request, history, connection test.

`client.test.mjs` (Playwright, `node --test`) starts a server with no repos and a mock model, then drives the UI like a user and saves one image per step to `shots/`:

| Image | Shows |
| --- | --- |
| `01-welcome` | First run dialog. |
| `02-map` | The demo repo after opening it from the dialog. |
| `03-folder` | Double-click zoom into a folder, with focus links and details. |
| `04-code` | Code text at reading zoom with findings in the gutter. |
| `05-links` | A selected file's uses and users. |
| `06-find`, `07-find-text` | Name search and text search. |
| `08-graph`, `09-graph-types` | Graph at file and type detail. |
| `10-layers`, `11-city` | Layers and City. |
| `12-complexity`, `13-issues`, `14-age` | Colors. |
| `15-check` | A spotlighted rule. |
| `16-review` | Review marks and progress. |
| `17-agent`, `18-diff`, `19-preview` | Agent run, diff, preview of staged changes. |
| `20-rename`, `21-move` | Rename popover and drag-to-move. |
| `22-settings`, `23-help`, `24-light` | Settings with a passing connection test, help, light theme. |
| `25-phone-map` … `28-phone-view` | Phone layout and bottom sheets. |
| `29-tablet` | Tablet layout. |

The tests also fail on any script error in the page.

## Naming

Names are short, plain, and paired so related things read alike:

- Messages are `noun.verb`: `repo.open`/`repo.shut`, `stage.apply`/`stage.undo`, `pick.set`/`pick.clear`, `diff.open`/`diff.close`.
- Functions pair a short verb with a noun: `readFacts`, `readSymbols`, `readImports`; `layMap`, `layGraph`, `layLayers`, `layCity`; `drawBar`, `drawDock`, `drawInfo`, `drawFoot`; `inkMap`, `inkFile`, `inkCode`; `pickAt`, `flyTo`, `fitAll`; `showTip`/`hideTip`.
- UI words: Map, Graph, Layers, City; Check, Change, Info; Find; Detail, Color, Links; Apply, Discard, Undo, Preview.
- Rule names are two plain words: Big files, Long functions, Copied code, Import loops.

## Limits and performance

| Limit | Value |
| --- | --- |
| Files per repo | 40,000 |
| File size parsed | 2 MB (larger files are listed, not parsed) |
| Watched folders per repo | 4,000 |
| Git history read | Last 3,000 commits |
| Graph and Layers nodes | 4,000 (the most linked and largest are kept) |
| Links drawn | 4,000 bright plus 6,000 faint |
| Text search results | 400 |
| Cached file texts in the client | 400 |

Measured on a 2,000-file, 375k-line tree in this environment: first scan and model 3.7 s, page ready 2.2 s. Rescans reuse cached facts and only rebuild the model.
