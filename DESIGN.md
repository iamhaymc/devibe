# ⏬ Devibe — Design

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
- **One set, one Act bar.** Every operation works on the current set of parts, links, and line ranges. No panel keeps a selection of its own.
- **Every color is a group.** Clicking a legend color selects everything with that color; dragging across a gradient selects a range.
- **One geometry.** City is the Map extruded: the same rectangles, so a function's tower stands on its own code.
- **Zoom is the detail control.** Far out you see folders, closer you see files and their types and functions, closest you read the code itself. In City, buildings open into towers as you get close, and the code sits on the roofs.
- **Nothing changes without review.** Every edit, from the agent or from a direct action, is staged. You see a diff and a preview before anything is written, and every apply can be undone.
- **Plain words.** Labels say what things are: "Copied code", "Used by", "Staged changes".
- **Local first.** The server reads local folders and binds to loopback by default.

## Architecture

```
 Browser (client.html, client.css, client.mjs)            Node (server.mjs)
┌──────────────────────────────────────────────┐        ┌───────────────────────────────────┐
│ hub ── message handlers ── state             │  JSON  │ Workspace                         │
│  │                                           │◀──────▶│  repos → scan → facts (cached)    │
│  ├─ three.js: tiles, links (WebGL)           │   WS   │  buildModel → nodes, links, issues│
│  ├─ core_city.mjs: boxes, skyline, skyways   │        │  Stage (pending edits, undo)      │
│  ├─ Canvas 2D "ink": labels, code, outlines  │        │  Ledger (reviews, waivers, sets)  │
│  ├─ d3: layouts, zoom, scales, transitions   │        │  Agent (acts, tools, set prompts) │
│  ├─ core_sets.mjs: index, grow, queries      │        │  core_sets.mjs (the same module)  │
│  └─ DOM: bar, Check, Change, Selection, Act  │        │                                   │
└──────────────────────────────────────────────┘        └───────────────────────────────────┘
```

Files (source in `app/`, tests and screenshots in `test/`):

| File | Role |
| --- | --- |
| `app/server.mjs` | CLI, HTTP static server, WebSocket protocol, scanner, parsers, model, checks, diff, stage, ledger, agent, demo repo. |
| `test/server.test.mjs` | Unit tests with `node:test`. Includes a mock OpenAI-compatible endpoint. |
| `app/client.html` | Page shell: canvases, bar, panels, Act bar, Code sheet, dialogs. Loads d3 and three.js from `node_modules` through the server. |
| `app/client.css` | Theme tokens (dark, light, system), layout, panels, responsive rules. |
| `app/client.mjs` | Hub, state, wire, Map, Graph, Layers, tile renderer, 2D ink, picking, panels, Act bar, Code sheet, keys. |
| `app/core_force.mjs` | The Graph force layout. Runs in place for small graphs and as a module worker (`core_force.mjs?worker`) for large ones. |
| `app/core_city.mjs` | City: box shader, open-building planner, skyline index (picking and occlusion), orbit and pivot, labels, roof code, skyways, hull outlines, isolate and cutaway. `makeCity(env)` takes the client's state and helpers. |
| `app/core_sets.mjs` | The set core, with no DOM, d3, or three.js: model index, lifting, strongly connected groups and levels, grow operations, set boundary, Find queries, color classes, recipe replay. Shared by the client and the server. |
| `test/sets.test.mjs` | Unit tests for `core_sets.mjs` on the demo model. |
| `test/client.test.mjs` | Playwright tests that drive every feature and save screenshots to `test/shots/`, plus the workflow tests. |
| `package.json` | Dependencies and scripts. |

Dependencies: `ws` (WebSocket server), `@openai/agents` and `openai` (agent), `d3` and `three` (served to the browser), `playwright` (tests).

## Server

### Command line

