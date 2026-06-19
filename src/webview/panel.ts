import cytoscape from "cytoscape";
// @ts-ignore – no bundled types for cytoscape-dagre
import dagre from "cytoscape-dagre";
cytoscape.use(dagre);

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
const vscode = acquireVsCodeApi();

// ── DOM ────────────────────────────────────────────────────────────────────────
const statusEl = document.getElementById("status")!;
const emptyEl  = document.getElementById("empty")!;
const rootEl   = document.getElementById("root")!;

let cy: cytoscape.Core | undefined;

// ── Messages ───────────────────────────────────────────────────────────────────
window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as { type: string; data?: DiffData; status?: string };
  if (msg.type === "status") {
    if (msg.status === "refreshing") {
      statusEl.textContent = "↻  refreshing…";
      statusEl.classList.add("visible");
      emptyEl.style.display = "none";
    } else {
      statusEl.classList.remove("visible");
    }
  } else if (msg.type === "update" && msg.data) {
    statusEl.classList.remove("visible");
    render(msg.data);
  }
});

// ── Types ──────────────────────────────────────────────────────────────────────
interface Summary { added_functions: number; modified_functions: number; removed_functions: number; modules_touched: string[]; }
interface AddedFn   { function_id: string; file_path: string; class_name: string | null; is_entry_point: boolean; new_callers: string[]; existing_callers: string[]; new_calls: string[]; existing_calls: string[]; }
interface ModifiedFn{ function_id: string; file_path: string; class_name: string | null; signature_changed: boolean; calls_added_new: string[]; calls_added_existing: string[]; calls_removed: string[]; callers: string[]; }
interface RemovedFn { function_id: string; file_path: string; class_name: string | null; was_called_by: string[]; }
interface DiffData  { schema_version: string; base_ref: string; head_ref: string; summary: Summary; added: AddedFn[]; modified: ModifiedFn[]; removed: RemovedFn[]; }

// ── Change colours ─────────────────────────────────────────────────────────────
const C = {
  added:    { border: "#4ade80", header: "#16a34a", text: "#14532d", bg: "#f0fdf4" },
  modified: { border: "#fbbf24", header: "#d97706", text: "#78350f", bg: "#fefce8" },
  removed:  { border: "#f87171", header: "#dc2626", text: "#7f1d1d", bg: "#fff1f2" },
} as const;
type ChangeType = keyof typeof C;

// ── Helpers ────────────────────────────────────────────────────────────────────
const san  = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "_");
const last = (id: string) => id.split(".").at(-1) ?? id;

type Members = { added: AddedFn[]; modified: ModifiedFn[]; removed: RemovedFn[] };

function dominant(m: Members): ChangeType {
  if (!m.added.length && !m.modified.length) return "removed";
  if (!m.modified.length && !m.removed.length) return "added";
  return "modified";
}

function buildLabel(className: string | null, m: Members): string {
  const title = className ?? "«standalone»";
  const sep   = "─".repeat(Math.max(title.length, 14));
  const lines: string[] = [title, sep];

  const hint = (fn: AddedFn) =>
    fn.is_entry_point ? "  ⦿" :
    fn.new_callers.length + fn.existing_callers.length > 0 ? `  ←${fn.new_callers.length + fn.existing_callers.length}` : "";

  for (const fn of m.added)    lines.push(`+ ${last(fn.function_id)}()${hint(fn)}`);
  for (const fn of m.modified) {
    const h = fn.signature_changed ? " sig" : fn.calls_added_new.length || fn.calls_removed.length ? " calls" : " body";
    lines.push(`~ ${last(fn.function_id)}()${h}`);
  }
  for (const fn of m.removed)  lines.push(`− ${last(fn.function_id)}()`);

  return lines.join("\n");
}

