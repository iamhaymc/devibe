// Tree-sitter parsing (optional): exact syntax trees for symbols and receiver
// facts, from @vscode/tree-sitter-wasm when it is installed. It yields the
// built-in parser's raw shapes, so nesting, complexity, and linking stay in
// the server and work the same for both parsers. No DOM, d3, or three.js.
//
// makeTrees() → { ready, langs, load(langIds), read(text, langId, rel), stats }
//   read → { syms, vars, refs } or null when the grammar is not loaded.
//   syms: { kind, form, name, s, e, body, args?, bases?, recv? } (offsets)
//   vars: [name, type text, line, made?] where made is 'new' or 'call' when
//         the type comes from a construction rather than a written type.
//   refs: [chain, name, line] for member accesses.

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Language id → grammar file stem. C uses the C++ grammar.
export const GRAMMARS = { js: 'javascript', ts: 'typescript', py: 'python', cs: 'c-sharp', java: 'java', go: 'go', rs: 'rust', c: 'cpp', cpp: 'cpp', rb: 'ruby', php: 'php' };
const grammarOf = (langId, rel) => (langId === 'ts' && /\.tsx$/i.test(rel ?? '') ? 'tsx' : GRAMMARS[langId]);

export function makeTrees({ pkg = '@vscode/tree-sitter-wasm' } = {}) {
  let main = null;
  try { main = require.resolve(pkg); } catch { /* not installed */ }
  const dir = main ? path.dirname(main) : null;
  let runtime = null;
  const parsers = new Map();
  const stats = { files: 0, ms: {}, errors: 0 };
  const init = () => {
    runtime ??= (async () => {
      const ts = require(main);
      await ts.Parser.init();
      return ts;
    })().catch(() => null);
    return runtime;
  };
  return {
    ready: !!main,
    langs: Object.keys(GRAMMARS),
    stats,
    // Loads the grammars these languages need; resolves to the ids now readable.
    async load(langIds) {
      const out = new Set();
      if (!main) return out;
      const ts = await init();
      if (!ts) return out;
      for (const id of langIds) {
        const stems = id === 'ts' ? ['typescript', 'tsx'] : GRAMMARS[id] ? [GRAMMARS[id]] : [];
        for (const stem of stems) {
          if (parsers.has(stem)) continue;
          try {
            const lang = await ts.Language.load(path.join(dir, `tree-sitter-${stem}.wasm`));
            const p = new ts.Parser();
            p.setLanguage(lang);
            parsers.set(stem, p);
          } catch { parsers.set(stem, null); }
        }
        if (stems.length && stems.every((s) => parsers.get(s))) out.add(id);
      }
      return out;
    },
    read(text, langId, rel) {
      const stem = grammarOf(langId, rel);
      const p = stem && parsers.get(stem);
      if (!p) return null;
      const t0 = performance.now();
      let tree = null;
      try {
        tree = p.parse(text);
        if (!tree) return null;
        return readTree(tree.rootNode, text, HANDLERS[stem]);
      } catch {
        stats.errors++;
        return null;
      } finally {
        tree?.delete();
        stats.files++;
        stats.ms[langId] = (stats.ms[langId] ?? 0) + (performance.now() - t0);
      }
    },
  };
}

// ───────────────────────────── Walk ─────────────────────────────

// Visits every node in document order without recursion, so deep trees
// cannot overflow the stack.
function readTree(root, text, H) {
  const out = { syms: [], vars: [], refs: [] };
  const cur = root.walk();
  for (let more = true; more;) {
    if (H.all.has(cur.nodeType)) H.on(cur.currentNode, out, text);
    if (cur.gotoFirstChild()) continue;
    while (!cur.gotoNextSibling()) if (!cur.gotoParent()) { more = false; break; }
  }
  cur.delete?.();
  return out;
}