```
node app/server.mjs [folders...] [--port 4747] [--host 127.0.0.1] [--open] [--demo] [--no-watch]
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
| `change` | file ↔ file | The files change in the same commits. Only commits touching 2–24 files count (bigger ones are formatting, renames, or merges). A pair is kept when it shares 3 or more commits and the shared count is at least 35% of the smaller file's commits; the top 4,000 pairs are kept. Stored once (lower id first) and drawn without arrowheads. |

`copy` and `change` links are left out of import loops, folder loops, unlinked files, lifted graphs, Graph forces, and Layers levels.

**Sites.** For each link the model keeps up to 12 source lines: the import line, the reference line for calls and uses, the type's declaration for bases, where each copy starts, and none for `change`. Sites are a non-enumerable property of the model, so they never travel in `repo.model`; the client asks for them per file with `file.links` (up to 2,000 per file) when a file becomes readable or a link is selected.

Name matching stays precise by: only linking within one language family (JS/TS/HTML, JVM, C/C++, or the same language); ignoring names declared more than 4 times; preferring, when a name has several declarations, the same file, then an imported file, then the same folder; skipping a symbol's own name and links between a node and its own ancestors or descendants. C# and Swift have no file imports, so their structure comes from type and call links.

### Stage

The stage holds pending edits as `{ before, after }` per file. `before` is captured from disk on first touch; `after` is `null` for a delete. An edit that returns a file to its original text drops out of the stage.

- **Read through.** The agent and the mechanical edits read staged text first, so edits build on each other.
- **Diff.** Myers line diff (with common prefix and suffix trimmed first) grouped into hunks with 3 lines of context.
- **Apply** writes the chosen files (or all). It refuses, without writing anything, if a file changed on disk since it was staged or if the path leads outside its repo through a symlink. Folders emptied by deletes or moves are removed.
- **Undo** restores the last applied group (up to 30 groups).
- **Edit range** replaces lines `from..to` (1-based, inclusive) of the staged-or-disk text; `from = to + 1` inserts without removing. Unknown files and lines outside the file are refused. The edit is staged like any other, so it shows in Preview and can be undone after apply.
- **Revert hunk** rebuilds the staged text with one hunk's old lines. Reverting every hunk drops the file from the stage.
- **Preview** rebuilds the model from staged text, so the map shows the reshaped code before you apply. The status bar says "Preview". The client keeps the last model from before Preview and lays out the union of both by file key, each file sized to the larger of its two sizes, so nothing moves when Preview toggles: only colors, heights, and contents change. Deleted files show as ghosts (hatched with a red outline in Map, red glass in City); new files are outlined green in Map and rise from their lot in City.

Mechanical edits (no agent):

| Edit | What it stages |
| --- | --- |
| Rename | Whole-word replacement of a type, function, or namespace name in code (not in strings or comments) across every non-data file. |
| Move | A file or folder into another folder; files keep their relative layout. Or a type or function into a file: its line range, with attached attributes, decorators, and doc comments, is cut and appended to the target file after a blank line, and both files are staged. "Move + fix" also asks the agent to update imports and references. |
| Delete | Files, folders (all files inside), or symbols (their line range, plus attached attributes, decorators, and doc comments). "Remove all" in the Unused code rule deletes every unused symbol it lists. |

### Ledger

Per repo, `~/.devibe/ledger/<hash of path>.json` keeps:

- **Review marks**: node key → hash of its text (whole file, or the symbol's line range). The model reports each mark as `ok` or `stale` (text changed since review). Marking a folder marks each file in it.
- **Waivers**: `rule|key` pairs for findings marked as fine. Waived findings are hidden unless "Show waived" is on.
- **Saved sets**: `sets: { id: { name, nodes, links, ranges, recipe, at } }`, in the ledger of the repo that holds the set's first member. At most 200 per repo and 5,000 keys per list. Saving a set does not rebuild the model.

Coverage in the Check panel is the share of non-generated lines covered by `ok` marks.

## Client

### Messages and state

The client is message-driven. `hub.emit(type, data)` runs every handler registered with `hub.on(type, fn)`. Server messages arrive through `wire` and are emitted on the same hub, so a server push and a click are handled the same way. Handlers update `state`, then redraw what changed (panels, colors, links, or the next frame). `wire.ask(type, data)` sends a request and resolves with the reply that carries its id.

### Rendering

| Layer | Technology | Draws |
| --- | --- | --- |
| Tiles | three.js `InstancedBufferGeometry` with a custom shader | Every rectangle and circle in Map, Graph, and Layers: one instance each, with a signed-distance rounded box, antialiased edges, inner edge shading, and zoom-aware fading of file bodies as code becomes readable. Hundreds of thousands of tiles in one draw call. |
| City boxes | three.js `InstancedBufferGeometry` box with a custom shader (`core_city.mjs`) | Plinths, lots, signs, podiums, towers, and shells. Each instance carries its previous and next geometry, so a morph costs one uniform per frame. Hemisphere and directional light, screen-space edge darkening, a brighter top when hovered. Two passes over one geometry: opaque, then ghosts (transparent, no depth write). |
| Links | three.js `LineSegments2` (fat, antialiased screen-space lines) | Links as sampled curves with a dim-to-bright gradient from source to target, one group per line width, in three layers that rebuild only when their inputs change: the base (every link in All, or the faint backdrop of Graph and Layers), the set (its boundary and picked links), and the hover. Routes are cached per layout, and the last few base and hover layers are kept, so hovering and selecting never re-route the base. The sampled polylines are kept for picking; each bright link also keeps its arrowhead point and direction. |
| Ink | Canvas 2D on top of WebGL | Text and outlines with native font rendering: labels, code minimaps, code text, call-site marks, issue markers, arrowheads, selection and hover outlines, drag ghost, and in City the code on the roofs. Only what is visible and large enough is drawn. |

d3 provides the layouts (`treemap`, `forceSimulation`, `quadtree`), zoom and pan (`d3-zoom`, including pinch), transitions and easing, curve sampling (`curveBundle`, `curveNatural`), and formatting.

World units are chosen so that one code line is about one unit, which keeps 32-bit GPU coordinates precise at any zoom. The view transform is applied to a scene group; City adds a rotation group (pitch and yaw, around a pivot) under it, so pan and zoom stay in screen space even in 3D. The camera is orthographic, so every world point maps to the screen affinely: `screen = O + x·u + y·v + z·w`, with `O`, `u`, `v`, `w` computed once per frame. Fitting, picking, roof text, and arrowheads all use this mapping.

Layout changes morph: each tile animates from its previous rectangle (or its parent's) to its new one in 720 ms. City grows buildings from the ground while the view tilts.

**Keeping it fast.** Fill colors are computed once per node for the current Color, Detail, model, and theme; Find, the rule spotlight, and Isolate only dim them, and recoloring waits for the next frame so several changes cost one pass. Per-file code facts (finding marks by line, call-site marks, the set's ranges) are cached, minimap bars are batched into one fill per token color, label sizes snap to half pixels so measured text widths are reused while zooming, and hover links follow after the pointer rests for 50 ms. Every shader compiles at startup, the analyses the first click needs (lifted links, loops, fan-in) run when the page is idle, and panels rebuild only what changed (the Check list, the legend, the agent log's entries, the tip), keeping the prompt's text and focus while the agent streams. Only small floating chrome (the bar, footer, Act bar, tips, toasts) is frosted glass; the large panels are opaque, since blurring their area behind a map that redraws every frame costs more GPU time than the map.

### Layouts

| Layout | Key | What it shows | How |
| --- | --- | --- | --- |
| Map | `1` | Repos, folders, files, and the code inside, nested and sized by lines. | Squarified treemap. Folder headers scale with folder size and are never smaller than file headers. Inside each file, code is laid out in columns of 84 characters (4 for line numbers); types and functions are bands over their line ranges, indented by depth. The treemap's shape follows the screen's shape, so phones and portrait tablets fill the screen. |
| Graph | `2` | Parts at the chosen detail pulled together by their links. | Force simulation seeded from Map positions (so related folders stay near each other), with link, charge, collision, and home forces. Up to 4,000 nodes. Over 400 nodes it runs in a worker for up to 4 s while the view stays live ("Laying out the graph…"); otherwise in place for up to 1.1 s. Graph and Layers are kept per Detail until the Map changes, so switching back is instant. |
| Layers | `3` | Parts stacked by dependency: base code at the bottom, code that depends on it above. | Strongly connected groups share a level; each level is one more than the highest level it depends on. Rows are ordered by folder, then by four barycenter sweeps to cut crossings. Parts in a loop are tinted red. |
| City | `4` | The Map extruded: folders are plinths, files are buildings, and close up a building opens into podiums (types) and towers (functions) standing on their own code. | Map rectangles as boxes. See [City](#city). |

**Detail** (`D`): Folders, Files, Types, Functions. It sets the nodes of Graph and Layers and the level links are lifted to. Lifting walks a node up to the chosen level: a method's call becomes its type's or file's link.

**Links** (`L`): Off; Focus (links of the set and the hovered part; Graph and Layers also show all links faintly); All (every link at the chosen detail, colored by kind). In Focus, a set's links are colored by its boundary: links inside the set violet, what it uses blue, what uses it orange. They are computed per set, so a link between two members is drawn once. In Map, links are bundled along the folder tree; in City they are skyways. Every bright link has an arrowhead at 92% along its curve (at most 600, heaviest first); `change` links have none. While you read code, links fade so they do not cover the text, and links of a readable file start from the exact line that makes them. The legend's link kinds show or hide each kind; "changes with" is off in All and on in Focus by default.

### Zoom levels in Map

| What you see | When |
| --- | --- |
| Folder names centered over their area | The folder's header is too small to read and none of its children are labeled yet. |
| File names centered over their code | The file's header is too small to read and its code lines are under 1.6 px. |
| Folder and file names in their headers | Header is 8.5–9 px or taller. All files share one header height tied to the code line height, so names appear just as code becomes a minimap. |
| Code minimap (each token a bar) with type and function labels | One code line is 1.1–7.5 px tall. |
| Code text with syntax colors, line numbers (from 10 px), issue markers in the gutter, selected ranges tinted | One code line is 7.5 px or taller. |

File text is fetched on demand when a file first needs its minimap and kept for up to 400 files.

At reading zoom the gutter shows **call sites**: `→` on lines that use something elsewhere (blue) and `←n` on declarations that `n` other places use (orange). Hovering a marked line shows only that line's links; clicking the mark selects them.

### City

```
        far: one building per file                 near: the building opens
                                                         ┌─┐    tower = function
         ┌────────┐                               ┌─┐    │ │ ┌─┐  (height = Height measure)
         │        │  shell = file               ┌─┤ ├─┬──┤ ├─┤ ├─┐
         │        │  (height = highest tower,   │ └─┘ │  └─┘ └─┘ │ podium = type, namespace, section
         │        │   or the file measure)      │     │          │
     ┌───┴────────┴───┐                     ┌───┴─────┴──────────┴───┐
     │▓ sign: cart.ts ▓│                     │▓▓ sign: cart.ts ▓▓▓▓▓▓▓│ lot = file; its top is the code page
  ═══╧════════════════╧═══ district plinth ═══╧════════════════════════╧═══ (folder depth)