// ── Build Cytoscape elements ───────────────────────────────────────────────────
function buildElements(data: DiffData): cytoscape.ElementDefinition[] {
  const els: cytoscape.ElementDefinition[] = [];

  // Group by file → class
  const byFile = new Map<string, Map<string | null, Members>>();
  const ensure = (fp: string, cn: string | null) => {
    if (!byFile.has(fp)) byFile.set(fp, new Map());
    const m = byFile.get(fp)!;
    if (!m.has(cn)) m.set(cn, { added: [], modified: [], removed: [] });
    return m.get(cn)!;
  };
  data.added.forEach(fn    => ensure(fn.file_path, fn.class_name).added.push(fn));
  data.modified.forEach(fn => ensure(fn.file_path, fn.class_name).modified.push(fn));
  data.removed.forEach(fn  => ensure(fn.file_path, fn.class_name).removed.push(fn));

  // Build fn_id → node id lookup for edges
  const fidToNid = new Map<string, string>();

  for (const [filePath, classes] of byFile) {
    const nsId = `ns_${san(filePath)}`;

    // Namespace parent node
    els.push({ data: { id: nsId, label: filePath.replace(/\.py$/, ""), type: "namespace" } });

    for (const [className, members] of classes) {
      const nid = className
        ? `cls_${san(filePath)}_${san(className)}`
        : `mod_${san(filePath)}`;
      const change = dominant(members);

      els.push({
        data: {
          id:        nid,
          parent:    nsId,
          label:     buildLabel(className, members),
          type:      "class",
          change,
          filePath,
          className: className ?? null,
          // Primary functionId for navigation (first changed fn in this class)
          functionId: [
            ...members.added.map(f => f.function_id),
            ...members.modified.map(f => f.function_id),
            ...members.removed.map(f => f.function_id),
          ][0] ?? "",
        },
      });

      // Register all member fn_ids → this node
      [...members.added, ...members.modified, ...members.removed]
        .forEach(fn => fidToNid.set(fn.function_id, nid));
    }
  }

  // Edges between class nodes (deduplicated)
  const seen = new Set<string>();
  const addEdge = (srcNid: string, dstNid: string, style: "solid" | "dashed") => {
    if (srcNid === dstNid) return;
    const key = `${srcNid}→${dstNid}`;
    if (seen.has(key)) return;
    seen.add(key);
    els.push({ data: { source: srcNid, target: dstNid, style } });
  };

  data.added.forEach(fn => {
    const src = fidToNid.get(fn.function_id);
    if (!src) return;
    [...fn.new_calls, ...fn.new_callers].forEach(fid => {
      const dst = fidToNid.get(fid);
      if (dst) addEdge(src, dst, "solid");
    });
  });
  data.modified.forEach(fn => {
    const src = fidToNid.get(fn.function_id);
    if (!src) return;
    fn.calls_added_new.forEach(fid => {
      const dst = fidToNid.get(fid);
      if (dst) addEdge(src, dst, "solid");
    });
    fn.calls_removed.forEach(fid => {
      const dst = fidToNid.get(fid);
      if (dst) addEdge(src, dst, "dashed");
    });
  });

  return els;
}

// ── Cytoscape styles ───────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildStyle(): any[] {
  // Namespace style
  const nsStyle: cytoscape.Css.Node = {
    "background-color":    "#0f172a",
    "background-opacity":  0.9,
    "border-width":        0,
    "label":               "data(label)",
    "color":               "#94a3b8",
    "font-family":         "ui-monospace, SFMono-Regular, Menlo, monospace",
    "font-size":           "11px",
    "text-valign":         "bottom",
    "text-halign":         "center",
    "text-margin-y":       6,
    "shape":               "round-rectangle",
    "padding":             "16px",
  };

  // Base class style (overridden per change type below)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const classBase: any = {
    "shape":               "round-rectangle",
    "label":               "data(label)",
    "font-family":         "ui-monospace, SFMono-Regular, Menlo, monospace",
    "font-size":           "12px",
    "text-valign":         "center",
    "text-halign":         "left",
    "text-wrap":           "pre",
    "text-max-width":      "280px",
    "padding":             "10px 14px",
    "border-width":        2,
    "width":               "label",
    "height":              "label",
    "text-background-opacity": 0,
    "transition-property":     "border-width, border-color",
    "transition-duration":     "0.1s",
  };

  // Hover
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const classHover: any = {
    "border-width": 3,
    "cursor": "pointer",
  };

  // Edge style
  const edgeSolid: cytoscape.Css.Edge = {
    "width":             2,
    "line-color":        "#64748b",
    "target-arrow-color":"#64748b",
    "target-arrow-shape":"triangle",
    "curve-style":       "bezier",
    "arrow-scale":       1.2,
  };
  const edgeDashed: cytoscape.Css.Edge = {
    ...edgeSolid,
    "line-style":        "dashed",
    "line-color":        "#f87171",
    "target-arrow-color":"#f87171",
  };

  return [
    { selector: "[type='namespace']",             style: nsStyle   },
    { selector: "[type='class']",                 style: { ...classBase, "background-color": "#ffffff", "border-color": "#e2e8f0", "color": "#1e293b" } },
    { selector: "[type='class'][change='added']",   style: { "background-color": C.added.bg,    "border-color": C.added.border,    "color": C.added.text    } },
    { selector: "[type='class'][change='modified']",style: { "background-color": C.modified.bg, "border-color": C.modified.border, "color": C.modified.text } },
    { selector: "[type='class'][change='removed']", style: { "background-color": C.removed.bg,  "border-color": C.removed.border,  "color": C.removed.text  } },
    { selector: "[type='class']:hover",             style: classHover },
    { selector: "[style='solid']",                  style: edgeSolid  },
    { selector: "[style='dashed']",                 style: edgeDashed },
  ];
}

