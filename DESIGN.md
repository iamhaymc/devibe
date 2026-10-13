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
│  └─ DOM: bar, Check, Change, Selection, Act  │        │  core_tree.mjs (optional parser)  │
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
| `app/core_route.mjs` | Link routes for Graph, Layers, and Map, with no DOM, d3, or three.js: arcs cut at circle edges; box-edge to box-edge curves (Layers ends fan out toward the other box); Map curves that leave and arrive at right angles, gutter brackets between lines of one code column, and level trunks from a code line to its file's edge. |
| `app/core_city.mjs` | City: box shader, open-building planner, skyline index (picking and occlusion), orbit and pivot, labels, roof code, skyways, hull outlines, isolate and cutaway. `makeCity(env)` takes the client's state and helpers. |
| `app/core_sets.mjs` | The set core, with no DOM, d3, or three.js: model index, lifting, strongly connected groups and levels, grow operations, set boundary, Find queries, color classes, recipe replay. Shared by the client and the server. |
| `test/sets.test.mjs` | Unit tests for `core_sets.mjs` on the demo model. |
| `test/route.test.mjs` | Unit tests for `core_route.mjs`. |
| `app/core_tree.mjs` | The optional Tree-sitter reader, with no DOM, d3, or three.js: loads grammars from `@vscode/tree-sitter-wasm` on first use, and yields symbols, typed names, and member accesses in the built-in parser's shapes. |
| `test/tree.test.mjs` | Unit tests for `core_tree.mjs` and the parser setting; skipped when the optional package is missing. |
| `test/client.test.mjs` | Playwright tests that drive every feature and save screenshots to `test/shots/`, plus the workflow tests. |
| `package.json` | Dependencies and scripts. |

Dependencies: `ws` (WebSocket server), `@openai/agents` and `openai` (agent), `d3` and `three` (served to the browser), `playwright` (tests). Optional: `@vscode/tree-sitter-wasm` (the Tree-sitter parser); devibe runs without it.

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
| Parser | `DEVIBE_PARSER` | `built-in` | `built-in` or `tree-sitter` (needs the optional `@vscode/tree-sitter-wasm` package). Changing it rescans every repo. |
| Max file size | `DEVIBE_MAX_KB` | 2000 | In KB (1,000 bytes), 1 to 100,000. Larger files are listed with an estimated line count, not read. Changing it rescans every repo. |
| Debug log | `DEVIBE_DEBUG` | off | Logs one line per scan to stderr: files, time, skipped files, files over the size limit, parse time per language. |
| Home folder | `DEVIBE_HOME` | `~/.devibe` | Holds `config.json` (mode 600) and `ledger/`. |

### Scanning