const line = (n) => n.startPosition.row + 1;
const field = (n, f) => n.childForFieldName(f);
const kids = (n) => n.namedChildren;
const last = (s) => s.split(/::|\.|\\/).pop();
const isId = (n) => n && /^(?:identifier|type_identifier|field_identifier|property_identifier|constant|name|namespace_identifier|private_property_identifier|shorthand_property_identifier)$/.test(n.type);

// Plain names only: identifiers, `A::b`, `A.B`, `~A`, C++ operators.
const NAME_OK = /^(?:~?[A-Za-z_$][\w$]*(?:(?:::|\.)~?[A-Za-z_$][\w$]*)*(?:::operator\S{1,3})?|operator\S{1,3})$/;

function sym(out, kind, form, node, nameNode, name, { body = null, params = null, bases, recv, e } = {}) {
  name = name?.replace(/^#/, '');
  if (!name || !NAME_OK.test(name)) return;
  out.syms.push({ kind, form, name, s: (nameNode ?? node).startIndex, e: e ?? node.endIndex, body: body ? body.startIndex : -1, args: params ? countParams(params) : kind === 'func' ? 0 : undefined, bases, recv });
}

function countParams(params) {
  if (params.type === 'identifier') return 1;
  let n = 0;
  for (const c of kids(params)) {
    if (/comment|self_parameter|^this$/.test(c.type)) continue;
    const t = c.text.trim();
    if (/^(?:self|cls|this|void|&\s*(?:mut\s+)?self)$/.test(t) || /^(?:self|cls)\s*[:=,)]/.test(t)) continue;
    // Go `a, b int`: one declaration, several names.
    let names = 0;
    if (c.type === 'parameter_declaration') for (let i = 0; i < c.childCount; i++) if (c.fieldNameForChild(i) === 'name') names++;
    n += Math.max(1, names);
  }
  return n;
}

// Names in a heritage clause: the last part of each qualified name, leaving
// out type arguments and keyword arguments (Python `metaclass=`).
const SKIP_IN_BASES = /^(?:type_arguments|type_argument_list|template_argument_list|type_parameters|type_parameter_list|keyword_argument|type_parameter_constraints_clause|access_specifier|comment)$/;
const QUALIFIED = /^(?:qualified_name|scoped_identifier|scoped_type_identifier|member_expression|attribute|nested_type_identifier|qualified_identifier|qualified_type|namespace_name|scope_resolution|generic_name|generic_type|template_type)$/;
function baseNames(node, out = []) {
  if (!node || SKIP_IN_BASES.test(node.type)) return out;
  if (QUALIFIED.test(node.type)) {
    const ids = [];
    const walk = (n) => { if (SKIP_IN_BASES.test(n.type)) return; if (isId(n) || n.type === 'name') ids.push(n.text); for (const c of kids(n)) walk(c); };
    walk(node);
    // generic_name / generic_type / template_type: the first id is the type.
    const pick = /^(?:generic_name|generic_type|template_type)$/.test(node.type) ? ids[0] : ids.at(-1);
    if (pick && !out.includes(pick)) out.push(last(pick));
    return out;
  }
  if (isId(node)) { if (!out.includes(node.text)) out.push(node.text); return out; }
  for (const c of kids(node)) baseNames(c, out);
  return out;
}

// A receiver chain from an object node: `a`, `this`, `super`, `a.b`.
function chainOf(n, H) {
  if (!n) return null;
  if (H.self.has(n.type) || H.self.has(n.text)) return 'this';
  if (H.sup.has(n.type) || H.sup.has(n.text)) return 'super';
  if (isId(n) || n.type === 'variable_name') return n.text.replace(/^\$/, '');
  if (n.type === 'instance_variable') return 'this.' + n.text.replace(/^@+/, '');
  if (n.type === 'parenthesized_expression' && n.namedChildCount === 1) return chainOf(n.namedChildren[0], H);
  const m = H.member[n.type];
  if (m) {
    const obj = chainOf(field(n, m[0]), H);
    const prop = field(n, m[1]);
    return obj && prop && /^[A-Za-z_$][\w$]*$/.test(prop.text) ? `${obj}.${prop.text}` : null;
  }
  if ((n.type === 'call' || n.type === 'call_expression') && n.text.replace(/\s+/g, '') === 'super()') return 'super';
  return null;
}