// ── Main render ────────────────────────────────────────────────────────────────
function render(data: DiffData) {
  emptyEl.style.display = "none";
  rootEl.innerHTML = "";

  const total = data.summary.added_functions + data.summary.modified_functions + data.summary.removed_functions;
  if (total === 0) {
    rootEl.innerHTML = `<p class="empty">No structural changes between <code>${esc(data.base_ref)}</code> and <code>${esc(data.head_ref)}</code>.</p>`;
    return;
  }

  // ── Summary bar ──────────────────────────────────────────────────────────────
  const parts: string[] = [`<div class="summary">`];
  if (data.summary.added_functions)    parts.push(`<span class="badge add">+${data.summary.added_functions} added</span>`);
  if (data.summary.modified_functions) parts.push(`<span class="badge mod">~${data.summary.modified_functions} modified</span>`);
  if (data.summary.removed_functions)  parts.push(`<span class="badge rem">−${data.summary.removed_functions} removed</span>`);
  parts.push(`<span class="muted">${data.summary.modules_touched.length} modules</span>`);
  parts.push(`<span class="muted ref">${esc(data.base_ref)} → ${esc(data.head_ref)}</span>`);
  parts.push(`</div>`);

  // ── Zoom controls ─────────────────────────────────────────────────────────────
  parts.push(`
    <div class="zoom-controls">
      <button id="zoom-in"  title="Zoom in">+</button>
      <button id="zoom-fit" title="Fit to screen">⊡</button>
      <button id="zoom-out" title="Zoom out">−</button>
    </div>
  `);

  // ── Cytoscape container ───────────────────────────────────────────────────────
  parts.push(`<div id="cy"></div>`);
  rootEl.innerHTML = parts.join("");

  const cyEl = document.getElementById("cy")!;

  cy = cytoscape({
    container: cyEl,
    elements:  buildElements(data),
    style:     buildStyle(),
    // @ts-ignore – dagre options not in base type
    layout: {
      name:     "dagre",
      rankDir:  "LR",
      rankSep:  100,
      nodeSep:  30,
      edgeSep:  10,
      padding:  30,
      compound: true,
      ranker:   "tight-tree",
    } as cytoscape.LayoutOptions,
    minZoom: 0.05,
    maxZoom: 4,
    wheelSensitivity: 0.2,
    boxSelectionEnabled: false,
    userPanningEnabled:  true,
    userZoomingEnabled:  true,
  });

  // Click → navigate to file
  cy.on("tap", "node[type='class']", (evt) => {
    const d = evt.target.data();
    if (d.functionId && d.filePath) {
      vscode.postMessage({ type: "navigate", functionId: d.functionId, filePath: d.filePath });
    }
  });

  // Zoom controls
  document.getElementById("zoom-in")! .addEventListener("click", () => cy!.zoom({ level: cy!.zoom() * 1.3, renderedPosition: { x: cyEl.clientWidth / 2, y: cyEl.clientHeight / 2 } }));
  document.getElementById("zoom-out")!.addEventListener("click", () => cy!.zoom({ level: cy!.zoom() / 1.3, renderedPosition: { x: cyEl.clientWidth / 2, y: cyEl.clientHeight / 2 } }));
  document.getElementById("zoom-fit")!.addEventListener("click", () => cy!.fit(undefined, 30));
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
