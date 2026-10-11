# Plan: City 2.0, Sets, and one Act workflow

Status: proposal. Touches `client.mjs` (plus two new client modules), `server.mjs`, `client.css`, `client.html`, tests, and docs.

## Contents

1. [Summary](#1-summary)
2. [Workflows this plan must make easy](#2-workflows-this-plan-must-make-easy)
3. [Where it stands today](#3-where-it-stands-today)
4. [Design rules and consolidation](#4-design-rules-and-consolidation)
5. [Sets](#5-sets)
6. [Act](#6-act)
7. [Connections](#7-connections)
8. [City 2.0](#8-city-20)
9. [Code sheet and stage](#9-code-sheet-and-stage)
10. [Preview with a stable layout](#10-preview-with-a-stable-layout)
11. [UI by surface](#11-ui-by-surface)
12. [Server changes](#12-server-changes)
13. [Client structure and state](#13-client-structure-and-state)
14. [Limits and performance](#14-limits-and-performance)
15. [Testing](#15-testing)
16. [Delivery phases](#16-delivery-phases)
17. [Risks](#17-risks)
18. [Left out on purpose](#18-left-out-on-purpose)
19. [Open questions](#19-open-questions)

---

## 1. Summary

Three changes on one spine.

1. **City 2.0.** Buildings open as you zoom in. A file's lot holds podiums (types) and towers (functions) standing on the exact 2D code layout, so the roof of each tower is the code of that function. You can read code on the roofs, pick lines, watch calls land on the function they call, orbit, isolate, and drag to move. Because the City is the Map extruded, picking, selection, links, and edits share one geometry with 2D.
2. **Sets.** The selection becomes a *set* of parts, links, and line ranges. You make a set by clicking, box-selecting, clicking a link, clicking a legend color, typing a find query, picking a Check rule, taking the staged changes, or growing along links (uses, used by, path, loop, copies, tests). Sets can be saved, and recipes keep them correct after rescans.
3. **Act.** One Act bar applies any operation to the current set: Explain, Tidy, Split, Fix, Add tests, Document, Decouple, Merge copies, Extract, Review, Rename, Move, Delete, Edit, Ask. It runs on the whole set at once or on each part one at a time. The server builds the prompt from the set: members, findings, links inside the set, and the set's interface to the rest of the code, with call sites.

The spine is **See → Select → Act → Review**. Every feature below plugs into one of those four steps, and several existing controls merge into fewer, stronger ones (§4).

---

## 2. Workflows this plan must make easy

These are the acceptance stories. Each one becomes a browser test (§15).

| # | Goal | Steps after this plan |
| --- | --- | --- |
| W1 | "What breaks if I change `Cart.pay`?" | Select `Cart.pay` → Color **Reach** → legend **Used by 1–2** (click) → Act: **Add tests** or **Explain**. |
| W2 | "Clean up the checkout flow." | Find `in:web/src uses:Cart` → **Select all** (Alt+Enter) → `4` City → `I` isolate → Act: **Tidy**, **One by one** → Preview (the skyline morphs) → Code sheet diffs → Apply. |
| W3 | "Why do `web` and `core` depend on each other?" | Check → **Folder loops** → **Select all** → Selection panel **Interface** → click the `web → core` bundle → Act: **Decouple**. |
| W4 | "Read and fix the most complex function, in 3D." | City, Height **Complexity** → double-click the tallest tower → reading pose, code on the roof → Shift-drag lines 40–55 → Act: **Tidy** (or **Edit** in the Code sheet) → Preview shows the tower drop. |
| W5 | "Move this function where it belongs." | Select the tower → drag its grip onto another file's lot → **Move + fix**. Works the same in Map. |
| W6 | "Merge these copies." | Check → **Copied code** → click a copy link → Act: **Merge copies**. |
| W7 | "Review what the agent changed, as a group." | Change panel → **Select changed** → Act: **Explain** (read-only) → Code sheet → revert one hunk → Apply. |

---

## 3. Where it stands today

Facts from the code that shape this plan.

- **City shows no contents.** `layCity` (client.mjs:707) extrudes folder plinths and one box per file from the Map layout. Symbols are dropped. Height is the color measure.
- **City rendering is CPU-bound for motion.** Boxes are an `InstancedMesh` with Lambert lighting (client.mjs:808). Every morph frame writes a `Matrix4` per instance on the CPU (client.mjs:911).
- **City picking and editing are limited.** Picking raycasts the boxes and returns file ids only: no lines, no symbols (client.mjs:1802). Box select is off in City (client.mjs:2062). The grip and drag-to-move work in Map only (client.mjs:1955). The camera is a fixed tilt, pitch 0.95 and yaw −0.5 (client.mjs:960). TODO.md lists orbit and top-of-building picking as gaps.
- **City links stop at files.** Links are arcs between file roofs (client.mjs:1118), always lifted to the file. In Map they bundle along the folder tree (client.mjs:1094). Links can't be clicked anywhere. Direction shows only as a dim-to-bright gradient.
- **Links don't say where they happen.** A link is `[from, to, kind, weight]` (server.mjs:1191). Call and use links are found per line (server.mjs:1033), but that line is thrown away.
- **Selection is a flat list.** `state.sel` holds node keys only. The only ways to make a group are Shift/Ctrl-click and box select, and box select works only outside City.
- **Operations are scattered across four places:**
  - Quick asks and Focus chips in Change (client.mjs:2374–2393)
  - Info buttons (client.mjs:2576)
  - Check rule buttons (client.mjs:2341)
  - Keys

  Prompts are client-side strings (`QUICK`). The agent's focus text lists members and findings but no connections (server.mjs:2117).
- **The Diff sheet is read-only.** There is no hunk control and no direct editing (TODO.md).

Foundations to keep:
- The message hub.
- Stable node keys.
- Staged edits with preview and undo.
- The Map layout with code columns and symbol pieces.
- The **orthographic camera**. Under an orthographic camera every plane maps to the screen by an affine transform, so the existing Canvas 2D code renderer can draw on 3D roofs without a new text engine (§8.8).

---

## 4. Design rules and consolidation

Rules:

- **One set, one Act bar.** Every operation takes the current set. No operation keeps its own selection.
- **Every color is a group.** Clicking a legend color selects everything with that color. Dragging across a gradient selects a range.
- **One geometry.** The City is the Map extruded, never a second layout to keep in sync.
- **Zoom is the detail control, in 3D too.** Far away you see buildings. Closer, buildings open into towers. Closest, the code is on the roofs.
- **Group selections pick parts at the current Detail** (Folders, Files, Types, Functions). This one rule covers the legend, queries, and grow.
- **A new control must remove an old one.**

Consolidation:

| Today | After |
| --- | --- |
| Quick asks section in Change | Act bar |
| Focus chips in Change | Selection panel; one scope line above the prompt |
| Action buttons in Info | Act bar. Info keeps Zoom and the Editor link. |
| Rule actions "Fix with agent" and "Remove all" | Rule action **Select all**, then the Act bar offers Fix or Delete |
| Diff sheet | **Code sheet**: Code and Diff tabs, edit in place, revert a hunk |
| No command palette | Find box: type `>` to list actions for the set |
| Legend, display only | Legend selects groups by color and turns link kinds on or off |
| City height = color measure | A **Height** picker that shows in City only. Default: "Same as color". |
| Info panel | **Selection** panel: the same place, now built for sets |

---

## 5. Sets

### 5.1 Data

```js
// state.set: what the user is working with.
{
  nodes:  ['shop/web/src/checkout.ts#checkout', 'shop/web/src/cart.ts#Cart'],      // node keys
  links:  [['shop/web/src/checkout.ts#checkout', 'shop/web/src/cart.ts#Cart.pay', 'call']], // [fromKey, toKey, kind | '*']
  ranges: [['shop/web/src/api.ts', 10, 18]],                                         // [fileKey, from, to]
  hops:   { 'shop/web/src/app.ts': 1 },     // optional; set by grow; drives outline weight and the Reach legend
  recipe: [{ seed: ['…'] }, { grow: 'in', depth: 2, rank: 3 }] | null,
  id: null | 'k3f9…', name: null | 'Checkout flow',                                  // set when saved
}
```

- `selIds()` keeps working and returns the ids of `set.nodes`, so most existing code is untouched.
- A link member whose kind is `'*'` means "every link from under `fromKey` to under `toKey`". This is what you get when you click a drawn link that merges several kinds.
- A range member is a line selection inside one file.

### 5.2 Ways to make a set

| Source | Gesture | Result |
| --- | --- | --- |
| Canvas, any layout | Click; Shift/Ctrl/Cmd-click toggles; long-press adds on touch | Node members |
| Box | Shift-drag, now in **every** layout including City | Node members at the deepest visible level, dropping children whose parent is fully inside (today's Map rule) |
| Lines | At reading zoom: click the gutter to pick a line, Shift-click to extend, Shift-drag inside one file's code | A range member |
| Link | Click a drawn link; Shift-click adds | A link member |
| Link bundle | Alt-click a link. Each further Alt-click goes up one folder level. | A link member between the two ends' parent containers |
| Legend | Click a category key (language, issue level, review state, change state, reach hop); drag across a gradient | Nodes at the current Detail with that color or value |
| Find | Query (§5.4), then **Select all** (Alt+Enter) | Nodes; the recipe stores the query |
| Check | **Select all** on a rule | Nodes that hold the findings; recipe `rule:<id>` |
| Staged changes | **Select changed** in Change | The changed files; recipe `staged` |
| Layers | Click a level band label | Every node on that level |
| Grow | `]` `[` keys, or buttons in the Selection panel | See §5.3 |

### 5.3 Grow operations

All grow operations run on the graph lifted to the current Detail rank. Copy and changes-with links are left out unless the operation is about them. Each one appends a recipe step.

| Operation | Key | Needs | Adds |
| --- | --- | --- | --- |
| Uses | `]` (`}` = all hops) | Any | Parts the set depends on, one hop per press. Hops are recorded. |
| Used by | `[` (`{` = all hops) | Any | Parts that depend on the set. Hops are recorded. |
| Both | Panel | Any | Both of the above |
| Path | Panel, palette | 2+ nodes | Every node and link on the shortest directed paths between members, both ways. Capped at 200 nodes. |
| Loop | Panel, palette | A member inside a strongly connected group | The rest of the group and its links |
| Copies | Panel, palette | A member with copy links | The copy cluster, through raw `copy` links |
| Tests | Panel, palette | Any | Test files (`node.test`) that link into the set |
| Inside | Panel | Folders or files | Children down to the current Detail. A folder becomes its files. |
| Parent | `U` (exists) | Any | The parent. Today's behavior stays. |

### 5.4 Queries in Find

Find keeps fuzzy name search. Space-separated terms combine with AND, and filters are `name:value` or `measure<op>number`.

| Filter | Meaning |
| --- | --- |
| `kind:file\|type\|func\|dir` | Node kind |
| `in:<path or folder name>` | Under a folder or path prefix |
| `lang:<id>` | Language |
| `rule:<id>` or `rule:high\|medium\|low` | Has an open finding of that rule or level |
| `uses:<name>` / `usedby:<name>` | Links to or from a part with that name, lifted to the current Detail |
| `lines>N` `cx>N` `nest>N` `args>N` `churn>N` `fanin>N` `age<Ndays` | Measures |
| `staged` `dirty` `reviewed:yes\|no\|stale` `test:yes\|no` `gen:no` | States |

- The find list shows "37 parts match" and a **Select all** row (Alt+Enter).
- An empty query lists saved sets under a **Sets** group.
- Starting the query with `>` lists actions for the current set, so Find doubles as the command palette and no separate palette is needed.
- A bad filter shows inline help in the list and never throws.

### 5.5 Recipes and saved sets

- **Live sets.** When the active set has a recipe, it replays on every `repo.model` push, so "all high findings" stays true after the agent's edits are applied. A set without a recipe just drops keys that no longer exist, as `state.sel` does today.
- **Saving.** **Save set** in the Selection panel asks for a name. Sets are stored in the ledger of the repo that holds the first member, under `sets: { id: { name, nodes, links, ranges, recipe, at } }`. A saved set loads only when every repo it names is open; missing keys are dropped with a note.
- **Finding saved sets.** They show in Find (Sets group) and in a menu in the Selection panel header. There is no separate Sets panel.

### 5.6 Showing a set

| Layout | Members | Everything else | Links |
| --- | --- | --- | --- |
| Map, Graph, Layers | Accent outline (exists); outline weight drops with `hops` | **Isolate** (`I`) dims everything else, reusing the rule spotlight's `makeLit` | The set's boundary: **inside** links violet, **uses outside** blue, **used from outside** orange. Computed per set, not per member, so inside links aren't drawn twice. |
| City | Silhouette outline (§8.10) | Isolate turns everything else into translucent ghosts; cutaway ghosts whatever blocks the view of the set (§8.11) | The same boundary colors, drawn as skyways |

### 5.7 Selection panel (was Info)

It sits where Info is and opens when the set is not empty.

- **Header**: the set name (or "3 parts · 1 link"), line count, saved-sets menu, **Save**, **Isolate**, **Clear**.
- **One node**: today's title, facts, signature, base types, findings, Uses / Used by, outline, largest files, and packages. Added: a **Code** peek showing the symbol's first 12 lines with syntax colors; click it to open the Code sheet. Each Uses / Used by row gets a **+** button that adds the row to the set; clicking the row still selects it alone.
- **Several members**:
  - Members grouped by folder, each with a remove ×.
  - Links listed separately.
  - **Interface**: links inside the set, the top 14 things it uses outside, and the top 14 things outside that use it. Click a row to select that link bundle.
  - **Findings**: counts by rule; click to narrow the set to those.
  - **Grow** row: Uses · Used by · Both · Path · Loop · Copies · Tests · Inside.
- **A link**: both ends, the kinds, the weight, and the **sites**: each source line with a code snippet (from `file.links` and the cached file text). Click a site to fly to it.

The Act bar (§6.2) carries the actions, so the panel has no action row besides Zoom and Editor.

---

## 6. Act

### 6.1 Registry

**Agent actions are defined on the server**, next to `RULES`, and sent in `hello` as `acts`. Prompts can then be tested on the server, and the client keeps only display data.

```js
export const ACTS = [
  { id: 'explain',  name: 'Explain',      edits: false, takes: 'any',    prompt: 'Explain what the selection does and how its parts work together. Use the connections listed below: say how it depends on the rest and what depends on it. Point out anything surprising, risky, or unused. Do not edit.' },
  { id: 'tidy',     name: 'Tidy',         edits: true,  takes: 'code',   prompt: 'Tidy the selection: clearer names, simpler logic, no dead code or leftovers. Keep behavior and the interface listed below the same.' },
  { id: 'split',    name: 'Split',        edits: true,  takes: 'one',    prompt: 'Split the selection into smaller, well-named parts. Put each part where it belongs. Update every reference listed below.' },
  { id: 'fix',      name: 'Fix findings', edits: true,  takes: 'issues', prompt: 'Fix the findings listed for the selection. Keep behavior the same.' },
  { id: 'tests',    name: 'Add tests',    edits: true,  takes: 'code',   prompt: 'Add focused unit tests for the selection, in the test style this repo already uses. Cover the interface listed below.' },
  { id: 'docs',     name: 'Document',     edits: true,  takes: 'code',   prompt: 'Add short doc comments to the public parts of the selection. Plain words, no filler.' },
  { id: 'decouple', name: 'Decouple',     edits: true,  takes: 'link',   prompt: 'Remove the dependency in the selected links without changing behavior: pass it in, put it behind a small interface, or move the shared part where both sides can use it. Update every call site listed.' },
  { id: 'merge',    name: 'Merge copies', edits: true,  takes: 'copy',   prompt: 'The selected places hold copied code. Replace the copies with one shared function or type in the best place and use it from each place. Keep behavior the same.' },
  { id: 'extract',  name: 'Extract',      edits: true,  takes: 'group',  prompt: 'Move the selected parts into one new, well-named folder or module. Expose only what the rest of the code uses (the "used from outside" list). Update every import and reference.' },
];
```

What `takes` accepts:
- `any`: the set is not empty.
- `code`: a file, type, function, or range (folders expand to their files).
- `one`: exactly one file, type, or function.
- `issues`: the set touches an open finding.
- `link`: at least one non-copy, non-changes-with link.
- `copy`: a copy link, or a node with a `copy` finding.
- `group`: two or more nodes.

**Client actions** run without the agent and live only in the client registry:

| Action | Key |
| --- | --- |
| Ask | `E` |
| Review | `R` |
| Rename | `F2` |
| Move | `M` |
| Delete | `Del` |
| Edit (Code sheet) | `Shift+Enter` |
| Isolate | `I` |
| Save set | — |
| Grow: Uses, Used by, Path, Loop, Copies, Tests | `]`, `[`, palette |

One array `ACTIONS` merges the server `acts` with these. The Act bar, the `>` palette, and the help dialog all render from that one array, so an action is defined in one place.

### 6.2 Act bar

- **Position.** A pill centered above the footer that shows while the set is not empty. On phones it sits above the tab bar and scrolls sideways.
- **Contents.** A summary ("3 parts · 1 link", which opens the Selection panel), the top five actions that apply, **More** (opens Find in `>` mode), a mode toggle, and Clear.
- **Ranking**, first rule that matches wins:
  1. Links only: Explain, Decouple or Merge, then the rest.
  2. One symbol: Explain, Tidy, Split, Add tests, Rename.
  3. A group: Explain, Tidy, Add tests, Extract, Review.
  4. If the set touches findings, **Fix** moves to first place.
- Actions that don't apply aren't shown in the bar. The palette shows them disabled, with the reason ("Needs one function or file").

### 6.3 Scope and modes

- **All at once** (default): one agent run with the whole set in focus.
- **One by one**: one run per member: each node, link, and range. Up to 50 per batch. Each run starts with a fresh history, so the batch doesn't flood the chat. The conversation shows one batch entry: "Document · one by one · 3 of 12", with a row per item (✓ staged 2 files, – no change, ✗ error). **Stop** finishes the current item, then stops.
- **Confirm before big runs.** A popover asks first when one-by-one would run more than 10 items, or all-at-once has more than 40 members.
- **Ask** (`E`) opens Change with the prompt focused. A scope line ("Scope: 3 parts · 1 link") replaces the Focus chips. With an empty set, the agent sees the whole workspace (today's behavior).

### 6.4 Prompt from a set (server `setText`)

The client sends keys. The server owns the model and the link sites, so it writes the text, and server tests can check it. It replaces `focusText` (server.mjs:2117); a `focus` array is still accepted and treated as `set.nodes`. Example:

```
Selection (2 parts, 1 link, 1 line range):
- func checkout at shop/web/src/checkout.ts:12-80 (69 lines, 14 branches, 6 parameters)
  finding: Complex logic: 14 branches (line 12)
- type Cart at shop/web/src/cart.ts:5-60
- lines shop/web/src/api.ts:10-18
- link: checkout → Cart.pay (calls ×2, at shop/web/src/checkout.ts:40, 55)
Inside the selection: checkout → Cart.total (call, line 33)
The selection uses: api.post (call ×2, checkout.ts:61, 70); money.format (call, cart.ts:41)
Used from outside by: App.start (call, shop/web/src/app.ts:12)
```

Limits:
- 40 members in detail; the rest are summarized ("+12 more files in web/src").
- 20 boundary entries per side.
- 12 sites per link.
- About 12k characters in total.

### 6.5 Agent changes

- **Read-only runs.** `agentTools` splits into *read* tools (`list_files`, `read_file`, `find_text`, `show_outline`, `find_refs`, `show_links`) and *write* tools (`write_file`, `edit_file`, `move_file`, `delete_file`). Actions with `edits: false` get read tools only, so Explain can't stage an edit even if the model tries.
- **New read tool `show_links { name_or_path, dir: 'out'|'in'|'both' }`.** It lists what a part uses or what uses it, from the model's links, with kinds, weights, and `path:line` sites. The agent can then reason about connections without dozens of `find_refs` calls.
- **`agent.run { prompt?, act?, set, mode? }`.** The server joins the act prompt, the free prompt, and `setText`, then picks the tools. For one-by-one, the server loops over items and pushes `agent.step { kind: 'item', index, total, label }` before each. `agent.done` carries a summary.

### 6.6 Client actions

These keep today's flows, now reached from the Act bar:

- **Rename** (`stage.rename`): one type or function.
- **Move**: file or folder → folder is mechanical, as today. **Function or type → file** is new (§9.3): "Move only" or "Move + fix".
- **Delete** (`stage.delete`): any set of nodes. This replaces "Remove all" in the Unused code rule.
- **Review** (`review.mark`): marks every node member. Ranges can't be marked; the bar says so.
- **Edit**: opens the Code sheet on the first file or range member.

---

## 7. Connections

### 7.1 Link sites

`buildModel` already visits every reference line (server.mjs:1033). It will now keep up to 12 source lines per link key:

| Kind | Site line |
| --- | --- |
| import | `imp.line` |
| call, use | The reference line |
| base | The type's declaration line |
| copy | `fromA` and `fromB` |
| change | None |

- Sites live in a `Map` attached to the model as a **non-enumerable** property (`Object.defineProperty(model, 'sites', …)`), so `repo.model` JSON doesn't grow.
- The client asks for sites lazily with `file.links { key }`, which returns `{ key, out: [{ line, to, kind }], in: [{ from, line, kind }] }`. It asks when a file becomes readable, when a link is selected, and when the Selection panel shows a link. Up to 2,000 sites per file. Results are cached per model.

### 7.2 Picking links

- **Hit test.** `buildLinks` keeps each bright link's sampled polyline. Each frame where the view changed, `inkFocus` projects these polylines to screen once (they're needed for arrowheads anyway) and caches them. Picking measures distance to their segments: 5 px for a mouse, 12 px for touch. At most 4,000 bright links × 16 points, so brute force is under 1 ms.
- **Priority.** A link wins over container bodies (repo, folder, file body, lot). Symbol pieces and towers win over links.
- **What gets selected.** In Focus mode a drawn link may merge several kinds between two lifted nodes, so the member is `[aKey, bKey, '*']`. In All mode the kind is known.
- **Bundles.** Alt-click selects the bundle between the two ends' parents; each Alt-click climbs one more level.

### 7.3 Direction

- Every bright link gets an **arrowhead**: a small filled triangle at 92% along the curve, drawn in the ink layer in the link's color. At most 600, highest weight first.
- In City, arrowheads go through the same occlusion test as roof text (§8.5).
- The dim-to-bright gradient stays.

### 7.4 Call sites in the code (Map and City reading zoom)

For a readable file, the gutter shows:
- `→` on lines that are link sites (blue).
- `←n` on declaration lines that other code calls or uses (orange, with the count).

Hovering such a line shows only that line's links, starting *from that line* (the anchor is the code column x and line y). Clicking the mark selects those links. City draws the same marks in the roof gutter.

### 7.5 Changes-with links and a Hidden coupling rule

`readGit` (server.mjs:1700) already reads the last 3,000 commits. It will also collect each commit's file list:

- Only commits that touch 2–24 files count. Big commits are formatting or merges.
- Count file pairs. Keep a pair when it has 3 or more shared commits and `count / min(churnA, churnB) ≥ 0.35`.
- Keep the top 4,000 pairs.

`buildModel` adds them as links of a new kind, `change`. It is **appended** to `LINK_KINDS`, so existing indexes don't move. These links are undirected: they're stored once with the lower id first, and the client draws them without arrowheads.

`change` and `copy` are excluded from:
- import loops,
- folder loops (`dirGraph` today excludes only `copy`, server.mjs:1145),
- unlinked files (`touched`, server.mjs:1166),
- `liftGraph`, Graph forces, and Layers levels.

New rule **Hidden coupling** (`couple`, low):
- Flags two files with 5 or more shared commits, a ratio of 0.5 or more, and no static link in either direction (import, call, use, or base, at file level).
- Leaves out test files paired with anything, data files, and generated files.
- Note: "Changes with `x.ts` in 7 of 9 commits, but nothing links them."

### 7.6 Measures for connections

Two colors are added. Both are also City heights.

- **Used by** (`fanin`, unit "users"): the number of distinct parts at the current Detail that link into the part. Sequential ramp.
- **Reach**: the hop distance from the current set.
  - Reached only through uses: blue steps 1, 2, 3+.
  - Reached only through used-by: orange steps 1, 2, 3+.
  - Reached both ways: violet.
  - The set itself: accent. Everything else: neutral.
  - With nothing selected, the legend reads "Select something to see its reach".
  - Clicking a legend step selects those parts (W1).

`classify(paint, id)` in `sets.mjs` returns a category key, and `paintOf` maps the key to a color. Legend selection and painting therefore share one source of truth.

### 7.7 Link kind filter

- Link keys in the legend toggle that kind's visibility. The choice is saved as `state.kinds`.
- "changes with" is off in **All** and on in **Focus** by default.
- Clicking a color key selects; clicking a link kind shows or hides it. The help dialog says so.

---

## 8. City 2.0

### 8.1 Anatomy

```
        far: one building per file                 near: the building opens

                                                         ┌─┐    tower = function
         ┌────────┐                               ┌─┐    │ │ ┌─┐  (height = Height measure)
         │        │  shell = file               ┌─┤ ├─┬──┤ ├─┤ ├─┐
         │        │  (height = max of its       │ └─┘ │  └─┘ └─┘ │ podium = type, namespace, section
         │        │   towers, or file measure)  │     │          │
     ┌───┴────────┴───┐                     ┌───┴─────┴──────────┴───┐
     │▓ sign: cart.ts ▓│                     │▓▓ sign: cart.ts ▓▓▓▓▓▓▓│ lot = file; its top is the code page
  ═══╧════════════════╧═══ district plinth ═══╧════════════════════════╧═══ (folder depth)
```

All boxes come from the Map layout, which is already computed (`layMap`, client.mjs:465):

| Part | Footprint | Base z | Height |
| --- | --- | --- | --- |
| District (`dir`) | Folder rect | `(depth − 1) · P` | `P` (plinth, as today: `W · 0.0018`) |
| Lot (`lot`) | File body rect inset 6% (as today) | District top | `0.5 P` |
| Sign (`sign`) | The file's header strip (`r.head`) | Lot top | `1.2 P`, full file color |
| Podium (`podium`) | Each type, space, or section piece (`lay.pieces`) | Parent top (lot or podium) | `max(0.6 P, tall · 0.035)` |
| Tower (`tower`) | Each function piece | Parent top | `max(0.8 P, tall · clamp(v, 0, 1.15)^1.25)`, where `v` is the Height measure |
| Shell (`shell`) | The file body, as today | Lot top | The highest tower top in the file, or the file measure when closed |

- **Piece geometry is the code geometry.** Pieces are per column and already indented by symbol depth. A method's tower stands on its class's podium, inside the podium's footprint, and its roof covers exactly that method's lines in the code columns.
- **The lot is muted.** It's mixed 50% toward the background so towers stand out. Lines outside any symbol (imports, top-level code) sit on the lot's top.

### 8.2 Opening buildings (level of detail)

- **Opening.** A file opens when the short side of its projected rect is at least **70 px**, and closes below **50 px** (the gap prevents flicker). Set members and the hovered file open regardless of size.
- **Budget.** At most 60,000 box instances. If more files qualify, the largest on screen open first.
- **When it updates.** Open state is recomputed on zoom end, and every 200 ms during a long zoom.
- **Opening animation** (280 ms): towers grow from the lot top, and the shell fades to glass (opaque → 12% alpha with a faint edge).
- **Closing animation**: the reverse.
- With reduced motion, changes snap.

### 8.3 Heights

- A **Height** picker appears in the bar only in City. Options: Same as color (default), Lines, Complexity, Churn, Age, Used by, Level, Issues.
- **Per-symbol values**: Lines, Complexity, Used by, Issues (the worst level, as 1/3, 2/3, 1).
- **File-only values**: Churn, Age. Towers take their file's value, which gives a flat roofline: honest about what is known.
- **Level** is the dependency level from Layers, at the file and function ranks. The base is short and code that depends on it is tall. It reuses the Tarjan code moved into `sets.mjs`.
- "Same as color" uses the color measure when it is numeric, and Lines otherwise (today's rule).

### 8.4 Renderer

Replace `InstancedMesh` + `MeshLambertMaterial` with an `InstancedBufferGeometry` box and a `ShaderMaterial`, following the tile renderer (client.mjs:736).

Per-instance attributes:

| Attribute | Fields |
| --- | --- |
| `aTo` | x, y, w, h (layout units) |
| `aToZ` | z, height |
| `aFrom`, `aFromZ` | Previous geometry, for morphs |
| `aColor` | r, g, b, alpha |
| `aFlags` | Bit field: selected, hovered, member, ghost, dim, flat |

Uniforms:

| Uniform | Purpose |
| --- | --- |
| `uT` | Eased morph progress |
| `uFlat` | Reading flatten progress (§8.8) |
| `uGhost` | Ghost alpha |
| `uScale` | Zoom, for constant-width edges |
| `uBg` | Background color |
| light directions | Lighting |
| `uPass` | Opaque or ghost pass |

Shader:

- **Vertex.** Interpolates from/to on the GPU. A morph then costs one uniform per frame instead of a CPU loop over every instance, which fixes the cost noted in §3. Height is multiplied by `mix(1, 0.15, uFlat)` when the flat bit is set.
- **Fragment.**
  - Hemisphere and directional lighting, the same as today.
  - Face edges darken in screen space (`mix(0.78, 1, edge)`, like tiles), so towers and podiums keep crisp outlines at any zoom.
  - The top face brightens slightly when hovered.
- **Two passes**, sharing one geometry:
  - **Opaque**: depth write on; ghost instances are discarded.
  - **Ghost**: transparent, depth write off, drawn after; only ghost instances are drawn.

Colors come from `colorItems` as today, plus the measure color per symbol. Theme switches only rewrite `aColor`.

### 8.5 Skyline index: picking and occlusion

A uniform 2D grid over the layout bounds, with cell size about the median lot size. Each cell lists the instances whose footprint overlaps it. It is rebuilt when the layout or the open state changes.

- **Ray.**
  - The ray in layout units comes from `raycaster.setFromCamera`, then the inverse of `R.base.matrixWorld`.
  - Under the orthographic camera, every pick ray has the same direction for a given view.
  - The ray is walked through the grid from where it enters `z = maxTop` down to `z = 0` (a 2D DDA along its ground projection).
  - Each instance in a visited cell gets a slab test.
  - Result: the nearest hit as `{ index, point, face }`.
- **Picking** (replaces client.mjs:1802):
  - A hit on the **top** face of a lot, podium, or tower that has code turns `(x, y)` into a line with the same column math as Map `pickAt`. It returns `{ id, line }`, where `id` is the deepest symbol that owns the line.
  - A side face returns the piece's node.
  - This gives exact top-of-building picking at any orbit, and line picking in 3D.
- **Occlusion.**
  - A screen point drawn at world point `Q` is hidden if a ray from `Q` toward the camera hits another box.
  - Used for roof text lines, arrowheads, labels, and beacons.
  - Each test is a short DDA walk, a few cells and a few boxes.

### 8.6 Camera

The camera stays orthographic, and pan and zoom stay in screen space through d3-zoom. Added:

- **Orbit.** Right-drag, Alt+drag, or a two-finger twist.
  - `yaw += dx · 0.008`
  - `pitch = clamp(pitch + dy · 0.006, 0, 1.35)`
  - d3-zoom already ignores non-left buttons; its filter also ignores Alt+drag.
- **Pivot at the view center.** Today the tilt group rotates around the middle of the bounds (client.mjs:965), so orbiting while zoomed in throws the view away.
  - Before an orbit starts, the pivot moves to the world point under the screen center (from a skyline hit, or the ground plane).
  - Then `state.t` is adjusted so nothing jumps. With rotation `R`, old pivot `p0`, and new pivot `p1`, the pivot's screen position is `t + k·(R(p1 − p0) + p0)` before the change and `t' + k·p1` after, so `t' = t + k·(R(p1 − p0) + p0 − p1)` (xy, y flipped).
- **Presets** (`V`, and an Angle control in the View sheet on phones): **Tilt** (0.95, −0.5), **Top** (0, 0), **Low** (1.2, current yaw). `,` and `.` turn ±45°, animated.
- **Fitting under any angle.** `fitRect` today assumes the fixed tilt (`cos 0.95`, client.mjs:1908). It will project the target box's 8 corners under the current yaw and pitch, and fit their screen bounds.
- **flyTo** goes to symbol towers, not only files.
  - Flying to a function uses the Map rule: zoom until its code is readable.
  - It eases pitch to the reading pose, unless the user orbited in the last 10 s.
- Orbit resets when you switch layouts.

### 8.7 Labels, signs, beacons

`inkCity` (client.mjs:1558) grows from districts and files into four kinds of label, each occlusion-tested:

- **District names** at the front-left corner of the plinth top (as today).
- **File names** on the sign, with today's staged glyph (`+ ~ −`). A sign is drawn only if it projects at least 34 px wide.
- **Symbol names** on tower and podium roofs at least 40 × 14 px, in the Map's label style (`func name`, `class Name`).
- **Finding beacons**: a level-shaped mark (diamond, square, circle; already the status shapes) above the roof of each part with findings. Shown when Color is Issues or a rule is spotlighted, matching the Map's gutter marks.

The label grid stays: 16 px cells, at most 400 labels.

### 8.8 Reading code on the roofs

Under an orthographic camera, the screen position of a world point is affine:

`screen(x, y, z) = O + x·u + y·v + z·w`

`O`, `u`, `v`, `w` are 2D vectors computed once per frame by projecting four points. Planes at different heights differ only by the offset `z·w`.

**Drawing.**

1. Refactor `inkCode` (client.mjs:1394) to draw against a view `{ k, tx, ty }` instead of `state.t`. Map keeps passing `state.t` with an identity canvas transform.
2. For each owner piece of a readable file (the lot, each podium, each tower), set the canvas transform to the roof plane, normalized by `s = |u|`: `setTransform(u.x/s, u.y/s, v.x/s, v.y/s, Ox + z·w.x, Oy + z·w.y)`. Then draw that piece's lines with `k = s`.
3. Font sizes stay in real screen pixels along a line. Foreshortening across lines comes from the transform.
4. Column clipping keeps working, because clip rects are set in the transformed space.
5. **Line ownership.** Each line is drawn on the roof of the deepest piece that covers it in its column. Per file, `rowZ[line]` is computed once from symbol ranges, in O(lines).
6. **Readability.** The text and minimap thresholds match Map (1.1 px and 7.5 px), measured on the *vertical* line height `|v|·lh`. At pitch above 1.2, text falls back to minimap bars.
7. **Occlusion.** Each line's start point is tested against the skyline (§8.5). Hidden lines are skipped.
8. **Budget.** At most 6 readable files and 400 visible lines per frame.

**Reading pose.**
- When the selected file is readable, its towers ease to 15% height (`uFlat`, flat bit set for that file). The code sits on a low terrace that still shows its shape, and the neighbors stay standing.
- Pitch eases to 0.6 rad, unless the user orbited recently.
- Leaving reading zoom reverses both.

**Links stay attached.** Site anchors (§7.4) use the line's position on its roof, so a call arc leaves the exact line and lands on the callee's roof.

### 8.9 Links in 3D

- **Anchors.** `anchorOf` (client.mjs:995) gets a City branch. A node anchors to the roof center of its deepest *visible* box: its own tower or podium if the building is open, otherwise the shell. Links therefore lift to the greater of the Detail rank and the visible level. Site anchors are used at reading zoom.
- **Skyways (3D hierarchical bundling).**
  - Control points run from source to target through the hubs of the folders on the tree path.
  - A folder's hub is the center of its rect, at `top(dir) + tall · (0.5 + 0.5 · (1 − depth/maxDepth))`. Links between far-apart folders travel high, and local links stay low.
  - Points are straightened with β = 0.85 (the `curveBundle` formula) and sampled as a cubic B-spline in 3D, 24 points.
  - Links within one file arc low over the lot, at `max top + tall · 0.08`.
- **Kinds** keep today's colors. Line widths: import 1.6, call 1.8, use 1.3, base 2.2, copy 1.3, change 1.0 at 50% alpha.
- **Boundary colors** for sets are the same as in 2D (§5.6).
- Arrowheads per §7.3.
- Link depth testing stays on in City (client.mjs:1168).

### 8.10 Selecting and editing in 3D

- **Outline.** `inkFocus`'s City branch (client.mjs:1620) outlines only a file's roof. Instead, each member's box gets its 8 corners projected, then a convex hull (monotone chain), then a stroke. Members inside closed buildings outline the shell. Agent "flash" outlines work the same way; today they're skipped in City.
- **Box select** works in City by projecting roof centers (§5.2).
- **Grip and drag to move.**
  - `gripRect` (client.mjs:1953) gets a City branch. The grip sits on the selected file's sign, or on a selected symbol's roof when that roof projects at least 40 px.
  - While dragging, the drop target is the skyline hit under the pointer: for a file or folder, lifted to a district; for a symbol, lifted to a file (its lot, sign, or any of its towers). The target gets a green outline.
  - The drop opens `askMove`, which grows a symbol case (§9.3).
- Rename, Delete, Review, and Ask need no 3D-specific code; they work on the set.
- **Double-click** on a tower flies to it. Double-clicking a part that is already readable opens it in the Code sheet. This applies in Map too: zooming past reading means "open".

### 8.11 Isolate and cutaway

- **Isolate** (`I`): every instance outside the set (and outside the members' ancestor plinths) goes to the ghost pass. Folder plinths stay solid but dimmed, so you keep your bearings.
- **Cutaway** (automatic while the set is not empty, or during a flyTo): instances that sit between the camera and any member's roof center get the ghost flag. The skyline ray from the target toward the camera finds them. It's recomputed on camera change end, debounced by 120 ms.

---

## 9. Code sheet and stage

### 9.1 Code sheet (replaces the Diff sheet)

`#diff` becomes `#code`. The `diff.open` and `diff.close` hub messages become `code.open { key, from?, to?, tab? }` and `code.close`.

- **Header**: path, state badge, `+/−` counts, previous and next among staged files, close.
- **Code tab**:
  - The file text (staged text if staged) with line numbers and syntax colors, using `tokenize` and `spansToNodes` (client.mjs:1692, 2695).
  - Scrolls to the selected range, which is highlighted.
  - **Edit** turns the range into a monospace textarea with the same metrics. For a symbol member that's its range; for a range member, that range; for a file, the whole file.
  - Ctrl/Cmd+S or **Stage** sends `stage.edit`. Esc cancels.
- **Diff tab** (when the file is staged): today's unified diff, plus a **Revert hunk** button per hunk (`stage.hunk`), **Apply**, and **Discard**.
- **How to open it**: **Edit** in the Act bar, `Shift+Enter`, double-clicking a part that is already readable, or a row in Staged changes (which opens the Diff tab).
- It's the readable fallback in City when roofs are too oblique to read.

### 9.2 Stage additions (server)

- **`stage.edit { key, from, to, text }`**
  - Replaces lines `from..to` (1-based, inclusive) of the staged-or-disk text with `text`.
  - `from = to + 1` inserts without removing.
  - Goes through `Stage.write`, so it's previewed and undoable like any edit.
  - Refuses unknown files and ranges outside the file.
- **`stage.hunk { key, index }`** reverts one hunk.
  - `makeHunks` (server.mjs:1539) also returns each hunk's op index range `[i0, i1)`.
  - `after` is rebuilt from the ops, with that range taking `' '` and `'-'` lines instead of `'+'` lines.
  - Reverting every hunk drops the item, as `Stage.write` already does when the text matches.

### 9.3 Moving a symbol to another file

`stage.move { key, to }` now also takes a **type or function** key with a **file** key as the target:

1. Cut the symbol's line range together with its attached attributes, decorators, and doc comments. This reuses the walk-up loop in `deleteNodes` (server.mjs:2042).
2. Append the cut text to the target file after one blank line.
3. Stage both files.

The popover offers "Move only" or "Move + fix". "Move + fix" then runs an agent request: "I moved `Cart.total` from `cart.ts` to `money.ts` (staged). Update every import and reference so the code still works." The set is the two files, so the prompt carries their interface.

---

## 10. Preview with a stable layout

Today, Preview rebuilds the model from staged text, and the treemap reflows (server.mjs:1971). Before and after then can't be compared spatially.

- When Preview turns on, the client keeps the last non-preview model as `state.base`.
- `layMap` takes an optional size source. In preview it lays out the **union** of base and preview files by key, each with area `max(before, after)`. Both states use this one layout, so nothing moves when you toggle; only colors, heights, and contents change.
- **Deleted files** (base only) become ghost items with no node id:
  - Map: hatched, with a red outline.
  - City: red translucent shells.
- **New files** are outlined green in Map. In City they rise from their lot.
- **City**: toggling Preview morphs heights on the GPU (§8.4). A split file becomes several towers before your eyes (W2, W4).
- The status bar still says "Preview".

---

## 11. UI by surface

```
┌ bar: brand · crumbs · Find (/ names, queries, > actions) · Map Graph Layers City · Detail · Color · [Height] · Links · Fit · Settings · Help ┐
│ ┌ Check | Change ┐                                                                 ┌ Selection ┐ │
│ │ findings,      │                         canvas                                  │ summary   │ │
│ │ conversation,  │                                                                 │ interface │ │
│ │ staged, prompt │                                                                 │ grow      │ │
│ └────────────────┘       ┌ Act: 3 parts · 1 link │ Explain Tidy Tests Fix Extract │ More │ ◐ │ × ┐  └───────────┘ │
└ legend (click a color to select it, a link kind to show/hide it) ······················ status ┘
```

| Surface | Change |
| --- | --- |
| Bar | Height picker in City only. Nothing else added. |
| Find | Queries (§5.4), Select all (Alt+Enter), saved Sets group, `>` action mode. |
| Legend | Interactive (§7.6, §7.7). Gradient brush shows its range and count while dragging. |
| Check | Rule actions become **Select all**. Per-finding Fix and Mark fine stay. The spotlight stays. |
| Change | Removes Quick asks and Focus chips. Adds a scope line and mode toggle above the prompt, **Select changed** in Staged changes, and batch entries in the log. |
| Selection | §5.7. |
| Act bar | §6.2. |
| Code sheet | §9.1. |
| View sheet (phones and tablets) | Adds Height in City and an Angle control (Tilt, Top, Low). |

**Keys.** Existing keys are unchanged; new ones are checked for conflicts against the current list (client.mjs:3110–3136).

| Key | Action |
| --- | --- |
| `]` / `[` | Grow by what it uses / what uses it, one hop |
| `}` / `{` | Same, all hops |
| `X` | Explain the set |
| `A` | Actions for the set (Find in `>` mode) |
| `I` | Isolate |
| `Shift+Enter` | Open in the Code sheet |
| `Alt+Enter` (in Find) | Select all results |
| `V` | City: next angle (Tilt, Top, Low) |
| `,` `.` | City: turn left or right |
| Right-drag, Alt+drag, two-finger twist | City: orbit |
| Alt+click a link | Select the link bundle (again to go up a level) |

Esc order: popover → Code sheet → find → rule spotlight → isolate → set → fit.

**Touch.**
- Tap a link (12 px tolerance) to select it.
- Long-press adds to the set (exists).
- Two-finger twist orbits in City. It's read from pointer events next to d3-zoom's pinch and changes yaw only. Pitch uses the Angle presets.

**Accessibility.**
- The Selection member list and the Act bar are keyboard-navigable. Act bar buttons show their keys in tooltips.
- An `aria-live` line announces set changes ("12 parts selected").

---

## 12. Server changes

### 12.1 Model

- `linkKinds` adds `'change'` at the end.
- `rules` adds `couple` ("Hidden coupling").
- `model.sites` is non-enumerable: `Map<"s,t,kind", lines[]>`.
- `readGit` returns `pairs: [[relA, relB, count]]`.
- Exclusions for `change` per §7.5.

### 12.2 Messages

Changed or new, client to server:

| Type | Data | Reply |
| --- | --- | --- |
| `hello` | — | Adds `acts`, `sets` |
| `agent.run` | `{ prompt?, act?, set?, mode? }`; `focus` still accepted | `ok`, then `agent.step` and `agent.done` |
| `file.links` | `{ key }` | `file.links { key, out: [{ line, to, kind }], in: [{ from, line, kind }] }` |
| `stage.edit` | `{ key, from, to, text }` | `note` |
| `stage.hunk` | `{ key, index }` | `note` |
| `stage.move` | `{ key, to }`; also symbol → file | `note` |
| `set.save` | `{ set }` (no `id` makes a new set) | `sets.state` |
| `set.drop` | `{ id }` | `sets.state` |

Pushes:

| Type | Data |
| --- | --- |
| `agent.step` | Adds `{ kind: 'item', index, total, label }` |
| `sets.state` | `{ sets: [{ id, name, repo, nodes, links, ranges, recipe, at }] }` |

New client hub messages:
- `pick.link`, `set.grow`, `set.load`, `set.save`, `set.isolate`
- `act.run`
- `code.open`, `code.close` (replace `diff.open`, `diff.close`)
- `view.height`, `view.kinds`, `view.angle`

### 12.3 Agent

- `ACTS` exported next to `RULES`.
- `setText(space, set)` replaces `focusText`.
  - The server keeps a `byKey` map per model build, plus a children index built from `up`.
  - A link member expands to the raw links under its two ends, filtered by kind, each with its sites.
- `agentTools(space, sdk, { write })` splits read and write tools and adds `show_links`.
- `runAgent` takes `{ act, set, mode }`.
  - One-by-one runs each item with `history = []`.
  - Only the batch summary goes into `space.agent.history`.
  - Abort stops after the current item.

### 12.4 Stage and ledger

- `Stage.editRange(key, from, to, text)`, `Stage.revertHunk(key, index)`, and `Workspace.moveSymbol(key, toFile)`.
- `makeHunks` returns op ranges.
- The ledger adds `sets`.
- `Workspace.saveSet` / `dropSet` write the ledger and emit `sets.state`. Saving a set doesn't rebuild the model.

---

## 13. Client structure and state

### 13.1 Modules

`client.mjs` is about 3,200 lines and would grow by about 3,500. Two well-bounded parts move out. `STATIC` in server.mjs:2275 serves them; the CSP already allows same-origin scripts, so it doesn't change.

| File | Holds | Depends on |
| --- | --- | --- |
| `sets.mjs` | **No DOM, d3, or three.** `index(model)` (kids, depth, fileOf, symDepth, byKey, out, inn: the DOM-free core of `prep`), `liftTo`, `isUnder`, `liftGraph`, `strongGroups` (moved from `layLayers`), `levels`, `grow`, `paths`, `loopOf`, `copiesOf`, `testsOf`, `boundary`, `parseQuery`, `matchQuery`, `classify`, `replay`. | Nothing |
| `city.mjs` | `layCity`, the box material and shaders, the open-state planner, skyline index (`skyBuild`, `skyRay`, `skyHidden`), orbit and pivot math, City ink (labels, roofs, beacons), skyway routing, hull outlines. Exports `makeCity(ctx)`, where `ctx` carries `state`, `R`, `THREE`, `d3`, and shared helpers. | three, d3, `sets.mjs` |
| `client.mjs` | Hub, state, wire, Map, Graph, Layers, 2D ink, panels, Act bar, Code sheet, keys, boot. | Both |

`sets.mjs` runs in Node, so it gets its own unit tests (§15).

### 13.2 New state

| Field | Meaning |
| --- | --- |
| `set` | The current set (§5.1). It replaces `sel`; `selIds()` keeps its name. |
| `saved` | Saved sets from `sets.state` |
| `acts` | Server actions from `hello` |
| `mode` | `'together'` or `'each'` |
| `isolate` | Isolate on or off |
| `kinds` | Visible link kinds (saved) |
| `height` | City Height measure (saved) |
| `angle` | City preset |
| `sites` | `file.links` cache per model |
| `base` | Model kept while previewing (§10) |
| `R.orbit`, `R.pivot`, `R.sky`, `R.open`, `R.boxes` | City renderer state |

### 13.3 Code touched (by function)

**client.mjs**
- `prep` (238): calls `sets.index`.
- `paintOf` (376): uses `classify`.
- `makeLit` (416): set-aware isolate.
- `layMap` (465): optional size source for preview.
- `layLayers` (601): Tarjan moves to `sets.strongGroups`.
- `layCity` (707) and `colorItems` / `placeItems` City branches (869, 906): move to `city.mjs`.
- `linkSet` (1016): set boundary, kind filter.
- `routeOf` (1090): City skyways.
- `buildLinks` (1139): keeps polylines for picking.
- `inkCode` (1394): view parameter.
- `inkCity` (1558), `inkFocus` (1616): City outlines, arrowheads.
- `pickAt` (1798): links, City skyline.
- `fitRect` / `flyTo` (1904, 1925): any angle.
- `gripRect` (1953), `setupPointer` (1969), `boxSelect` (2060): City, ranges, orbit.
- `drawFind` (2184): queries and actions.
- `drawCheck` (2308), `drawChange` (2383), `drawInfo` (2472) → `drawSelection`; `actsFor` (2576) removed.
- `drawDiff` (2665) → `drawCode`.
- `drawFoot` (2816): interactive legend.
- `setupKeys` (3102).

**server.mjs**
- `buildModel` (919): sites, change links, `couple`.
- `readGit` (1700): pairs.
- `makeHunks` (1539).
- `Stage` (1562).
- `Workspace` (1813): `moveSymbol`, sets.
- `focusText` (2117) → `setText`.
- `agentTools` (2131), `runAgent` (2225), `handlers` (2342).

---

## 14. Limits and performance

| Item | Budget |
| --- | --- |
| City box instances | ≤ 60,000. Files open at ≥ 70 px and close below 50 px; largest on screen first. |
| City frame | ≤ 8 ms at 1440×900 on an integrated GPU for a 2,000-file repo. Morphs are GPU-only. |
| Pick (skyline DDA) | ≤ 1 ms per pointer move. Hover stays throttled to one per frame (exists). |
| Roof text | ≤ 6 readable files; ≤ 400 lines per frame; one occlusion test per line. |
| Arrowheads | ≤ 600 |
| Link pick | ≤ 4,000 bright polylines, projected once per changed frame |
| Set operations | ≤ 50 ms on a 50,000-node model. Lifted graphs are cached per (rank, `model.made`). |
| Set prompt | ≤ 12k characters; 40 members in detail; 20 boundary entries per side; 12 sites per link |
| One-by-one batch | ≤ 50 items; confirm above 10 |
| `file.links` | ≤ 2,000 sites per file |
| Changes-with pairs | ≤ 4,000; only commits touching 2–24 files |
| Saved sets | ≤ 200 per repo; ≤ 5,000 keys per set |

Existing limits (DESIGN.md, Limits) are unchanged.

---

## 15. Testing

### 15.1 Server (`server.test.mjs`)

1. Link sites on the demo repo: the `checkout → Cart` call sites match the file text. `model.sites` is missing from `JSON.stringify(model)`.
2. Changes-with links: a temp git repo where `a.ts` and `b.ts` are committed together 4 times and `c.ts` alone.
   - Expect a `change` link between `a` and `b`, and no new import loops or folder loops.
   - Expect `couple` on `a` and `b` when nothing links them, and not after adding an import.
   - Commits touching more than 24 files are ignored.
3. `stage.edit`: replace, insert, refuse an out-of-range edit, preview shows it, undo after apply.
4. `stage.hunk`: reverts exactly one hunk; reverting every hunk drops the item.
5. `stage.move` of a symbol to a file: doc comment and decorator travel with it; both files are staged; the diffs are right.
6. `setText`: lists members, findings, inside links, uses and used-by with sites, and respects the caps.
7. Read-only actions: an `explain` run sends no write tools in the request (checked by the mock endpoint).
8. One-by-one: a set of 3 makes 3 runs, 3 `item` steps, one summary in history; stop after the first.
9. `show_links` output on the demo repo.
10. `set.save` / `set.drop` persist in the ledger and come back after a restart.

### 15.2 Sets (`sets.test.mjs`, new, `node:test`, no browser)

Uses the demo model from `makeSample` and `buildModel`.

- `grow` out and in, depth 1 and all, with hops.
- `paths` between two files.
- `loopOf` on the planted import loop.
- `copiesOf` on the planted copies.
- `testsOf`.
- `boundary` inside / out / in counts.
- `parseQuery` and `matchQuery`: every filter, bad input, AND.
- `classify` for each paint.
- `replay` after a rebuild.

Add it to `npm test` and `npm run test:server`.

### 15.3 Browser (`client.test.mjs`)

These continue the shot numbering. Each step also asserts state through `window.devibe`, which gains `pickLink`, `setOf`, `city: { open, sky }`.

| Shot | Checks |
| --- | --- |
| `30-city-open` | Zooming into a file in City opens it: it has tower instances, the shell is glass. |
| `31-city-read` | Reading pose; roof code drawn; `pickAt` on a roof returns the function id and line. |
| `32-city-orbit` | Alt+drag changes yaw; the pivot stays under the cursor; picking still hits the building top. |
| `33-city-links` | Function-level arcs anchored on towers; arrowheads; boundary colors for a set. |
| `34-link-select` | Clicking a link in Map shows the link and its sites in the Selection panel. |
| `35-grow` | `]` twice: the set grows, hops show, and Path between two files works. |
| `36-legend-select` | Color Issues → click High → the set is the high-finding files at the current Detail. |
| `37-find-query` | `kind:func cx>10` → Alt+Enter selects them; `>` lists actions. |
| `38-act-explain` | Explain from the Act bar runs read-only (mock endpoint checks the tools). |
| `39-act-each` | Document one by one on 3 files: 3 batch rows, staged results. |
| `40-code-edit` | Edit a function in the Code sheet, stage it, then the Diff tab; revert a hunk. |
| `41-city-preview` | Preview morphs heights; a deleted file shows as a ghost; the layout doesn't move. |
| `42-city-move` | Drag a building's grip onto a district → move popover. Drag a tower onto another lot → symbol move popover. |
| `43-isolate` | `I` in City ghosts non-members; cutaway clears the view to a member. |
| `44-phone-act` | Act bar and Selection sheet on a phone. |

Shots 05, 17, 18, 26, and 27 are refreshed for the new panels. The "no script errors" test stays last.

### 15.4 Workflows

W1–W7 (§2) each run end to end against the mock model in one test, `workflows`, without screenshots. They are the acceptance gate for Phase 5.

---

## 16. Delivery phases

Each phase ships on its own, passes `npm test`, and updates DESIGN.md for what it changes. Sizes are rough line counts.

| Phase | Scope | Size | Done when |
| --- | --- | --- | --- |
| **0. Groundwork** | Move `sets.mjs` out (index, lift, Tarjan) with tests. Serve the new modules. Replace `state.sel` with `state.set` (nodes only). Server `ACTS` in `hello`; split read and write tools; `agent.run { act }`. | ~400 | No visible change; all existing tests pass; `sets.test.mjs` runs. |
| **1. Sets and Act (2D first)** | Set data with links and ranges. Link picking and arrowheads in Map, Graph, Layers. Selection panel. Act bar and `>` palette. Grow operations and keys. Legend selection. Find queries and Select all. Check Select all. Change panel cleanup. `setText`. One-by-one. Saved sets and recipes. | ~1,600 | W1 (without Reach), W3, W6, W7 pass in 2D. Quick asks and Focus chips are gone. |
| **2. Connections** | Link sites and `file.links`. Gutter call-site marks and line-anchored links. Changes-with links and the `couple` rule. Link kind filter. Used by and Reach colors. Bundle selection. | ~800 | W1 passes. Sites show in the Selection panel and the agent prompt. |
| **3. City engine** | Box shader with GPU morph. Skyline picking. Orbit, pivot, presets, any-angle fit and flyTo. Open buildings (lot, sign, podium, tower, shell). Height picker. Labels and beacons. Hull outlines. Box select. Isolate and cutaway. Skyways and 3D anchors. | ~1,500 | Shots 30, 32, 33, 43 pass. The City frame budget holds on the 2,000-file tree. |
| **4. Read and edit in 3D** | Roof code (affine ink plus occlusion). Reading pose. Line and range picking in 3D. Grip and drag in 3D. Symbol move to a file (Map and City). | ~800 | Shots 31, 42 pass. W4 and W5 pass. |
| **5. Code sheet and preview** | Code sheet (code, edit, diff, revert hunk). `stage.edit`, `stage.hunk`. Union-layout preview with ghosts in both views. City preview morph. | ~700 | Shots 40, 41 pass. W2 passes. All workflows pass. |
| **6. Polish** | Performance pass (open-state caps, cached lifts). Accessibility. Touch twist. Docs and README shots. TODO cleanup. Optional notes (below). | ~400 | DESIGN.md and README match the app; TODO entries for City orbit, top picking, and diff editing are removed. |

**Optional in Phase 6: notes.** An Explain answer gets **Keep as note**. The note is stored in the ledger per node key, with a text hash so it goes stale like a review mark. It shows in the Selection panel and as a small mark on the map and on roofs. Leave it out if Phase 1–5 feedback doesn't ask for it.

**Docs to update** as each phase lands:
- DESIGN.md: Principles, Layouts (City), Interaction, Panels, Message reference, Data model (`change`), Checks (`couple`), Agent (acts, tools, modes), Limits, Testing.
- README: Use it, and the shot table.
- TODO.md.

---

## 17. Risks

| Risk | Mitigation |
| --- | --- |
| Canvas text under a sheared transform looks poor at steep angles | Normalize so font sizes stay in real pixels. Above pitch 1.2, fall back to minimap bars. The Code sheet is always one key away. |
| Occlusion is per line, not per glyph | Test each line's start; partly hidden lines are rare once the reading pose lowers the file. Good enough to read; the Code sheet is exact. |
| Too many controls | §4 is a hard rule: a new control removes one. Phase reviews check the consolidation table. |
| Big batches cost money and time | Confirm above 10 items. Show the count and mode. Stop after the current item. Explain is read-only. |
| Changes-with noise from formatting or bulk commits | Only commits touching 2–24 files; ratio threshold; ≤ 4,000 pairs; off in All mode by default. |
| Model payload grows | Sites are lazy (`file.links`) and never in `repo.model`; changes-with links are capped. |
| Orbit fights d3-zoom | Orbit is on gestures d3-zoom already ignores. Pivot compensation keeps the view still. Orbit resets on layout change. |
| GPU memory | 60,000 instances × about 20 floats ≈ 5 MB. Attributes are reused, with capacity grown 1.25×, like tiles. |
| Recipes surprise users after rescans | The Selection header shows "Live: rule Copied code". **Freeze** drops the recipe. |

---

## 18. Left out on purpose

- **Perspective or first-person camera.** It breaks the affine mapping that makes roof text, fitting, and pan/zoom simple, and it adds no reasoning value.
- **Floors stacked by line order** inside each building. That would make a second geometry that disagrees with Map; volume would grow with lines squared; and code wouldn't sit where it sits in 2D. Towers on the code layout keep one geometry.
- **A 3D force graph.** Graph already does this job in 2D, and 3D node-link graphs occlude themselves.
- **A separate command palette or a Sets panel.** Find (`>`, the Sets group) and the Selection panel cover both.
- **Code on building facades.** Roofs already hold it; facades would duplicate it at worse angles.
- **WebGPU.** Not needed within these budgets.

---

## 19. Open questions

1. **Where saved sets live.** In the private ledger, as planned (per repo, under `~/.devibe`)? Or in an in-repo file the team can share? The second ties into the shared review ledger idea in TODO.md.
2. **Notes.** Should Explain answers become notes on the map (Phase 6, optional), or stay in the chat?
3. **One-by-one defaults.** Are 50 items per batch and confirmation above 10 the right numbers for the models people use with devibe?