function addRef(out, n, H) {
  const m = H.member[n.type];
  const prop = field(n, m[1]);
  if (!prop || prop.text.length < 3 || !/^[A-Za-z_$][\w$]*$/.test(prop.text)) return;
  const chain = chainOf(field(n, m[0]), H);
  if (chain) out.refs.push([chain, prop.text, line(prop)]);
}

// The declared name in a C/C++ declarator chain, and its function declarator.
function cDeclarator(d) {
  let fn = null;
  while (d) {
    if (d.type === 'function_declarator') { fn = d; d = field(d, 'declarator'); continue; }
    if (/^(?:pointer_declarator|reference_declarator|init_declarator|array_declarator|parenthesized_declarator|attributed_declarator)$/.test(d.type)) { d = field(d, 'declarator') ?? kids(d).at(-1); continue; }
    break;
  }
  return { fn, id: d };
}
const cName = (id) => (!id ? null : id.type === 'qualified_identifier' ? id.text.replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, '').replace(/\s+/g, '') : id.text.replace(/\s+/g, ''));

// ───────────────────────────── Grammars ─────────────────────────────
// Each handler: all (node types to visit), on(node, out, text), member
// ({ type: [object field, name field] }), self and sup (this/super spellings).

function handler({ types = {}, spaces = {}, funcs = {}, members = {}, self = [], sup = [], extra = {} }) {
  const all = new Set([...Object.keys(types), ...Object.keys(spaces), ...Object.keys(funcs), ...Object.keys(members), ...Object.keys(extra)]);
  const H = { all, member: members, self: new Set(self), sup: new Set(sup) };
  H.on = (n, out, text) => {
    const t = n.type;
    if (members[t]) addRef(out, n, H);
    if (types[t]) types[t](n, out, text);
    else if (spaces[t]) spaces[t](n, out, text);
    else if (funcs[t]) funcs[t](n, out, text);
    if (extra[t]) extra[t](n, out, text);
  };
  return H;
}

const named = (kind, form, opts = {}) => (n, out) => {
  const nameNode = field(n, opts.name ?? 'name');
  if (!nameNode && opts.optional !== true) return;
  sym(out, kind, form, n, nameNode, nameNode ? (opts.text ? opts.text(nameNode) : nameNode.text) : null, { body: field(n, opts.body ?? 'body'), params: kind === 'func' ? field(n, 'parameters') ?? field(n, 'parameter') : null, bases: opts.bases ? opts.bases(n) : undefined });
};

// A typed name: [name, type text, line, made?]
const typed = (out, nameNode, typeNode, made) => {
  if (!nameNode || !typeNode) return;
  const name = nameNode.text.replace(/^\$/, '');
  if (/^[A-Za-z_@][\w]*$/.test(name)) out.vars.push([name, typeNode.text, line(nameNode), made]);
};