```

| Part | Footprint | Height |
| --- | --- | --- |
| District | Folder rectangle | A plinth; plinths stack by folder depth. |
| Lot | File body, inset | Half a plinth, colored halfway to the background so towers stand out. |
| Sign | The file's header strip | Taller than the lot, in the file's color. |
| Podium | Each type, namespace, or section piece of the code layout | Low. |
| Tower | Each function piece | The Height measure. A method's tower stands on its class's podium. |
| Shell | The file body | The highest tower, or the file measure when closed. Glass when open. |

- **Opening.** A file opens into podiums and towers when the short side of its projected rectangle is 70 px or more, and closes under 50 px. Set members and the hovered file always open. At most 60,000 boxes; the largest files on screen open first. Open state updates at zoom end and every 200 ms during a long zoom; towers grow in 280 ms and the shell fades to glass (instant with reduced motion).
- **Height** (City only, in the bar or the View sheet): As color (default; Lines when the color is not a measure), Lines, Complexity, Churn, Age, Used by, Level, Issues. Churn and Age are known per file, so towers share their file's value. Level is the dependency level from Layers.
- **Camera.** Right-drag, Alt+drag, or a two-finger twist orbits. Before an orbit the pivot moves to the point under the screen center, with the pan adjusted so nothing jumps. `V` cycles Tilt (0.95, −0.5), Top, and Low (1.2); `,` and `.` turn 45°. Fitting projects the target's 8 corners at the current angle, and flying to a function zooms until its code is readable. Orbit resets when you switch layouts.
- **Skyline index.** A uniform grid of box footprints. Picking walks the pointer ray through the grid (a 2D DDA along its ground projection) with a slab test per box, so the top of a building is exact at any angle, and a roof hit turns into a code line. Occlusion uses the same walk from a point toward the camera: labels, roof code, arrowheads, and beacons are tested before they are drawn.
- **Labels.** District names on the plinths, file names on signs (34 px or wider, with the staged glyph `+ ~ −`), symbol names on roofs (40 × 14 px or larger), and finding beacons in the level shapes when Color is Issues or a rule is spotlighted. 16 px label grid, at most 400 labels. Labels of isolated-away parts are faint.
- **Code on the roofs.** Each roof plane is drawn with the 2D code renderer under a canvas transform built from the affine mapping, normalized so font sizes stay in real pixels. Each line sits on the roof of the deepest piece that covers it. Text and minimap thresholds match Map, measured on the vertical line height; past pitch 1.2 text falls back to minimap bars. At most 6 readable files and 400 lines per frame. **Reading pose**: when the selected file is readable, its towers ease to 15% height and the pitch eases to 0.6 rad, unless you orbited in the last 10 s.
- **Skyways.** Links run through the hubs of the folders on their tree path, higher for folders far apart, as 3D B-splines (bundling strength 0.85, 24 points). Links inside one file arc low over its lot. A link anchors on the deepest visible box, or on the exact line at reading zoom.
- **Selecting and moving.** Members get an outline from the convex hull of their projected corners. Box select projects roof centers. The grip sits on the selected file's sign or a selected symbol's roof; drop a file or folder on a district, or a type or function on another file.
- **Isolate and cutaway.** Isolate (`I`) turns everything outside the set into ghosts; the members' folder plinths stay, dimmed. While the set isn't empty, boxes between the camera and a member's roof turn to ghosts as well (recomputed 120 ms after the camera stops).

### Color

| Color | Shows | Scale |
| --- | --- | --- |
| Language | Language of each file; types violet, functions blue | Fixed hue per language for the session (first seven by size), others gray. |
| Size | Lines | Sequential blue, log scale to the 97th percentile. |
| Complexity | Branches per function; files and folders show their most complex function | Sequential blue to the 97th percentile (at least 10). |
| Churn | Commits touching the file | Sequential blue. |
| Age | Time since last change; brighter is newer | Sequential blue. |
| Used by | Distinct parts at the current Detail that link into the part | Sequential blue. |
| Issues | Worst finding inside | Status colors: high red, medium orange, low yellow, none gray. |
| Review | Reviewed, changed since review, not reviewed | Green, yellow, gray. |
| Changes | Staged new, staged edit, staged delete, uncommitted in git | Green, blue, red, dim yellow. |
| Reach | Hops from the set: through what it uses, through what uses it, or both | Blue steps 1, 2, 3+; orange steps 1, 2, 3+; violet for both; the set in the accent color. |

The legend is a control: clicking a color selects every part with that color at the current Detail (Shift adds), and dragging across a gradient selects a range while a tip shows the range and how many parts it holds. Painting and selecting share one function, `classify` in `core_sets.mjs`, so they always agree.

The palette is a validated colorblind-safe categorical set with separate dark and light steps, a single-hue sequential ramp, and reserved status colors that always come with a label or shape (diamond high, square medium, circle low).

### Sets

The set is what you work with. Every action takes it, and the Selection panel shows it.

```js
{
  nodes:  ['shop/web/src/checkout.ts#checkout'],                      // node keys
  links:  [['shop/web/src/checkout.ts', 'shop/web/src/cart.ts', '*']], // [fromKey, toKey, kind]; '*' = every kind between them
  ranges: [['shop/web/src/api.ts', 10, 18]],                          // [fileKey, from, to]
  hops:   { 'shop/web/src/app.ts': 1 },                               // set by grow; drives outline weight and Reach
  recipe: [{ seed: [...] }, { grow: 'in', depth: 2, rank: 3 }] | null,
  id, name,                                                           // when saved
}
```

| Source | Gesture | Adds |
| --- | --- | --- |
| Canvas | Click; Shift, Ctrl, or Cmd toggles; long-press adds on touch | Nodes |
| Box | Shift+drag, in every layout | Nodes at the deepest visible level, without children whose parent is fully inside |
| Lines | At reading zoom: click the gutter, Shift+click extends, Shift+drag inside one file | A range |
| Link | Click a drawn link (Shift adds). Alt+click selects the bundle between the folders around its ends; each further Alt+click goes up a level | A link |
| Call sites | Click a `→` or `←n` gutter mark | The links of that line |
| Legend | Click a color; drag across a gradient | Nodes at the current Detail |
| Find | A query, then **Select all** (Alt+Enter) | Nodes |
| Check | **Select all** on a rule | The nodes holding its findings |
| Change | **Select changed** | The staged files |
| Layers | Click a level label | The level's nodes |

**Grow** runs on the graph lifted to the current Detail. Copy and changes-with links are left out unless the operation is about them. Each step is added to the recipe.

| Operation | Key | Adds |
| --- | --- | --- |
| Uses | `]` (`}` all hops) | What the set depends on, one hop per press. Hops are recorded. |
| Used by | `[` (`{` all hops) | What depends on the set. |
| Both | Panel | Both of the above. |
| Path | Panel, palette | Every node and link on the shortest directed paths between members, both ways (2+ members; at most 200 nodes). |
| Loop | Panel, palette | The rest of a member's strongly connected group, with its links. |
| Copies | Panel, palette | The copy cluster, through raw `copy` links. |
| Tests | Panel, palette | Test files that link into the set. |
| Inside | Panel | Children down to the current Detail; a folder becomes its files. |
| Parent | `U` | The parent. |

**Queries.** Find keeps fuzzy name search; space-separated terms combine with AND. Filters: `kind:file|type|func|dir`, `in:<path>`, `lang:<id>`, `rule:<id>` or `rule:high|medium|low`, `uses:<name>`, `usedby:<name>` (lifted to the current Detail), the measures `lines`, `cx`, `nest`, `args`, `churn`, `fanin` with `< <= = >= >`, `age<Ndays`, and the states `staged`, `dirty`, `reviewed:yes|no|stale`, `test:yes|no`, `gen:no`. A bad filter shows help in the list and never throws. The list says how many parts match and offers **Select all**. An empty query lists saved sets; a query starting with `>` lists the actions for the set, disabled ones with the reason.

**Live and saved sets.** A set made by a query, rule, legend color, level, staged files, or grow keeps its recipe and replays on every `repo.model` push, so "all high findings" stays true after edits land. The Selection header says what it is live on ("Live · rule Copied code"; repeated hops read as one, "+ uses ×2"); **Freeze** drops the recipe. A set without a recipe drops keys that no longer exist. **Sets** in the Selection header saves the set by name in the ledger and lists the saved ones; saved sets also show in Find, and load when every repo they name is open (missing keys are dropped with a note).

### Interaction

| Input | Action |
| --- | --- |
| Wheel, pinch, drag | Zoom and pan. |
| Click, tap | Select. Shift, Ctrl, or Cmd adds or removes. Long-press adds on touch. A drawn link is picked within 5 px (12 px on touch). |
| Alt + click a link | Select the link bundle between the folders around it; again goes up a level. |
| Click the gutter | At reading zoom: pick a line; Shift+click extends; Shift+drag picks lines. Click a `→` or `←n` mark to select that line's links. |
| Double-click, double-tap | Zoom to the part (functions zoom until code is readable). On code that is already readable: open it in the Code sheet. |
| Shift + drag | Box select (every layout). |
| Drag the grip | A selected file or folder shows a blue grip on its header (on the sign in City); a selected type or function shows one on its band or roof. Drop it on a folder, or a symbol on a file, to stage a move. |
| Right-drag, Alt + drag, two-finger twist | City: orbit. |
| Legend | Click a color to select it; drag across a gradient to select a range; click a link kind to show or hide it. |
| Hover | Tooltip with kind, path, lines, branches, commits, issues, staged state; on a link, its ends, kinds, and weight. |
| `/`, Ctrl/Cmd + K | Find: names, queries, `>` actions. Arrow keys and Enter pick a result; Alt+Enter selects all. The last row searches file text. |
| `1`–`4` | Layouts. |
| `C` / Shift + `C` | Next / previous color. |
| `D` | Next detail. |
| `L` | Links: off, focus, all. |
| `F`, `0` | Fit everything. |
| Enter | Zoom to the selection. |
| Shift + Enter | Open the selection in the Code sheet. |
| `U`, Backspace | Select the parent. |
| `]` / `[` | Grow the set by what it uses / what uses it, one hop. `}` / `{`: all hops. |
| `X` | Explain the set (read-only agent run). |
| `A` | Actions for the set (Find in `>` mode). |
| `I` | Isolate the set. |
| `V` | City: next angle (Tilt, Top, Low). |
| `,` `.` | City: turn left or right 45°. |
| Esc | Close a popover, then the Code sheet, then clear find, the rule spotlight, isolate, and the set; then fit. |
| `R` | Mark the set reviewed (or unmark). |
| `E` | Ask the agent about the set. |
| `F2` | Rename the selected type or function. |
| `M` | Move the selected file, folder, type, or function. |
| Delete | Stage a delete of the set. |
| `O` | Open a folder. |
| `+`, `-`, arrows | Zoom and pan by steps. |
| `?` | Help. |

### Panels

- **Bar**: open; breadcrumb (the selection's path, or the folder at the center of the view; with one repo open its name is left out, and long paths fold their middle into …); find; layout; one group for detail, color, Height (City only), and links; one for fit, settings, and help.
- **Find**: names, file text, queries with **Select all**, saved sets, and `>` actions (the command palette).
- **Check**: counts by level, review progress, and findings grouped by rule (worst first). Clicking a rule spotlights it: the map dims everything else and outlines each hit in its level color. **Select all** puts the rule's findings in the set, so the Act bar offers Fix or Delete. Each finding is one row (the part, its file and line) with its note under it, and can be opened, fixed with the agent, or marked as fine.
- **Change**: staged changes (apply, discard, preview, undo, **Select changed**, open in the Code sheet), the conversation with tool steps as they happen (files the agent touches flash on the map) and one entry per one-by-one batch ("Document · one by one · 3 of 12", a row per item), then a scope line ("Scope: 3 parts · 1 link", or the whole workspace with an empty set), the mode toggle (All at once, One by one), and the prompt.
- **Selection** (opens while the set is not empty):
  - **Header**: the set's name or summary and line count, **Sets** (save this set, load or remove saved ones), **Isolate**, **Clear**, and under them what it is live on with **Freeze**.
  - **One part**: kind, path and lines, facts (lines, branches, nesting, parameters, language, commits, last change, used by, review), signature, base types, a code peek (click for the Code sheet), Zoom, Code, Editor (VS Code), findings, Uses and Used by (link kinds and counts; **+** adds a row to the set), Grow, outline (files), largest files (folders), packages (files).
  - **Several**: members grouped by folder, each with a remove ×; links; ranges; **Interface**: links inside the set, the top 14 things it uses and the top 14 that use it (click a row to select that bundle); findings by rule (click to narrow the set); Grow (only the operations that apply; the `>` palette lists the rest with the reason).
  - **A link**: both ends, kinds, weight, and the sites: each source line with its code. Click a site to fly to it.
- **Act bar**: a pill above the footer while the set is not empty, centered in the free space between the panels: the summary (opens Selection), the top five actions that fit (fewer when the space is narrow; More still lists them all), **More** (Find in `>` mode), the mode (all at once, or one by one when lit), and Clear. See [Agent reference](#agent-reference) for the ranking.
- **Toasts**: one short message at a time (errors stay until they time out), above the Act bar on wide screens and under the bar on phones.
- **Code sheet** (replaces the Diff sheet): **Code** tab with the file (staged text if staged), syntax colors, and the selected range highlighted; **Edit** turns the range (a symbol's lines, a range member, or the whole file) into a text area, and Ctrl/Cmd+S stages it. **Diff** tab (staged files): unified diff with a **Revert** button per hunk, previous and next staged file, Apply, Discard. Opened by Edit in the Act bar, Shift+Enter, double-clicking readable code, or a staged change. Files over 4,000 lines show a window around the target, with rows to show 2,000 more lines either way.
- **Dialogs**: Open (path, folder browser with git badges, open and recent repos, demo on first run), Settings (endpoint, model, key, max steps, style guide, theme, Test), Help (keys, actions from the same registry as the Act bar, mouse and touch).

The Selection list and the Act bar are keyboard-navigable, Act bar buttons show their keys in tooltips, and a polite live region announces set changes ("12 parts selected").

### Responsive layout

| Width | Layout |
| --- | --- |
| Over 1240 px | Full bar, Check/Change dock on the left, Selection on the right, legend and status (files and lines; the full counts in its tooltip) at the bottom, Act bar centered above the legend. In City up to 1560 px the breadcrumb gives way to the Height picker, and up to 1400 px so does the Detail label. |
| 761–1240 px | Breadcrumb hidden; detail, color, height, angle, and links move into a View panel opened from the bar. |
| 760 px and under | Compact bar; a bottom tab bar (View, Check, Change, Selection) opens each panel as a bottom sheet, and the Act bar shows the actions that fit above it. The map refits above the open sheet. Touch: pinch, drag, tap, double-tap, long-press, two-finger twist in City. |

## Message reference

Every message is JSON: `{ type, data, id? }`. A request with an `id` gets exactly one reply with `re: id` (type `note` with `level: "error"` on failure). Server pushes have no `re`.

### Client to server

| Type | Data | Reply |
| --- | --- | --- |
| `hello` | — | `hello` `{ config, model, stage, busy, acts, sets }` (`acts`: `[{ id, name, edits, takes, about }]`) |
| `repo.open` | `{ path }` | `config.state` |
| `repo.shut` | `{ name }` | `config.state` |
| `repo.scan` | — | `ok` |
| `repo.demo` | — | `config.state` |
| `dir.list` | `{ path }` | `dir.items` `{ path, up, repo, items: [{ name, path, repo }] }` |
| `file.read` | `{ key, staged? }` | `file.text` `{ key, text }` (staged text in preview, or with `staged`) |
| `file.links` | `{ key }` | `file.links` `{ key, out: [{ line, from, to, kind }], in: [{ from, line, to, kind }] }` (up to 2,000 sites) |
| `text.find` | `{ query, regex?, cased? }` | `find.hits` `{ query, hits: [{ key, line, text }] }` (max 400) |
| `agent.run` | `{ prompt?, act?, set?, mode? }` (`mode`: `together` or `each`; `focus: [key]` is still read as `set.nodes`) | `ok`; then `agent.step` pushes and `agent.done` |
| `agent.stop` | — | `ok` |
| `agent.reset` | — | `agent.reset` |
| `agent.test` | — | `agent.tested` `{ ok, text }` |
| `stage.diff` | `{ key }` | `stage.diff` `{ key, path, state, from, lang, hunks: [{ a, b, lines: [[sign, oldLine, newLine, text]] }] }` |
| `stage.apply` | `{ keys? }` | `note` |
| `stage.discard` | `{ keys? }` | `ok` |
| `stage.undo` | — | `note` |
| `stage.rename` | `{ key, name }` | `note` |
| `stage.move` | `{ key, to }`: file or folder → folder, or type or function → file | `note` |
| `stage.edit` | `{ key, from, to, text }` | `note` |
| `stage.hunk` | `{ key, index }` | `note` |
| `stage.delete` | `{ keys }` | `note` |
| `stage.preview` | `{ on }` | `ok` |
| `review.mark` | `{ keys, on }` | `ok` |
| `issue.waive` | `{ rule, key, on }` | `ok` |
| `config.set` | `{ endpoint?, model?, apiKey?, style?, maxTurns? }` | `config.state` |
| `set.save` | `{ set }` (with an existing `id` it overwrites; without, a new set) | `sets.state` `{ sets, id }` |
| `set.drop` | `{ id }` | `sets.state` |

### Server to client (pushes)

| Type | Data |
| --- | --- |
| `repo.model` | The model (below). Sent after every scan, watch event, apply, undo, mark, waiver, and preview toggle. |
| `scan.step` | `{ repo, done, total }` |
| `stage.state` | `{ items: [{ key, path, repo, state, adds, dels, from?, conflict? }], undo, preview }` |
| `agent.step` | `{ kind: 'start', text, act, mode, set, total? }`, `{ kind: 'text', text, index? }` (streamed), `{ kind: 'tool', name, args, note }`, or `{ kind: 'item', index, total, label, state: 'run' \| 'staged' \| 'none' \| 'error', files?, error? }` (one-by-one) |
| `agent.done` | `{ text }`, `{ error, text }`, or for one-by-one `{ text, batch: { act, total, done, items } }` |
| `sets.state` | `{ sets: [{ id, name, repo, nodes, links, ranges, recipe, at }] }` |
| `config.state` | `{ endpoint, model, style, maxTurns, recent, hasKey, repos: [{ name, root }] }` |
| `note` | `{ level: 'info' \| 'good' \| 'error', text }` |

### Client hub messages

`view.layout`, `view.paint`, `view.detail`, `view.links`, `view.theme`, `view.height`, `view.angle`, `view.kinds`; `pick.hover`, `pick.set`, `pick.link`, `pick.links`, `pick.range`, `pick.drop`, `pick.clear`; `set.grow`, `set.isolate`, `set.freeze`, `set.load`; `act.run`, `act.mode`; `find.query`, `find.text`; `check.spot`, `check.waived`; `dock.show`, `sheet.toggle`, `box.open`; `code.open`, `code.close`; `agent.ask`, `agent.reset`; `review.mark`; `stage.apply`, `stage.discard`, `stage.undo`, `stage.move`, `stage.rename`, `stage.delete`; `link.up`, `link.down`.

## Data model reference

```js
{
  nodes: [Node],               // index = id; parents come before children
  links: [[from, to, kind, weight]],   // kind indexes linkKinds
  linkKinds: ['import', 'call', 'use', 'base', 'copy', 'change'],
  issues: [{ rule, node, line, note, level, waived? }],
  rules: [{ id, name, about }],
  marks: { [key]: 'ok' | 'stale' },
  langs: [{ id, name, lines }],        // by size
  stats: { files, lines, symbols, links, issues },
  preview: boolean,
  made: epochMs,
  // not enumerable, never sent: sites = Map<"from,to,kind", [line]>
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
| Folder loops | `tangle` | Folders that depend on each other in both directions (any link kind but copies and changes-with; parent and child folders excluded). | medium |
| Unused code | `unused` | A type or function whose name appears nowhere but its own declarations. Skips tests, generated files, constructors, overrides, entry points and framework hooks (`main`, `render`, `Dispose`, `ToString`, …), names starting with `test`, `on`, `handle`, `__`. | low |
| Versioned names | `version` | Files named like `_v2`, `new`, `old`, `copy`, `backup`, `final`, `tmp`, `fixed`, `improved`, `(1)` (medium); functions and types like `formatPriceV2` when `formatPrice` also exists (low). | medium, low |
| Debug leftovers | `debug` | `console.log`, `debugger`, `print(`, `breakpoint()`, `Debug.WriteLine`, `Console.WriteLine`, `System.out.println`, `printStackTrace`, `fmt.Print`, `dbg!`/`println!`, `var_dump`, `binding.pry`, and similar, outside test files. | low |
| Commented-out code | `dead` | Runs of 3+ comment lines where most look like code. | low |
| Mixed naming | `naming` | Functions whose style (snake_case, camelCase, PascalCase) differs from the 70%+ majority in that language (camel and Pascal count as one style outside C#). | low |
| Hidden coupling | `couple` | Two files with 5 or more shared commits (ratio 0.5 or more, as for `change` links) and no import, call, use, or base link between them at file level. Test files, data files, and generated files are left out. "Changes with `x.ts` in 7 of 9 commits, but nothing links them." | low |
| Unlinked files | `lone` | Code files with no links in or out (entry-point names, data, HTML, CSS, shell, SQL, tests excluded). | low |
| Empty files | `empty` | No content (`__init__.py`, `.gitkeep` excluded). | low |
| Long lines | `wide` | Lines over 160 characters; one finding per file. | low |
| Crowded folders | `crowd` | Over 30 files directly in one folder. | low |

## Agent reference

The agent runs on the OpenAI Agents SDK (`@openai/agents`) with `OpenAIChatCompletionsModel`, so it works with any endpoint that speaks Chat Completions with tool calls (OpenRouter, OpenAI, local servers). Tracing is off. Runs stream: text deltas and tool steps are pushed to the client as they happen. The conversation history is kept until "New chat".

**Instructions** name the open repos and their size and languages, and say: read before writing, edits are staged (never claim they are applied), make the smallest complete change in the existing style, update every reference when moving or renaming, answer explain requests without editing, and end with a short bullet summary. The style guide from Settings is appended.

**Actions.** Agent actions are defined on the server (`ACTS`, next to `RULES`) and sent to the client in `hello`; the client merges them with its own actions (Ask, Review, Rename, Move, Delete, Edit, Isolate, Save set, the grow operations) into one registry that the Act bar, the `>` palette, and Help all render.

| Action | Id | Edits | Takes | Asks the agent to |
| --- | --- | --- | --- | --- |
| Explain | `explain` | no | anything | Explain what the selection does and how it connects, using the listed connections; point out anything surprising, risky, or unused. |
| Tidy | `tidy` | yes | code | Clearer names, simpler logic, no leftovers; same behavior and interface. |
| Split | `split` | yes | one file, type, or function | Split it into smaller parts where they belong and update every reference. |
| Fix findings | `fix` | yes | a set that touches open findings | Fix the listed findings without changing behavior. |
| Add tests | `tests` | yes | code | Focused unit tests in the repo's test style, covering the listed interface. |
| Document | `docs` | yes | code | Short doc comments on the public parts. |
| Decouple | `decouple` | yes | a link other than copy or changes-with | Remove the dependency (pass it in, a small interface, or move the shared part) and update every listed call site. |
| Merge copies | `merge` | yes | a copy link or a copied part | Replace the copies with one shared part. |
| Extract | `extract` | yes | two or more parts | Move them into one new folder or module that exposes only what the rest uses. |

"Code" means a file, type, function, or range (folders count through their files). The Act bar shows the top five that fit, first rule that matches: links only → Explain, Decouple or Merge; one type or function → Explain, Tidy, Split, Add tests, Rename; a group → Explain, Tidy, Add tests, Extract, Review; and Fix moves to the front when the set touches findings. The palette lists the rest, disabled ones with the reason.

**Modes.** **All at once** (default) is one run with the whole set. **One by one** runs once per member (each node, link, and range), up to 50, each with a fresh history; the conversation shows one batch entry with a row per item (✓ staged n files, – no change, ✗ error), and only the batch summary joins the chat history. Stop finishes the current item, then stops. A popover confirms one-by-one runs over 10 items and all-at-once runs over 40 members.

**The set in the prompt.** The client sends keys; the server writes the text (`setText`), so it can be tested:

```
Selection (2 parts, 1 link, 1 line range):
- function checkout at shop/web/src/checkout.ts:12-80 (69 lines, 14 branches, 6 parameters)
  finding: Complex logic: 14 branches (shop/web/src/checkout.ts:12)
- class Cart at shop/web/src/cart.ts:5-60 (56 lines)
- lines shop/web/src/api.ts:10-18
- link: checkout → Cart.pay (call ×2, at shop/web/src/checkout.ts:40, 55)
Inside the selection: …
The selection uses: …
Used from outside by: …
```

Limits: 40 members in detail (the rest summarized by folder), 20 boundary entries per side, 12 sites per link, about 12,000 characters.

**Read-only runs.** Tools are split into read tools and write tools. Actions with `edits: false` get read tools only, so Explain cannot stage an edit even if the model tries.

| Tool | Parameters | Does |
| --- | --- | --- |
| `list_files` | `dir?` | Files with line counts, including staged new files. |
| `read_file` | `path, from?, to?` | Numbered lines from staged or disk text, up to 400 per call. |
| `find_text` | `pattern, regex?` | Up to 150 matching lines across all repos. |
| `show_outline` | `path` | The file's types and functions with line ranges. |
| `find_refs` | `name` | Declarations and every line that uses the name. |
| `show_links` | `name_or_path, dir?` (`out`, `in`, `both`) | What a file, type, or function uses and what uses it, from the model's links, with kinds, counts, and `path:line` sites. |
| `write_file` | `path, text` | Stage a new or replaced file. |
| `edit_file` | `path, find, replace, all?` | Stage an exact text replacement; fails if the text is missing or not unique. |
| `move_file` | `from, to` | Stage a move. |
| `delete_file` | `path` | Stage a delete. |

The first six are read tools; the last four are write tools. Paths start with the repo name; with one repo open, plain repo-relative paths work too. The agent has no shell and cannot write outside the stage.

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
- The model on the demo repo: tree, every link kind, every planted finding, git history. Link sites match the file text and stay out of `JSON.stringify(model)`.
- Changes-with links in a temporary git repo: pairs from commits of 2–24 files only, no new import or folder loops, and `couple` flagged until an import links the files.
- Copies, loops, diff and hunks, stage apply/undo/conflict/move/delete/rename/preview, review staleness, waivers.
- Range edits (replace, insert, refuse out of range, preview, undo), reverting one hunk at a time, moving a symbol with its doc comment and decorator, saved sets kept across restarts.
- The set prompt: members, findings, inside links, and the interface with sites; its caps.
- Config precedence and key privacy.
- HTTP and WebSocket: static files, CSP, host and origin checks, path traversal, live watch updates, every new message.
- The agent end to end through the real SDK against a mock streaming endpoint: tool calls, staged edit, streamed text, set and style guide in the request, history, connection test. Actions: read-only runs get no write tools (checked in the request), one by one makes a run per item with a fresh history and one summary, stop finishes the current item, and `show_links` lists kinds and sites.

`sets.test.mjs` (`node --test`, no browser) runs on the demo model: the index, parts at a rank, lifted graphs without copies or changes-with, levels, grow out and in with hops, path, loop, copies, tests, inside, the boundary, reach, used by, query parsing with help for bad input, every filter, `classify` for every color with matching legend picks, link member expansion, and recipe replay on a rebuilt model.

`client.test.mjs` (Playwright, `node --test`) starts a server with no repos and a mock model, then drives the UI like a user and saves one image per step to `test/shots/`:

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
| `30-city-open` | Zooming into a file in City opens it: towers on a glass shell. |
| `31-city-read` | Reading pose with code on the roofs; picking a roof returns the function and line. |
| `32-city-orbit` | Alt+drag orbits around the view center; roofs still pick. |
| `33-city-links` | Skyways between towers, arrowheads, and a set's boundary colors. |
| `34-link-select` | A link clicked in Map, with its sites in the Selection panel. |
| `35-grow` | `]` grows the set hop by hop; Path between two files. |
| `36-legend-select` | Color Issues, click High: the set is the high-finding files at the current Detail. |
| `37-find-query` | `kind:func cx>10`, Alt+Enter selects them; `>` lists actions. |
| `38-act-explain` | Explain from the Act bar runs with read tools only. |
| `39-act-each` | Document one by one on 3 files: 3 batch rows, staged results. |
| `40-code-edit` | Edit a function in the Code sheet, stage it, see the Diff tab, revert a hunk. |
| `41-city-preview` | Preview keeps the layout still, shows a deleted file as a ghost, and morphs heights. |
| `42-city-move` | Dragging a building onto a district, and a tower onto another file. |
| `43-isolate` | Isolate ghosts the rest of the city; cutaway clears the view to a member. |
| `44-phone-act` | The Act bar and the Selection sheet on a phone. |

The `workflows` test then runs the seven acceptance stories end to end against the mock model, without screenshots:

| # | Goal | Steps |
| --- | --- | --- |
| W1 | What breaks if I change `Cart.total`? | Select it → Color Reach → click Used by 1 and 2 → Add tests. |
| W2 | Clean up the checkout flow. | Find `in:web/src uses:Cart` → Select all → City → Isolate → Tidy one by one → Preview → Code sheet diff → Apply. |
| W3 | Why do two folders depend on each other? | Check → Folder loops → Select all → Interface → the bundle → Decouple. |
| W4 | Read and fix the most complex function in 3D. | City, Height Complexity → double-click the tallest tower → pick lines on the roof → Tidy → Preview drops the tower. |
| W5 | Move a function where it belongs. | Drag its grip onto another file → Move + fix. |
| W6 | Merge copies. | Check → Copied code → a copy link → Merge copies. |
| W7 | Review what the agent changed as a group. | Select changed → Explain (read-only) → Code sheet → revert one hunk → Apply. |

The tests also fail on any script error in the page.

## Naming

Names are short, plain, and paired so related things read alike:

- Messages are `noun.verb`: `repo.open`/`repo.shut`, `stage.apply`/`stage.undo`, `pick.set`/`pick.clear`, `code.open`/`code.close`, `set.save`/`set.drop`.
- Functions pair a short verb with a noun: `readFacts`, `readSymbols`, `readImports`; `layMap`, `layGraph`, `layLayers`; `drawBar`, `drawDock`, `drawSelection`, `drawAct`, `drawCode`, `drawFoot`; `inkMap`, `inkFile`, `inkCode`; `pickAt`, `pickLink`, `flyTo`, `fitAll`; `showTip`/`hideTip`; in `core_sets.mjs`, `grow`, `boundary`, `classify`, `replay`; in `core_city.mjs`, `plan`, `skyBuild`, `walkLine`, `roofs`.
- UI words: Map, Graph, Layers, City; Check, Change, Selection; Find; Detail, Color, Height, Links; the set, Act bar, Code sheet; Grow, Isolate, Freeze; Apply, Discard, Undo, Preview.
- Rule names are two plain words: Big files, Long functions, Copied code, Import loops.

## Limits and performance

| Limit | Value |
| --- | --- |
| Files per repo | 40,000 |
| File size parsed | 2 MB (larger files are listed, not parsed) |
| Watched folders per repo | 4,000 |
| Git history read | Last 3,000 commits |
| Graph and Layers nodes | 4,000 (the most linked and largest are kept) |
| Links drawn | Base: 4,000 (All) or 6,000 faint (Graph and Layers in Focus); set: 4,000; hover: 800 |
| Arrowheads | 600, heaviest first |
| Text search results | 400 |
| Cached file texts in the client | 400 |
| City boxes | 60,000; files open at 70 px and close under 50 px, largest on screen first |
| City roof code | 6 readable files, 400 lines per frame, one occlusion test per line |
| City labels | 400 |
| Link sites | 12 per link in the model; 2,000 per file over `file.links` |
| Changes-with pairs | 4,000; only commits touching 2–24 files |
| Grow: Path | 200 nodes |
| Sets | 5,000 keys per list; 200 saved sets per repo |
| Set prompt | About 12,000 characters; 40 members in detail; 20 boundary entries per side; 12 sites per link |
| One-by-one batch | 50 items; confirm above 10 (or above 40 members all at once) |

Lifted graphs are cached per detail rank and model, so set operations stay cheap on large models.

Measured on a 2,000-file, 375k-line tree in this environment: first scan and model 3.7 s, page ready 2.2 s. Rescans reuse cached facts and only rebuild the model. On a synthetic 2,000-file, 120k-line TypeScript tree (11k parts, 24k links) with software WebGL: the City's own JavaScript per step (layout, skyline grid, open planner, labels) stays under about 30 ms; isolate, grow, and Find queries cost a few milliseconds each; 200 skyline picks take 2–3 ms in total.