1. **List files.** Two kinds of folders are skipped:
   - **Cache and package folders** are never source, so they are skipped even when committed: `node_modules`, `bower_components`, `.yarn`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.tox`, `site-packages`, `*.egg-info`, `.next`, `.nuxt`, `.svelte-kit`, `.angular`, `.parcel-cache`, `.turbo`, `.cache`, `.gradle`, `.terraform`, `.dart_tool`, `.idea`, `.vs`, `Pods`, `DerivedData`, and a few more.
   - **Build output folders** (`dist`, `build`, `out`, `target`, `bin`, `obj`, `vendor`, `coverage`, `htmlcov`) are skipped unless their files are tracked, so a committed `bin/` of scripts still shows.
   - Inside git: tracked files (`git ls-files -c`) minus cache folders, plus untracked files that are not ignored (`git ls-files -o --exclude-standard`, with both folder kinds passed as `--exclude` so git never walks into them).
   - Outside git: a walk that skips both folder kinds and hidden folders (except `.github`), and honors every `.gitignore` on the way: globs, `**`, `!` negation, `/` anchors, and folder-only patterns; a deeper file's rules win, and a skipped folder is never entered.
   - At most 40,000 files. With `DEVIBE_DEBUG` set, each scan logs its file count, time, and what each rule skipped to stderr.
2. **Read files** 16 at a time. Binary files (a zero byte in the first 8 KB) are skipped. Files over the size limit (Settings → Max file size, default 2,000 KB) are listed with an estimated line count and marked generated and `big`; a cached file is read again when the limit moves across its size.
3. **Cache.** Facts are kept per file and reused while the file's size and modification time stay the same, so rescans only parse what changed.
4. **Git history.** The last 3,000 commits give each file a commit count (churn) and last change time. `git status` marks uncommitted files.
5. **Watch.** Each folder that holds scanned files gets a watcher (up to 4,000). Changes trigger a rescan of that repo after 350 ms of quiet, and the new model is pushed to every client. While devibe itself applies or undoes edits, watch events are ignored for 1.5 s.

### Parsing

Parsing is built in and heuristic by default: fast, dependency-free, and structural rather than compiler-exact. The **Tree-sitter** parser (Settings → Parser, or `DEVIBE_PARSER=tree-sitter`) reads exact syntax trees instead, for the languages it covers (see [Tree-sitter](#tree-sitter)).

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

#### Tree-sitter

`app/core_tree.mjs` reads syntax trees with `@vscode/tree-sitter-wasm`, an optional dependency (22 MB, no dependencies of its own: the WASM runtime and prebuilt grammars). `makeTrees()` returns a reader the Workspace makes on first use, which loads each grammar once when a scan first meets its language.

- **Languages.** C#, C and C++ (one grammar), Go, Java, JavaScript (with JSX), PHP, Python, Ruby, Rust, TypeScript, TSX. Other languages, data files, imports, words, marks, and copies keep the built-in reader.
- **Same shapes.** Each grammar handler yields the built-in parser's raw symbols (kind, form, name, offsets, body, parameters, bases, Go receiver) plus typed names and member accesses, so nesting, forms (method, ctor), branches, nesting depth, keys, linking, and checks run the same code for both parsers.
- **What it gets right** where the heuristics fall short:
  - Function-like macros (`#define SQR(x)`, Rust `macro_rules!`) are `func` symbols with the form `macro`.
  - C++ templates, default template arguments, trailing return types, and out-of-class methods (`Box<T, U>::get` is named `Box::get`).
  - Decorators and attributes stay off the name line; Python `metaclass=` is not a base.
  - Anonymous lambdas are not symbols (named ones are), however deeply they nest.
  - One-line interfaces and classes, overloads, `.d.ts` declarations, Go interface methods, and Rust unit structs.
  - Typed names come from declarations as written (`Type name`, `name: Type`, `var x = new Foo()`, `x := &Foo{}`), and member accesses from member, field, selector, and scoped expressions, never from text inside strings or comments.
- **Cache.** Facts record which parser read them (`parser: 'tree'`). Switching the setting rescans every repo, and a cached file is read again when its parser differs. A file that fails to parse falls back to the built-in reader.
- **Keys.** Symbol keys are names, so a few can differ between parsers (C++ out-of-class templates, symbols only one parser finds). Review marks and saved sets on those keys do not carry over.
- **Speed.** On a 1,200-file, 342k-line JS and TS tree, a first scan takes 3.9 s against 2.2 s with the built-in parser (parsing itself about 2.2 s). With `DEVIBE_DEBUG` set, each scan logs the parse time per language.

### Linking

Links connect node ids and carry a kind and a weight (how many times).