const JS_FN = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const jsTypes = (ts) => ({
  class_declaration: named('type', 'class', { bases: (n) => baseNames(kids(n).find((c) => c.type === 'class_heritage')) }),
  abstract_class_declaration: named('type', 'class', { bases: (n) => baseNames(kids(n).find((c) => c.type === 'class_heritage')) }),
  ...(ts ? {
    interface_declaration: named('type', 'interface', { bases: (n) => baseNames(kids(n).find((c) => c.type === 'extends_type_clause')) }),
    enum_declaration: named('type', 'enum'),
    type_alias_declaration: (n, out) => { const nm = field(n, 'name'); sym(out, 'type', 'type', n, nm, nm?.text); },
  } : {}),
});
const jsFuncs = {
  function_declaration: named('func', 'function'),
  generator_function_declaration: named('func', 'function'),
  function_signature: named('func', 'function'),
  method_definition: named('func', 'function'),
  method_signature: named('func', 'function'),
  abstract_method_signature: named('func', 'function'),
  // const f = () => {}, { k: function () {} }, class field handlers = () => {}
  variable_declarator: (n, out) => {
    const v = field(n, 'value'), nm = field(n, 'name');
    if (v && JS_FN.has(v.type) && nm?.type === 'identifier') sym(out, 'func', 'function', n, nm, nm.text, { body: field(v, 'body'), params: field(v, 'parameters') ?? field(v, 'parameter'), e: n.endIndex });
  },
  pair: (n, out) => {
    const v = field(n, 'value'), k = field(n, 'key');
    if (v && JS_FN.has(v.type) && isId(k)) sym(out, 'func', 'function', n, k, k.text, { body: field(v, 'body'), params: field(v, 'parameters') ?? field(v, 'parameter') });
  },
  public_field_definition: (n, out) => {
    const v = field(n, 'value'), k = field(n, 'name');
    if (v && JS_FN.has(v.type) && isId(k)) sym(out, 'func', 'function', n, k, k.text, { body: field(v, 'body'), params: field(v, 'parameters') ?? field(v, 'parameter') });
  },
  field_definition: (n, out) => {
    const v = field(n, 'value'), k = field(n, 'property');
    if (v && JS_FN.has(v.type) && isId(k)) sym(out, 'func', 'function', n, k, k.text, { body: field(v, 'body'), params: field(v, 'parameters') ?? field(v, 'parameter') });
  },
};
const tsAnnot = (n) => { const a = field(n, 'type') ?? kids(n).find((c) => c.type === 'type_annotation'); return a?.type === 'type_annotation' ? a.namedChildren[0] : a; };
const jsExtra = (ts) => ({
  ...(ts ? {
    required_parameter: (n, out) => { const p = field(n, 'pattern'); const t = tsAnnot(n); if (p?.type === 'identifier') { typed(out, p, t); if (kids(n).some((c) => c.type === 'accessibility_modifier' || c.type === 'readonly')) out.vars.push(['@' + p.text, t?.text, line(p)]); } },
    optional_parameter: (n, out) => { const p = field(n, 'pattern'); if (p?.type === 'identifier') typed(out, p, tsAnnot(n)); },
    property_signature: (n, out) => typed(out, field(n, 'name'), tsAnnot(n)),
  } : {}),
  public_field_definition: (n, out) => {
    const k = field(n, 'name'), v = field(n, 'value');
    if (ts && tsAnnot(n)) typed(out, k, tsAnnot(n));
    else if (v?.type === 'new_expression') typed(out, k, field(v, 'constructor'), 'new');
  },
  field_definition: (n, out) => { const v = field(n, 'value'); if (v?.type === 'new_expression') typed(out, field(n, 'property'), field(v, 'constructor'), 'new'); },
  variable_declarator: (n, out) => {
    const nm = field(n, 'name'), v = field(n, 'value');
    if (nm?.type !== 'identifier') return;
    if (ts && tsAnnot(n)) typed(out, nm, tsAnnot(n));
    else if (v?.type === 'new_expression') typed(out, nm, field(v, 'constructor'), 'new');
  },
  assignment_expression: (n, out) => {
    const l = field(n, 'left'), r = field(n, 'right');
    if (r?.type !== 'new_expression') return;
    if (l?.type === 'identifier') typed(out, l, field(r, 'constructor'), 'new');
    else if (l?.type === 'member_expression' && field(l, 'object')?.type === 'this') { const p = field(l, 'property'); if (p) out.vars.push(['@' + p.text, field(r, 'constructor')?.text, line(p), 'new']); }
  },
});
const jsHandler = (ts) => handler({
  types: jsTypes(ts),
  spaces: ts ? {
    internal_module: (n, out) => { const nm = field(n, 'name'); if (nm && nm.type !== 'string') sym(out, 'space', 'namespace', n, nm, nm.text); },
    module: (n, out) => { const nm = field(n, 'name'); if (nm && nm.type !== 'string') sym(out, 'space', 'module', n, nm, nm.text); },
  } : {},
  funcs: jsFuncs,
  members: { member_expression: ['object', 'property'] },
  self: ['this'], sup: ['super'],
  extra: jsExtra(ts),
});

