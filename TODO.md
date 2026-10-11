# TODO

Sorted by impact, highest first.

- [parsing] Add Tree-sitter (WASM) parsers as an option for exact syntax trees where the built-in heuristics fall short: receiver-typed calls, macros, generics-heavy C++, decorators, nested lambdas.
- [linking] Resolve calls by receiver type (`store.Find` → `IOrderStore.Find`) instead of by name, to cut false and missing call links in large OOP code.
- [repos] Open remote repos: clone a git URL into a cache folder, keep it fetched, and show the branch.
- [reshape] Fix imports on mechanical moves without the agent (JS/TS relative imports, Python modules, C# namespaces), so "Move only" leaves the code building.
- [agent] Add an opt-in tool to run the build or tests (with approval per command), so the agent can verify its staged edits.
- [checks] Make rule thresholds and rule on/off editable in Settings, with an optional per-repo `.devibe.json` the team can share.
- [checks] Add architecture rules: "folder A must not depend on folder B", drawn as allowed and forbidden bands in Layers.
- [audit] Optional shared review ledger stored in the repo, so a team can split and track review of generated code, and share saved sets.
- [agent] Keep Explain answers as notes on the parts they explain: stored in the ledger with a text hash so they go stale like review marks, shown in the Selection panel and as marks on the map and roofs.
- [view] Group the map by C# namespace or Java/Kotlin package instead of folders.
- [perf] Move layout and the force simulation to a Web Worker so very large graphs (over 5,000 nodes) never block input.
- [perf] Rebuild only the changed files' links on rescans of very large repos (over 50,000 files) instead of the whole model.
- [agent] Show token use and cost per request, and let the user approve or reject each tool call as it happens.
- [view] Bundle edges in the Graph layout (force-directed edge bundling) to tame dense graphs.
- [watch] Watch repos with more than 4,000 folders (recursive watcher or polling) instead of skipping the extra folders.
- [a11y] Add a keyboard-navigable tree view of the map (arrow keys between siblings and levels) for screen readers.
- [agent] Keep several conversations per workspace and restore them after a restart.
- [test] Compare screenshots against stored images to catch visual regressions automatically.
- [view] City: draw roof code with a glyph atlas on the GPU so more than 6 files can be read at once at steep angles.
- [checks] Detect near copies (renamed variables) in addition to exact normalized copies.