| Kind | From → to | How |
| --- | --- | --- |
| `import` | file → file | Import specifiers resolved per language: relative paths with extension and index probing (JS/TS `.js`→`.ts`), `@/` and `~/` aliases, Python dotted and relative modules, Java/Kotlin/Scala packages and wildcards, Go module paths from `go.mod`, Rust `mod` and `use crate::/super::`, C/C++ includes, PHP namespaces, Ruby and Lua requires, CSS imports, HTML `src`/`href`, Dart packages. Unresolved package names are listed as the file's packages. |
| `call` | symbol or file → function | A member access (`store.Find`) links to the member of the receiver's type (see [Receivers](#receivers)); any other word links to a function of that name declared elsewhere. |
| `use` | symbol or file → type | The same, for a type or namespace (`Action.Click`, `Outer.Inner`). |
| `base` | type → type | A base type name matches a declared type. |
| `copy` | symbol → symbol | Two places share a copied block (see [Copied code](#checks-reference)). |
| `change` | file ↔ file | The files change in the same commits. Only commits touching 2–24 files count (bigger ones are formatting, renames, or merges). A pair is kept when it shares 3 or more commits and the shared count is at least 35% of the smaller file's commits; the top 4,000 pairs are kept. Stored once (lower id first) and drawn without arrowheads. |

`copy` and `change` links are left out of import loops, folder loops, unlinked files, lifted graphs, Graph forces, and Layers levels.

**Sites.** For each link the model keeps up to 12 source lines: the import line, the reference line for calls and uses, the type's declaration for bases, where each copy starts, and none for `change`. Sites are a non-enumerable property of the model, so they never travel in `repo.model`; the client asks for them per file with `file.links` (up to 2,000 per file) when a file becomes readable or a link is selected.

Name matching stays precise by: only linking within one language family (JS/TS/HTML, JVM, C/C++, or the same language); ignoring names declared more than 4 times; preferring, when a name has several declarations, the same file, then an imported file, then the same folder; skipping a symbol's own name and links between a node and its own ancestors or descendants. C# and Swift have no file imports, so their structure comes from type and call links.

#### Receivers

A member access links by the receiver's type instead of by name, which cuts false links (`Math.floor` no longer reaches a repo's `Vector2.floor`) and finds missing ones (a `Find` declared in 10 classes still links when the receiver is an `IOrderStore`).

- **Facts.** Each file keeps typed names `[name, type, line]` and member accesses `[chain, name, line]`, read from the masked text (or from the syntax tree with the Tree-sitter parser).
  - Typed names: `Type name` (C#, Java, Dart, C, C++), `name: Type` (TypeScript, Python, Kotlin, Scala, Swift, Rust), `Type $name` (PHP), Go parameters, receivers, `var` and struct fields, and constructions without a type written: `x = new Foo(`, `self.x = Foo()`, `@x = Foo.new`, `x := &Foo{}`, `x, err := NewFoo()`, `let x = Foo::new()`, `make_unique<Foo>()`.
  - `@name` marks a member set through `this`/`self` in a method, or promoted by a constructor parameter (`constructor(private store: Store)`).
  - Types are reduced to one name: generics, arrays, pointers, references, and nullable marks are dropped; `Optional`, `Option`, `Box`, `Rc`, `Arc`, smart pointers, and similar wrappers are unwrapped.
  - Member accesses: `a.b`, `a?.b`, `a->b`, `A::b`, field chains (`this.store.Find`, `s.store.Find`), Ruby `@store.find`, PHP `$this->store->find()`. `this`, `self`, `Self`, `$this`, `cls` become `this`; `super`, `super()`, `base`, `parent` become `super`.
- **Receiver type.** A receiver's type is a set of type or namespace nodes, found in this order:
  - `this`: the enclosing type (or the type in a C++ `Foo::bar` or Go method name). `super`: its base types.
  - A typed name in scope: the innermost function that types it, then the enclosing type's fields, then the file. A name given several types in that scope (reassigned across branches) may be any of them.
  - A type or namespace name, for static access (`Helper.Find`, `Repo::new`, `Action.Click`).
  - Each further link of a chain is the field of that name on the types so far (or a nested type), searching base types.
- **Picking declarations.** A type name picks the nearest declarations the way names do: in the same file, the innermost enclosing scope that declares it, then imported files, then the same folder. More than 3 declarations left in different files is ambiguous, and the receiver counts as unknown. C# `partial` classes, Rust `impl` blocks, and Swift and Ruby reopened types pool their members.
- **Linking.** The member is searched in the receiver's types, then their base types (6 levels). It matches members nested in the type, Go methods with that receiver in the same folder, and C++ out-of-class definitions (`Box::area`).
  - Found: links go to those members only, even when the name is declared more than 4 times.
  - Known external type (built-in types; Capitalized names that are not declared in the repo in C#, Java, Kotlin, Scala, Swift, Dart, Python, Ruby, PHP, Rust, C++; JS globals like `Math`, `JSON`, `console`), or a class without the member (a field or property): no link.
  - Unknown receiver, a constructor function, or a type alias or interface without the member (their members are property signatures): link by name as before.

On a 1,200-file, 342k-line JS and TS tree, receivers removed about 1,400 name-matched links (mostly calls on built-ins and same-named members of unrelated classes) and added about 2,500 (inherited members, static calls, and names declared more than 4 times), for about 0.4 s more scan time.

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
| Move | A file or folder into another folder; files keep their relative layout. Or a type or function into a file: its line range, with attached attributes, decorators, and doc comments, is cut and put in the target file (inside a C# block namespace, reindented; else at the end after a blank line, two for top-level Python), and both files are staged. Imports are fixed with the move (see [Move fixes](#move-fixes)). "Move + fix" also asks the agent to check the staged changes and fix what is left. |
| Delete | Files, folders (all files inside), or symbols (their line range, plus attached attributes, decorators, and doc comments). "Remove all" in the Unused code rule deletes every unused symbol it lists. |

A symbol's line range takes the blank lines after it, or, when it ends a block or the file, the blank lines before it, so a cut leaves one gap where there were two.

#### Move fixes

A mechanical move rewrites what it breaks, so "Move only" leaves the code building, and stages those edits with the move. Files are resolved against the staged view (disk, minus staged deletes, plus staged adds), so several moves in a row build on each other.

- **JS/TS and CSS.** Relative, `@/`, `~/`, and `/` specifiers are rewritten in the moved files and in every file that imports them, in each specifier's own form: with or without an extension, `.js` for a `.ts` file, a folder for its index file, an alias kept as an alias. Files that do not mention a moved file's name or folder are not read.
- **Python.** Absolute modules (`from shop.util import fmt`, `import shop.util`) are written from the same root folder; relative ones (`from ..util import fmt`) from the file's new folder. `from pkg import module` follows a moved module, splitting the line when its names now live in different modules. `import a.b` without `as` also rewrites `a.b.name` uses in code.
- **C#.** A namespace that mirrors its folder (`App.Orders` in `Orders/`, or the root namespace in a `.csproj` folder) follows the move (`App.Billing` in `Billing/`). Qualified names (`App.Orders.Order`) follow the moved types; files that use a moved type unqualified and cannot see its new namespace (through their own namespace, a `using`, or a `global using`) get a `using`; a moved file that still uses types from its old namespace gets one for that. Only files that name a moved type or the old namespace are read.
- **Symbol moves.** The moved code takes along the imports it uses (respecified for the new file, merged out when they pointed at the new file); names it uses from the old file are imported from there (and exported in JS/TS). The old file imports the symbol back when it still uses it (exporting it in JS/TS). Files that import it by name from the old file import it from the new one (`import { a, moved }` and `from a import moved, stay` are split), and the new file drops its own import of it. A C# type that changes namespace gets the same `using` and qualified-name fixes as a moved file.
- **Not fixed.** Default and namespace imports of a moved JS symbol, `import a` then `a.moved` in Python, other languages, dynamic imports, and paths in config files. "Move + fix" leaves those to the agent. The note after a move says how many other files were fixed.

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
| Links | three.js `LineSegments2` (fat, antialiased screen-space lines) | Links as sampled curves with a dim-to-bright gradient from source to target, one group per line width, in three layers that rebuild only when their inputs change: the base (every link in All, or the faint backdrop of Graph and Layers), the set (its boundary and picked links), and the hover. Lines are opaque (colors are mixed toward the background instead of using alpha, so the round joins between segments never show as beads), 2.5–4 px for a set's links and for All (heavier links thicker), 4 px for picked links, and 1.5 px for the faint backdrop. Every layer but the faint backdrop draws a background-colored outline under its lines, so they stand clear of tiles, code, and the links below. In Graph a link is a gentle arc cut where it leaves the source circle and where it meets the target circle; in Layers it runs from the source box's edge to the target box's edge (an S-curve between rows, an arch over the tops within a row), with each end slid along the edge toward the other box so the links of one box fan out in the order of where they go. In Map it runs from edge to edge too, leaving where the line between the two boxes crosses the source's border and arriving the same way at the target's, at right angles to both sides; neighbors whose edges nearly touch get a link at least half the smaller box long, starting and ending inside them. Code ends (a line, or a symbol's first line at reading zoom) keep to the left and right sides of their column, beside the text: two lines of one column join through a bracket in the gutter to the left, and a line linked to another file runs level to its file's edge before it curves away, so links from one line share one trunk. Every route bows the same way whichever way it points, so A→B and B→A are one curve with an arrowhead at each end, never a loop (`core_route.mjs`). Routes are cached per layout, and the last few base and hover layers are kept, so hovering and selecting never re-route the base. The sampled polylines are kept for picking; each bright link also keeps its arrowhead point and direction. |
| Ink | Canvas 2D on top of WebGL | Text and outlines with native font rendering: labels, code minimaps, code text, call-site marks, issue markers, arrowheads, selection and hover outlines, drag ghost, and in City the code on the roofs. Only what is visible and large enough is drawn. |

d3 provides the layouts (`treemap`, `forceSimulation`, `quadtree`), zoom and pan (`d3-zoom`, including pinch), transitions and easing, and formatting.

World units are chosen so that one code line is about one unit, which keeps 32-bit GPU coordinates precise at any zoom. The view transform is applied to a scene group; City adds a rotation group (pitch and yaw, around a pivot) under it, so pan and zoom stay in screen space even in 3D. The camera is orthographic, so every world point maps to the screen affinely: `screen = O + x·u + y·v + z·w`, with `O`, `u`, `v`, `w` computed once per frame. Fitting, picking, roof text, and arrowheads all use this mapping.

Layout changes morph: each tile animates from its previous rectangle (or its parent's) to its new one in 720 ms. City grows buildings from the ground while the view tilts.

**Keeping it fast.** Fill colors are computed once per node for the current Color, Detail, model, and theme; Find, the rule spotlight, and Isolate only dim them, and recoloring waits for the next frame so several changes cost one pass. Per-file code facts (finding marks by line, call-site marks, the set's ranges) are cached, minimap bars are batched into one fill per token color, label sizes snap to half pixels so measured text widths are reused while zooming, and hover links follow after the pointer rests for 50 ms. Every shader compiles at startup, the analyses the first click needs (lifted links, loops, fan-in) run when the page is idle, and panels rebuild only what changed (the Check list, the legend, the agent log's entries, the tip), keeping the prompt's text and focus while the agent streams. Only small floating chrome (the bar, footer, Act bar, tips, toasts) is frosted glass; the large panels are opaque, since blurring their area behind a map that redraws every frame costs more GPU time than the map.

### Layouts

| Layout | Key | What it shows | How |
| --- | --- | --- | --- |
| Map | `1` | Repos, folders, files, and the code inside, nested and sized by lines. | Squarified treemap. Folder headers scale with folder size and are never smaller than file headers. Inside each file, code is laid out in columns of 84 characters (4 for line numbers); types and functions are bands over their line ranges, indented by depth. The treemap's shape follows the screen's shape, so phones and portrait tablets fill the screen. |
| Graph | `2` | Parts at the chosen detail pulled together by their links. | Force simulation seeded from Map positions (so related folders stay near each other), with link, charge, collision, and home forces. Up to 4,000 nodes. Over 400 nodes it runs in a worker for up to 4 s while the view stays live ("Laying out the graph…"): coming from another layout, the parts wait as small dots at their seed places, with no links, so the Map's boxes never sit behind the Graph, then move to their places when it is done (an open Graph stays up instead). Otherwise it runs in place for up to 1.1 s. A morph that starts while another is running starts from where the tiles are. Graph and Layers are kept per Detail until the Map changes, so switching back is instant. |
| Layers | `3` | Parts stacked by dependency: base code at the bottom, code that depends on it above. | Strongly connected groups share a level; each level is one more than the highest level it depends on. Rows are ordered by folder, then by four barycenter sweeps to cut crossings. Parts in a loop are tinted red. |
| City | `4` | The Map extruded: folders are plinths, files are buildings, and close up a building opens into podiums (types) and towers (functions) standing on their own code. | Map rectangles as boxes. See [City](#city). |

**Detail** (`D`): Folders, Files, Types, Functions. It sets the nodes of Graph and Layers and the level links are lifted to. Lifting walks a node up to the chosen level: a method's call becomes its type's or file's link.

**Links** (`L`): Off; Focus (links of the set and the hovered part; Graph and Layers also show all links faintly); All (every link at the chosen detail, colored by kind). In Focus, a set's links are colored by its boundary: links inside the set violet, what it uses blue, what uses it orange. They are computed per set, so a link between two members is drawn once. A link never ends on a part that holds its other end: where lifting would swallow it (a method's link into its own file), the end stays at the part just below the shared one (the sibling method or type). In Map at reading zoom, set and hover links end at the symbol they use, on its first line, so the arrow points at its definition. All links share Focus links' routes and style (width, outline, strength), colored by kind instead of by boundary; in City they are skyways. Every bright link has an arrowhead sized to its line (at most 600, heaviest first): in the flat layouts its tip touches the target's edge; in City it sits 92% along the curve. `change` links have none. A bright link that runs off the free part of the screen gets a label where it leaves (`→ cart.ts › total()` for a target, `← Program.cs` for a source), outlined in the link's color; labels that meet stack along the edge (16 at most). Text is drawn over links, so they never hide it. Links of a readable file start from the exact line that makes them. The Links pill's kinds (in the footer, beside the color legend) show or hide each kind; "changes with" is off in All and on in Focus by default.

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
- **Height** (City only, in the View panel): As color (default; Lines when the color is not a measure), Lines, Complexity, Churn, Age, Used by, Level, Issues. Churn and Age are known per file, so towers share their file's value. Level is the dependency level from Layers.
- **Camera.** Right-drag, Alt+drag, or a two-finger twist orbits. Before an orbit the pivot moves to the point under the screen center, with the pan adjusted so nothing jumps. `V` cycles Tilt (0.95, −0.5), Top, and Low (1.2); `,` and `.` turn 45°. Fitting projects the target's 8 corners at the current angle, and flying to a function zooms until its code is readable. Orbit resets when you switch layouts.
- **Skyline index.** A uniform grid of box footprints. Picking walks the pointer ray through the grid (a 2D DDA along its ground projection) with a slab test per box, so the top of a building is exact at any angle, and a roof hit turns into a code line. Occlusion uses the same walk from a point toward the camera: labels, roof code, arrowheads, and beacons are tested before they are drawn.
- **Labels.** District names on the plinths, file names on signs (34 px or wider, with the staged glyph `+ ~ −`), symbol names on roofs (40 × 14 px or larger, each after its glyph), and finding beacons in the level shapes when Color is Issues or a rule is spotlighted. 16 px label grid, at most 400 labels. Labels of isolated-away parts are faint.
- **Code on the roofs.** Each roof plane is drawn with the 2D code renderer under a canvas transform built from the affine mapping, normalized so font sizes stay in real pixels. Each line sits on the roof of the deepest piece that covers it. Text and minimap thresholds match Map, measured on the vertical line height; past pitch 1.2 text falls back to minimap bars. At most 6 readable files and 400 lines per frame. **Reading pose**: when the selected file is readable, its towers ease to 15% height and the pitch eases to 0.6 rad, unless you orbited in the last 10 s.
- **Skyways.** Links run through the hubs of the folders on their tree path, higher for folders far apart, as 3D B-splines (bundling strength 0.85, 8 points per span, 24 at least). Links inside one file arc low over its lot. A link anchors on the deepest visible box, or on the exact line at reading zoom.
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
| Legend | Click a color to select it; drag across a gradient to select a range. In the Links pill beside it, click a link kind to show or hide it. |
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

- **Bar**: three columns, with Find centered on the window: the two sides share one width (`--side`, the wider of the brand and the tools, set by `sizeBar`), so the breadcrumb shrinks before Find moves. The brand (opens a folder, `O`); breadcrumb (the selection's path, or the folder at the center of the view; with one repo open its name is left out, and long paths fold their middle into …); find; the View toggle with fit; the other panel toggles (Check, Selection, Change); settings and help. View, Check, and Change open that panel in the dock and a second click closes it; Selection shows or hides the Selection panel; each toggle shows pressed while its panel is open. Layout, detail, color, Height (City only), angle, and links are in the View panel (keys `1`–`4`, `D`, `C`, `L`, `V` still work). The View panel repeats open, fit, and help only on phones, where the bar hides them.
- **Find**: names, file text, queries with **Select all**, saved sets, and `>` actions (the command palette).
- **Check**: counts by level, review progress, and findings grouped by rule (worst first). Clicking a rule spotlights it: the map dims everything else and outlines each hit in its level color. **Select all** puts the rule's findings in the set, so the Act bar offers Fix or Delete. Each finding is one row (the part, its file and line) with its note under it, and can be opened, fixed with the agent, or marked as fine.
- **Change**: staged changes (apply, discard, preview, undo, **Select changed**, open in the Code sheet), the conversation with tool steps as they happen (files the agent touches flash on the map) and one entry per one-by-one batch ("Document · one by one · 3 of 12", a row per item), then a scope line ("Scope: 3 parts · 1 link", or the whole workspace with an empty set), the mode toggle (All at once, One by one), and the prompt.
- **Selection** (opens while the set is not empty): its bar toggle turns it off, and off stays off through new selections until toggled again (`info` in local storage: `auto`, `open`, or `shut`). Toggled on with nothing selected, it opens empty so **Sets** can load a saved set; its ✕ then closes it until the next selection.
  - **Header**: the set's name or summary and line count, **Sets** (save this set, load or remove saved ones), **Isolate**, **Clear** (✕; **Close** when opened empty), and under them what it is live on with **Freeze**.
  - **One part**: kind, path and lines, facts (lines, branches, nesting, parameters, language, commits, last change, used by, review), signature, base types, a code peek (click for the Code sheet), Zoom, Code, Editor (VS Code), findings, Uses and Used by (link kinds and counts; **+** adds a row to the set), Grow, outline (files), largest files (folders), packages (files).
  - **Several**: members grouped by folder, each with a remove ×; links; ranges; **Interface**: links inside the set, the top 14 things it uses and the top 14 that use it (click a row to select that bundle); findings by rule (click to narrow the set); Grow (only the operations that apply; the `>` palette lists the rest with the reason).
  - **A link**: both ends, kinds, weight, and the sites: each source line with its code. Click a site to fly to it.
- **Act bar**: a pill above the footer while the set is not empty, centered on the window and no wider than the free space on either side of the middle, so it never runs under the panels: the summary (opens Selection), the top five actions that fit (fewer when the space is narrow; More still lists them all), **More** (Find in `>` mode), the mode (all at once, or one by one when lit), and Clear. See [Agent reference](#agent-reference) for the ranking.
- **Toasts**: one short message at a time (errors stay until they time out), above the Act bar on wide screens and under the bar on phones.
- **Code sheet** (replaces the Diff sheet): **Code** tab with the file (staged text if staged), syntax colors, and the selected range highlighted; **Edit** turns the range (a symbol's lines, a range member, or the whole file) into a text area, and Ctrl/Cmd+S stages it. **Diff** tab (staged files): unified diff with a **Revert** button per hunk, previous and next staged file, Apply, Discard. Opened by Edit in the Act bar, Shift+Enter, double-clicking readable code, or a staged change. Files over 4,000 lines show a window around the target, with rows to show 2,000 more lines either way.
- **Dialogs**: Open (path, folder browser with git badges, open and recent repos, demo on first run), Settings (endpoint, model, key, max steps, style guide, theme, parser, max file size, Test), Help (keys, actions from the same registry as the Act bar, mouse and touch). Each closes with the ✕ in its top-right corner, `Escape`, or a click on the backdrop that starts and ends there (selecting a field's text and letting go past the edge does not close it). The ✕ is the dialog's last child, so the first field or button still gets the initial focus.

The Selection list and the Act bar are keyboard-navigable, Act bar buttons show their keys in tooltips, and a polite live region announces set changes ("12 parts selected").

### Responsive layout

| Width | Layout |
| --- | --- |
| Over 1240 px | Full bar, the dock on the left (View, Check, or Change, each from its bar toggle, or none), Selection on the right (its own bar toggle), at the bottom the color legend, the Links pill (directions and kind toggles; hidden while links are off or none are drawn), and status on the right (files and lines; the full counts in its tooltip), Act bar centered above the legend. |
| 761–1240 px | Breadcrumb hidden; otherwise the same bar. |
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
| `config.set` | `{ endpoint?, model?, apiKey?, style?, maxTurns?, parser?, maxKB? }` | `config.state` (after a rescan when `parser` or `maxKB` changed) |
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
| `config.state` | `{ endpoint, model, style, maxTurns, parser, maxKB, trees: { ready, langs }, recent, hasKey, repos: [{ name, root }] }`; `trees.ready` says the Tree-sitter package is installed, `langs` names the languages it covers. |
| `note` | `{ level: 'info' \| 'good' \| 'error', text }` |

### Client hub messages

`view.layout`, `view.paint`, `view.detail`, `view.links`, `view.theme`, `view.height`, `view.angle`, `view.kinds`; `pick.hover`, `pick.set`, `pick.link`, `pick.links`, `pick.range`, `pick.drop`, `pick.clear`; `set.grow`, `set.isolate`, `set.freeze`, `set.load`; `act.run`, `act.mode`; `find.query`, `find.text`; `check.spot`, `check.waived`; `dock.show`, `info.show`, `sheet.toggle`, `box.open`; `code.open`, `code.close`; `agent.ask`, `agent.reset`; `review.mark`; `stage.apply`, `stage.discard`, `stage.undo`, `stage.move`, `stage.rename`, `stage.delete`; `link.up`, `link.down`.

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
| `of` | Receiver type of a Go method declared in another file than its type. |
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
- Scanning: `.gitignore` rules (globs, `**`, negation, anchors, folder-only, nested files), cache and build folders outside git, and in git (cache folders skipped even when tracked, build folders only when untracked).
- Receivers: typed names and member accesses per language; calls linked by receiver type in C#, TypeScript, Python, Go, C++, Rust (fields, `this`, parameters, constructor parameter properties, base classes, static access, external types, names declared more than 4 times); constructor functions, namespaces, same-named types in other files, and partial classes.
- The model on the demo repo: tree, every link kind, every planted finding, git history. Link sites match the file text and stay out of `JSON.stringify(model)`.
- Changes-with links in a temporary git repo: pairs from commits of 2–24 files only, no new import or folder loops, and `couple` flagged until an import links the files.
- Copies, loops, diff and hunks, stage apply/undo/conflict/move/delete/rename/preview, review staleness, waivers.
- Range edits (replace, insert, refuse out of range, preview, undo), reverting one hunk at a time, moving a symbol with its doc comment and decorator, saved sets kept across restarts.
- Move fixes on small repos on disk: JS/TS moves in a row (relative, `.js`, folder index, `@/` alias, a staged file fixed again, folder moves); Python absolute and relative modules, `from pkg import module`, and qualified uses; C# namespaces following folders with usings and qualified names; symbol moves in JS/TS, Python, and C# (imports carried along, imported back and exported, importers split, block namespace placement).
- The set prompt: members, findings, inside links, and the interface with sites; its caps.
- Config precedence and key privacy; the file size limit from env or file, clamped, and a rescan that lists files over it unread and reads them again once it is raised.
- HTTP and WebSocket: static files, CSP, host and origin checks, path traversal, live watch updates, every new message.
- The agent end to end through the real SDK against a mock streaming endpoint: tool calls, staged edit, streamed text, set and style guide in the request, history, connection test. Actions: read-only runs get no write tools (checked in the request), one by one makes a run per item with a fresh history and one summary, stop finishes the current item, and `show_links` lists kinds and sites.

`sets.test.mjs` (`node --test`, no browser) runs on the demo model: the index, parts at a rank, lifted graphs without copies or changes-with, levels, grow out and in with hops, path, loop, copies, tests, inside, the boundary, reach, used by, query parsing with help for bad input, every filter, `classify` for every color with matching legend picks, link member expansion, and recipe replay on a rebuilt model.

`tree.test.mjs` (`node --test`, no browser; skipped without the optional package) loads every grammar and checks Tree-sitter symbols where heuristics fall short (decorators, nested lambdas, macros, templates and out-of-class methods, unit structs, one-line interfaces) for every covered language, receiver facts and links from the tree, and the workspace's parser setting: tree facts per covered language, data files kept built in, no reparse without a change, and back.

`route.test.mjs` (`node --test`, no browser) checks the link routes: Graph arcs end on both circle edges past the gap, arrive heading into the target, bow to one side, never turn back, and draw A→B and B→A as one curve; Layers curves leave the bottom edge and land on the top edge (or the reverse going up), fan out from one box in the order of their targets, arch over the tops within a row, and are one curve both ways; Map routes leave by the side facing the target (code ends beside their line), run border to border at right angles, stay long enough between neighbors to show direction, bracket through the gutter, run level from a code line to its file's edge, cross folder borders between the folders, and are one curve both ways.

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
- Glyphs stand for symbol forms wherever a label has little room (Map code labels, City roofs, the Outline, same-named Uses and Used by): `ƒ` function or method, `⊕` constructor, `◆` class or object, `◇` interface, protocol, or trait, `■` struct, record, or union, `≡` enum, `◈` impl, extension, or mixin, `τ` type alias, `{}` namespace or module, `▦` table, `▤` view, `#` heading, `•` key. `GLYPHS` and `glyphOf` live in `core_sets.mjs` (unknown forms fall back by kind); tooltips, the Selection header, and Help → Symbols spell them out.
- UI words: Map, Graph, Layers, City; Check, Change, Selection; Find; Detail, Color, Height, Links; the set, Act bar, Code sheet; Grow, Isolate, Freeze; Apply, Discard, Undo, Preview.
- Rule names are two plain words: Big files, Long functions, Copied code, Import loops.

## Limits and performance

| Limit | Value |
| --- | --- |
| Files per repo | 40,000 |
| File size parsed | 2,000 KB by default, set in Settings → Max file size (larger files are listed, not parsed) |
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