const PY_CALL_TYPE = (v) => (v?.type === 'call' && /^[A-Z]/.test(last(field(v, 'function')?.text ?? '')) ? field(v, 'function') : null);
const python = handler({
  types: { class_definition: named('type', 'class', { bases: (n) => baseNames(field(n, 'superclasses')).filter((b) => b !== 'object') }) },
  funcs: { function_definition: named('func', 'function') },
  members: { attribute: ['object', 'attribute'] },
  self: ['self', 'cls'], sup: ['super'],
  extra: {
    typed_parameter: (n, out) => typed(out, kids(n).find((c) => c.type === 'identifier'), field(n, 'type')),
    typed_default_parameter: (n, out) => typed(out, field(n, 'name'), field(n, 'type')),
    assignment: (n, out) => {
      const l = field(n, 'left'), t = field(n, 'type'), made = t ? null : PY_CALL_TYPE(field(n, 'right'));
      if (!t && !made) return;
      if (l?.type === 'identifier') typed(out, l, t ?? made, t ? undefined : 'call');
      else if (l?.type === 'attribute' && /^(?:self|cls)$/.test(field(l, 'object')?.text)) { const a = field(l, 'attribute'); out.vars.push(['@' + a.text, (t ?? made).text, line(a), t ? undefined : 'call']); }
    },
  },
});

const csBases = (n) => baseNames(kids(n).find((c) => c.type === 'base_list'));
const csVarDecl = (n, out) => {
  const t = field(n, 'type');
  for (const d of kids(n).filter((c) => c.type === 'variable_declarator')) {
    const nm = field(d, 'name') ?? kids(d)[0];
    if (t && t.type !== 'implicit_type') { typed(out, nm, t); continue; }
    const v = kids(d).find((c) => c.type === 'object_creation_expression');
    if (v) typed(out, nm, field(v, 'type'), 'new');
  }
};
const csharp = handler({
  types: {
    class_declaration: named('type', 'class', { bases: csBases }),
    struct_declaration: named('type', 'struct', { bases: csBases }),
    interface_declaration: named('type', 'interface', { bases: csBases }),
    enum_declaration: named('type', 'enum'),
    record_declaration: named('type', 'record', { bases: csBases }),
    record_struct_declaration: named('type', 'record struct', { bases: csBases }),
  },
  spaces: {
    namespace_declaration: named('space', 'namespace'),
    // A file-scoped namespace holds the rest of the file.
    file_scoped_namespace_declaration: (n, out, text) => { const nm = field(n, 'name'); sym(out, 'space', 'namespace', n, nm, nm?.text, { e: text.length }); },
  },
  funcs: {
    method_declaration: named('func', 'function'),
    constructor_declaration: named('func', 'function'),
    destructor_declaration: (n, out) => { const nm = field(n, 'name'); sym(out, 'func', 'function', n, nm, nm && '~' + nm.text, { body: field(n, 'body'), params: field(n, 'parameters') }); },
    local_function_statement: named('func', 'function'),
  },
  members: { member_access_expression: ['expression', 'name'] },
  self: ['this', 'this_expression'], sup: ['base', 'base_expression'],
  extra: {
    parameter: (n, out) => typed(out, field(n, 'name'), field(n, 'type')),
    variable_declaration: csVarDecl,
    property_declaration: (n, out) => typed(out, field(n, 'name'), field(n, 'type')),
    declaration_pattern: (n, out) => typed(out, field(n, 'name'), field(n, 'type')),
  },
});

const javaBases = (n) => [...baseNames(field(n, 'superclass')), ...baseNames(field(n, 'interfaces')), ...baseNames(kids(n).find((c) => c.type === 'extends_interfaces'))];
const javaDecl = (n, out) => {
  const t = field(n, 'type');
  for (const d of kids(n).filter((c) => c.type === 'variable_declarator')) {
    const v = field(d, 'value');
    if (t && t.text !== 'var') typed(out, field(d, 'name'), t);
    else if (v?.type === 'object_creation_expression') typed(out, field(d, 'name'), field(v, 'type'), 'new');
  }
};
const java = handler({
  types: {
    class_declaration: named('type', 'class', { bases: javaBases }),
    interface_declaration: named('type', 'interface', { bases: javaBases }),
    enum_declaration: named('type', 'enum', { bases: javaBases }),
    record_declaration: named('type', 'record', { bases: javaBases }),
    annotation_type_declaration: named('type', 'annotation'),
  },
  funcs: { method_declaration: named('func', 'function'), constructor_declaration: named('func', 'function'), compact_constructor_declaration: named('func', 'function') },
  members: { method_invocation: ['object', 'name'], field_access: ['object', 'field'] },
  self: ['this'], sup: ['super'],
  extra: {
    formal_parameter: (n, out) => typed(out, field(n, 'name'), field(n, 'type')),
    catch_formal_parameter: (n, out) => typed(out, field(n, 'name'), kids(n).find((c) => c.type === 'catch_type')),
    local_variable_declaration: javaDecl,
    field_declaration: javaDecl,
  },
});

const goType = (t) => (t?.type === 'pointer_type' ? goType(kids(t)[0]) : t?.type === 'generic_type' ? field(t, 'type') : t);
const goMade = (v) => {
  if (!v) return null;
  if (v.type === 'unary_expression') return goMade(field(v, 'operand'));
  if (v.type === 'composite_literal') return [field(v, 'type'), 'call'];
  if (v.type === 'call_expression') { const f = field(v, 'function'); const name = last(f?.text ?? ''); return /^New[A-Z]/.test(name) ? [f, 'call'] : null; }
  return null;
};
const go = handler({
  types: {
    type_spec: (n, out) => {
      const nm = field(n, 'name'), t = field(n, 'type');
      const form = t?.type === 'struct_type' ? 'struct' : t?.type === 'interface_type' ? 'interface' : 'type';
      sym(out, 'type', form, n, nm, nm?.text, { body: form === 'type' ? null : t, bases: [] });
    },
  },
  funcs: {
    function_declaration: named('func', 'function'),
    method_declaration: (n, out) => {
      const nm = field(n, 'name');
      const r = kids(field(n, 'receiver') ?? n).find((c) => c.type === 'parameter_declaration');
      const rt = goType(r && field(r, 'type'));
      sym(out, 'func', 'method', n, nm, nm?.text, { body: field(n, 'body'), params: field(n, 'parameters'), recv: rt?.text });
    },
    method_elem: (n, out) => { const nm = field(n, 'name'); sym(out, 'func', 'function', n, nm, nm?.text, { params: field(n, 'parameters') }); },
  },
  members: { selector_expression: ['operand', 'field'] },
  extra: {
    parameter_declaration: (n, out) => { const t = goType(field(n, 'type')); for (const c of kids(n)) if (c.type === 'identifier') typed(out, c, t); },
    field_declaration: (n, out) => { const t = goType(field(n, 'type')); for (const c of kids(n)) if (c.type === 'field_identifier') typed(out, c, t); },
    var_spec: (n, out) => {
      const t = goType(field(n, 'type'));
      const names = kids(n).filter((c) => c.type === 'identifier');
      if (t) { for (const c of names) typed(out, c, t); return; }
      const made = goMade(kids(field(n, 'value') ?? n).at(0));
      if (made && names[0]) typed(out, names[0], made[0], made[1]);
    },
    short_var_declaration: (n, out) => {
      const l = kids(field(n, 'left') ?? n)[0], made = goMade(kids(field(n, 'right') ?? n)[0]);
      if (l?.type === 'identifier' && made) typed(out, l, made[0], made[1]);
    },
  },
});

const rsType = (t) => (t?.type === 'reference_type' ? rsType(field(t, 'type')) : t);
const rsMade = (v) => {
  if (v?.type === 'struct_expression') return field(v, 'name');
  if (v?.type === 'call_expression') { const f = field(v, 'function'); if (f?.type === 'scoped_identifier') return field(f, 'path'); }
  return null;
};
const rust = handler({
  types: {
    struct_item: named('type', 'struct'),
    enum_item: named('type', 'enum'),
    union_item: named('type', 'union'),
    trait_item: named('type', 'trait'),
    type_item: named('type', 'type'),
    mod_item: (n, out) => { const b = field(n, 'body'); if (b) named('type', 'mod')(n, out); },
    impl_item: (n, out) => {
      const t = field(n, 'type'), tr = field(n, 'trait');
      const name = t ? last(t.text.replace(/<[\s\S]*$/, '')) : null;
      sym(out, 'type', 'impl', n, t, name, { body: field(n, 'body'), bases: tr ? [last(tr.text.replace(/<[\s\S]*$/, ''))] : [] });
    },
  },
  funcs: { function_item: named('func', 'function'), function_signature_item: named('func', 'function'), macro_definition: named('func', 'macro') },
  members: { field_expression: ['value', 'field'], scoped_identifier: ['path', 'name'] },
  self: ['self', 'Self'], sup: [],
  extra: {
    parameter: (n, out) => { const p = field(n, 'pattern'); if (p?.type === 'identifier') typed(out, p, rsType(field(n, 'type'))); },
    field_declaration: (n, out) => typed(out, field(n, 'name'), rsType(field(n, 'type'))),
    let_declaration: (n, out) => {
      const p = field(n, 'pattern'), t = rsType(field(n, 'type'));
      if (p?.type !== 'identifier') return;
      if (t) typed(out, p, t); else { const m = rsMade(field(n, 'value')); if (m) typed(out, p, m, 'call'); }
    },
  },
});

const cppSpec = (form) => (n, out) => {
  const nm = field(n, 'name'), b = field(n, 'body');
  if (!b) return;
  // typedef struct { ... } Name;
  const name = nm ? last(nm.text.replace(/<[\s\S]*$/, '')) : n.parent?.type === 'type_definition' ? cDeclarator(field(n.parent, 'declarator')).id?.text : null;
  sym(out, 'type', form, n, nm, name, { body: b, bases: baseNames(kids(n).find((c) => c.type === 'base_class_clause')) });
};
const cppFunc = (n, out) => {
  const { fn, id } = cDeclarator(field(n, 'declarator'));
  if (!fn) return;
  sym(out, 'func', 'function', n, id, cName(id), { body: field(n, 'body'), params: field(fn, 'parameters') });
};
const cppDecl = (n, out) => {
  const t = field(n, 'type');
  for (let i = 0; i < n.childCount; i++) {
    if (n.fieldNameForChild(i) !== 'declarator') continue;
    const c = n.child(i);
    const { fn, id } = cDeclarator(c);
    if (fn) { if (n.parent?.type !== 'compound_statement') sym(out, 'func', 'function', n, id, cName(id), { params: field(fn, 'parameters') }); continue; }
    if (!id || !/^(?:identifier|field_identifier)$/.test(id.type)) continue;
    if (t && t.type !== 'placeholder_type_specifier') { typed(out, id, t); continue; }
    const v = c.type === 'init_declarator' ? field(c, 'value') : null;
    if (v?.type === 'new_expression') typed(out, id, field(v, 'type'), 'new');
    else if (v?.type === 'call_expression') {
      const f = field(v, 'function');
      if (f && /make_(?:unique|shared)/.test(f.text)) { const arg = f.descendantsOfType?.('type_descriptor')?.[0]; if (arg) typed(out, id, arg); }
    }
  }
};
const cpp = handler({
  types: { class_specifier: cppSpec('class'), struct_specifier: cppSpec('struct'), union_specifier: cppSpec('union'), enum_specifier: cppSpec('enum') },
  spaces: { namespace_definition: (n, out) => { const nm = field(n, 'name'); if (nm) sym(out, 'space', 'namespace', n, nm, nm.text.replace(/\s+/g, ''), { body: field(n, 'body') }); } },
  funcs: { function_definition: cppFunc, preproc_function_def: (n, out) => { const nm = field(n, 'name'); sym(out, 'func', 'macro', n, nm, nm?.text, { params: field(n, 'parameters') }); } },
  members: { field_expression: ['argument', 'field'], qualified_identifier: ['scope', 'name'] },
  self: ['this'], sup: [],
  extra: {
    declaration: cppDecl,
    field_declaration: cppDecl,
    parameter_declaration: (n, out) => { const { id } = cDeclarator(field(n, 'declarator')); if (id?.type === 'identifier') typed(out, id, field(n, 'type')); },
  },
});

const ruby = handler({
  types: {
    class: named('type', 'class', { text: (nm) => last(nm.text), bases: (n) => baseNames(field(n, 'superclass')) }),
    module: named('type', 'module', { text: (nm) => last(nm.text) }),
  },
  funcs: { method: named('func', 'function'), singleton_method: named('func', 'function') },
  members: { call: ['receiver', 'method'] },
  self: ['self'], sup: ['super'],
  extra: {
    assignment: (n, out) => {
      const l = field(n, 'left'), r = field(n, 'right');
      if (r?.type !== 'call' || field(r, 'method')?.text !== 'new' || !field(r, 'receiver')) return;
      const t = field(r, 'receiver');
      if (l?.type === 'identifier') typed(out, l, t, 'call');
      else if (l?.type === 'instance_variable') out.vars.push(['@' + l.text.replace(/^@+/, ''), t.text, line(l), 'call']);
    },
  },
});

const phpBases = (n) => [...baseNames(kids(n).find((c) => c.type === 'base_clause')), ...baseNames(kids(n).find((c) => c.type === 'class_interface_clause'))];
const php = handler({
  types: {
    class_declaration: named('type', 'class', { bases: phpBases }),
    interface_declaration: named('type', 'interface', { bases: phpBases }),
    trait_declaration: named('type', 'trait'),
    enum_declaration: named('type', 'enum'),
  },
  spaces: { namespace_definition: (n, out, text) => { const nm = field(n, 'name'); if (nm) sym(out, 'space', 'namespace', n, nm, nm.text, { body: field(n, 'body'), e: field(n, 'body') ? n.endIndex : text.length }); } },
  funcs: { method_declaration: named('func', 'function'), function_definition: named('func', 'function') },
  members: { member_call_expression: ['object', 'name'], member_access_expression: ['object', 'name'], scoped_call_expression: ['scope', 'name'] },
  self: ['$this', 'self', 'static'], sup: ['parent'],
  extra: {
    simple_parameter: (n, out) => typed(out, kids(field(n, 'name') ?? n)[0] ?? field(n, 'name'), field(n, 'type')),
    property_declaration: (n, out) => { const t = field(n, 'type'); for (const el of kids(n).filter((c) => c.type === 'property_element')) typed(out, kids(field(el, 'name') ?? el)[0], t); },
    assignment_expression: (n, out) => {
      const l = field(n, 'left'), r = field(n, 'right');
      if (r?.type !== 'object_creation_expression') return;
      const t = kids(r).find((c) => c.type === 'name' || c.type === 'qualified_name');
      if (!t) return;
      if (l?.type === 'variable_name') typed(out, kids(l)[0], t, 'new');
      else if (l?.type === 'member_access_expression' && field(l, 'object')?.text === '$this') { const p = field(l, 'name'); if (p) out.vars.push(['@' + p.text, t.text, line(p), 'new']); }
    },
  },
});

const HANDLERS = { javascript: jsHandler(false), typescript: jsHandler(true), tsx: jsHandler(true), python, 'c-sharp': csharp, java, go, rust, cpp, ruby, php };
