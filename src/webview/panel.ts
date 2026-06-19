// @ts-ignore – @dagrejs/dagre ships its own types
import dagre from "@dagrejs/dagre";

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
const vscode = acquireVsCodeApi();

// ── DOM ────────────────────────────────────────────────────────────────────────
const statusEl = document.getElementById("status")!;
const emptyEl  = document.getElementById("empty")!;
const rootEl   = document.getElementById("root")!;

// ── Messages ───────────────────────────────────────────────────────────────────
window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as { type: string; data?: DiffData; status?: string };
  if (msg.type === "status") {
    statusEl.textContent = msg.status === "refreshing" ? "↻  refreshing…" : "";
    statusEl.classList.toggle("visible", msg.status === "refreshing");
    if (msg.status === "refreshing") emptyEl.style.display = "none";
  } else if (msg.type === "update" && msg.data) {
    statusEl.classList.remove("visible");
    render(msg.data);
  }
});

// ── Types ──────────────────────────────────────────────────────────────────────
interface AddedFn   { function_id: string; file_path: string; class_name: string|null; is_entry_point: boolean; new_callers: string[]; existing_callers: string[]; new_calls: string[]; existing_calls: string[]; }
interface ModifiedFn{ function_id: string; file_path: string; class_name: string|null; signature_changed: boolean; calls_added_new: string[]; calls_added_existing: string[]; calls_removed: string[]; callers: string[]; }
interface RemovedFn { function_id: string; file_path: string; class_name: string|null; was_called_by: string[]; }
interface DiffData  { base_ref: string; head_ref: string; summary: { added_functions: number; modified_functions: number; removed_functions: number; modules_touched: string[] }; added: AddedFn[]; modified: ModifiedFn[]; removed: RemovedFn[]; }

type ChangeType = "added" | "modified" | "removed";
const C: Record<ChangeType, { header: string; border: string; bg: string; text: string; prefix_color: string }> = {
  added:    { header: "#16a34a", border: "#4ade80", bg: "#f0fdf4", text: "#14532d", prefix_color: "#16a34a" },
  modified: { header: "#d97706", border: "#fbbf24", bg: "#fefce8", text: "#78350f", prefix_color: "#d97706" },
  removed:  { header: "#dc2626", border: "#f87171", bg: "#fff1f2", text: "#7f1d1d", prefix_color: "#dc2626" },
};

// ── Layout constants ───────────────────────────────────────────────────────────
const FONT_SIZE   = 12;
const CHAR_W      = 7;        // monospace char width at 12px
const HEADER_H    = 54;       // file path + class name
const ROW_H       = 24;       // per-method row
const PAD_V       = 10;       // bottom padding
const MIN_W       = 180;
const H_PAD       = 24;       // horizontal text padding

interface MethodRow { functionId: string; filePath: string; prefix: string; name: string; hint: string; }
interface NodeDef   { id: string; filePath: string; className: string|null; change: ChangeType; methods: MethodRow[]; w: number; h: number; x?: number; y?: number; functionId: string; }
interface EdgeDef   { src: string; dst: string; style: "solid"|"dashed"; points?: {x:number;y:number}[]; }

const san  = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "_");
const last = (id: string) => id.split(".").at(-1) ?? id;
const esc  = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

function nodeWidth(methods: MethodRow[], className: string|null, filePath: string): number {
  const file  = filePath.split("/").at(-1)?.replace(/\.py$/,"") ?? "";
  const title = className ?? "«standalone»";
  const lines = [file, title, ...methods.map(m => `${m.prefix} ${m.name}()  ${m.hint}`)];
  const maxLen = Math.max(...lines.map(l => l.length));
  return Math.max(MIN_W, maxLen * CHAR_W + H_PAD * 2);
}

// ── Build graph ────────────────────────────────────────────────────────────────
function buildGraph(data: DiffData): { nodes: NodeDef[]; edges: EdgeDef[] } {
  type Members = { added: AddedFn[]; modified: ModifiedFn[]; removed: RemovedFn[] };
  const byFile = new Map<string, Map<string|null, Members>>();
  const ensure = (fp: string, cn: string|null) => {
    if (!byFile.has(fp)) byFile.set(fp, new Map());
    const m = byFile.get(fp)!;
    if (!m.has(cn)) m.set(cn, { added: [], modified: [], removed: [] });
    return m.get(cn)!;
  };
  data.added.forEach(fn    => ensure(fn.file_path, fn.class_name).added.push(fn));
  data.modified.forEach(fn => ensure(fn.file_path, fn.class_name).modified.push(fn));
  data.removed.forEach(fn  => ensure(fn.file_path, fn.class_name).removed.push(fn));

  const nodes: NodeDef[] = [];
  const fidToNid = new Map<string, string>();

  for (const [filePath, classes] of byFile) {
    for (const [className, members] of classes) {
      const nid = className ? `cls_${san(filePath)}_${san(className)}` : `mod_${san(filePath)}`;

      const change: ChangeType =
        !members.added.length && !members.modified.length ? "removed" :
        !members.modified.length && !members.removed.length ? "added" : "modified";

      const methods: MethodRow[] = [
        ...members.added.map(fn => ({
          functionId: fn.function_id, filePath: fn.file_path,
          prefix: "+", name: last(fn.function_id),
          hint: fn.is_entry_point ? "entry" : (fn.new_callers.length + fn.existing_callers.length) > 0 ? `←${fn.new_callers.length + fn.existing_callers.length}` : "",
        })),
        ...members.modified.map(fn => ({
          functionId: fn.function_id, filePath: fn.file_path,
          prefix: "~", name: last(fn.function_id),
          hint: fn.signature_changed ? "sig" : (fn.calls_added_new.length || fn.calls_removed.length) ? "calls" : "body",
        })),
        ...members.removed.map(fn => ({
          functionId: fn.function_id, filePath: fn.file_path,
          prefix: "−", name: last(fn.function_id),
          hint: fn.was_called_by.length ? `←${fn.was_called_by.length}` : "",
        })),
      ];

      const w = nodeWidth(methods, className, filePath);
      const h = HEADER_H + methods.length * ROW_H + PAD_V;

      nodes.push({ id: nid, filePath, className, change, methods, w, h,
        functionId: [...members.added, ...members.modified, ...members.removed][0]?.function_id ?? "" });

      [...members.added, ...members.modified, ...members.removed]
        .forEach(fn => fidToNid.set(fn.function_id, nid));
    }
  }

  const seen = new Set<string>();
  const edges: EdgeDef[] = [];
  const addEdge = (s: string, d: string, style: "solid"|"dashed") => {
    if (s === d) return;
    const key = `${s}→${d}`;
    if (seen.has(key)) return; seen.add(key);
    edges.push({ src: s, dst: d, style });
  };
  data.added.forEach(fn => {
    const src = fidToNid.get(fn.function_id); if (!src) return;
    [...fn.new_calls, ...fn.new_callers].forEach(fid => { const d = fidToNid.get(fid); if (d) addEdge(src, d, "solid"); });
  });
  data.modified.forEach(fn => {
    const src = fidToNid.get(fn.function_id); if (!src) return;
    fn.calls_added_new.forEach(fid => { const d = fidToNid.get(fid); if (d) addEdge(src, d, "solid"); });
    fn.calls_removed.forEach(fid  => { const d = fidToNid.get(fid); if (d) addEdge(src, d, "dashed"); });
  });

  return { nodes, edges };
}

// ── Dagre layout ───────────────────────────────────────────────────────────────
function runLayout(nodes: NodeDef[], edges: EdgeDef[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", ranksep: 120, nodesep: 50, marginx: 40, marginy: 40, edgesep: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach(n => g.setNode(n.id, { width: n.w, height: n.h }));
  edges.forEach(e => g.setEdge(e.src, e.dst));
  dagre.layout(g);
  nodes.forEach(n => {
    const p = g.node(n.id);
    n.x = p.x - n.w / 2;
    n.y = p.y - n.h / 2;
  });
  edges.forEach(e => {
    const ed = g.edge(e.src, e.dst);
    e.points = ed?.points ?? [];
  });
}

// ── SVG rendering ─────────────────────────────────────────────────────────────
function renderSVG(nodes: NodeDef[], edges: EdgeDef[]): string {
  const maxX = Math.max(...nodes.map(n => n.x! + n.w)) + 60;
  const maxY = Math.max(...nodes.map(n => n.y! + n.h)) + 60;

  const parts: string[] = [];
  parts.push(`<svg id="uml-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${maxX} ${maxY}" style="width:100%;height:100%;display:block">`);

  // Arrow markers
  parts.push(`<defs>
    <marker id="arr-solid" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#475569"/>
    </marker>
    <marker id="arr-dashed" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#f87171"/>
    </marker>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="rgba(0,0,0,0.15)"/>
    </filter>
  </defs>`);

  // Namespace background groups (one rect per unique file)
  const fileGroups = new Map<string, NodeDef[]>();
  nodes.forEach(n => { if (!fileGroups.has(n.filePath)) fileGroups.set(n.filePath, []); fileGroups.get(n.filePath)!.push(n); });
  for (const [fp, grpNodes] of fileGroups) {
    const gx = Math.min(...grpNodes.map(n => n.x!)) - 16;
    const gy = Math.min(...grpNodes.map(n => n.y!)) - 32;
    const gw = Math.max(...grpNodes.map(n => n.x! + n.w)) - gx + 16;
    const gh = Math.max(...grpNodes.map(n => n.y! + n.h)) - gy + 16;
    const file = fp.replace(/\.py$/,"");
    parts.push(`<rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" rx="12" fill="#0f172a" opacity="0.06"/>`);
    parts.push(`<text x="${gx+12}" y="${gy+14}" font-size="10" font-family="monospace" fill="#64748b">📄 ${esc(file)}.py</text>`);
  }

  // Edges
  edges.forEach(e => {
    if (!e.points?.length) return;
    const solid = e.style === "solid";
    const color = solid ? "#475569" : "#f87171";
    const pts = e.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
    parts.push(`<path d="${pts}" fill="none" stroke="${color}" stroke-width="1.5"
      ${solid ? "" : `stroke-dasharray="6,3"`}
      marker-end="url(#arr-${solid ? "solid" : "dashed"})"/>`);
  });

  // Class nodes
  nodes.forEach(n => {
    const { x, y, w, h, change, filePath, className, methods } = n;
    const col = C[change];
    const cx = x!;
    const cy = y!;
    const title = className ?? "«standalone»";

    parts.push(`<g class="uml-node" data-nid="${esc(n.id)}">`);

    // Drop shadow + outer box
    parts.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" rx="8" fill="${col.bg}" stroke="${col.border}" stroke-width="2" filter="url(#shadow)"/>`);

    // Coloured header
    parts.push(`<clipPath id="clip_${san(n.id)}"><rect x="${cx}" y="${cy}" width="${w}" height="${HEADER_H}" rx="8"/></clipPath>`);
    parts.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${HEADER_H}" fill="${col.header}" clip-path="url(#clip_${san(n.id)})"/>`);

    // Class name (white, bold, centered)
    parts.push(`<text x="${cx + w/2}" y="${cy + 34}" text-anchor="middle" font-size="13" font-weight="bold" font-family="ui-monospace,monospace" fill="white">${esc(title)}</text>`);

    // Separator
    parts.push(`<line x1="${cx}" y1="${cy+HEADER_H}" x2="${cx+w}" y2="${cy+HEADER_H}" stroke="${col.border}" stroke-width="1"/>`);

    // Method rows — each is individually clickable
    methods.forEach((m, i) => {
      const ry  = cy + HEADER_H + i * ROW_H;
      const pcol = m.prefix === "+" ? "#16a34a" : m.prefix === "~" ? "#d97706" : "#dc2626";
      const fcol = m.prefix === "−" ? "#9ca3af" : col.text;
      // Hover background
      parts.push(`<rect class="method-bg" x="${cx+2}" y="${ry+2}" width="${w-4}" height="${ROW_H-2}" rx="4" fill="transparent"/>`);
      parts.push(`<text x="${cx+H_PAD}" y="${ry + ROW_H - 7}" font-size="${FONT_SIZE}" font-family="ui-monospace,monospace"
        class="method-text" data-fid="${esc(m.functionId)}" data-fp="${esc(m.filePath)}" style="cursor:pointer">
        <tspan fill="${pcol}" font-weight="bold">${m.prefix}</tspan>
        <tspan fill="${fcol}" ${m.prefix === "−" ? "text-decoration='line-through'" : ""}> ${esc(m.name)}()</tspan>
        ${m.hint ? `<tspan fill="#94a3b8" font-size="10"> ${esc(m.hint)}</tspan>` : ""}
      </text>`);
    });

    parts.push(`</g>`);
  });

  parts.push(`</svg>`);
  return parts.join("\n");
}

// ── Pan / zoom ─────────────────────────────────────────────────────────────────
function initPanZoom(svgEl: SVGSVGElement) {
  let scale = 1, tx = 0, ty = 0;
  let drag = false, ox = 0, oy = 0;

  const apply = () => svgEl.setAttribute("viewBox",
    `${-tx/scale} ${-ty/scale} ${svgEl.clientWidth/scale} ${svgEl.clientHeight/scale}`);

  svgEl.addEventListener("wheel", e => {
    e.preventDefault();
    const r = svgEl.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f  = e.deltaY < 0 ? 1.15 : 1/1.15;
    tx = mx - f * (mx - tx);
    ty = my - f * (my - ty);
    scale *= f;
    apply();
  }, { passive: false });

  svgEl.addEventListener("mousedown", e => { drag = true; ox = e.clientX - tx; oy = e.clientY - ty; svgEl.style.cursor = "grabbing"; });
  window.addEventListener("mousemove", e => { if (!drag) return; tx = e.clientX - ox; ty = e.clientY - oy; apply(); });
  window.addEventListener("mouseup",   () => { drag = false; svgEl.style.cursor = "default"; });
}

// ── Main render ────────────────────────────────────────────────────────────────
function render(data: DiffData) {
  emptyEl.style.display = "none";
  rootEl.innerHTML      = "";

  const total = data.summary.added_functions + data.summary.modified_functions + data.summary.removed_functions;
  if (total === 0) {
    rootEl.innerHTML = `<p class="empty">No structural changes.</p>`;
    return;
  }

  // Summary bar
  const badgeParts: string[] = [];
  if (data.summary.added_functions)    badgeParts.push(`<span class="badge add">+${data.summary.added_functions} added</span>`);
  if (data.summary.modified_functions) badgeParts.push(`<span class="badge mod">~${data.summary.modified_functions} modified</span>`);
  if (data.summary.removed_functions)  badgeParts.push(`<span class="badge rem">−${data.summary.removed_functions} removed</span>`);
  badgeParts.push(`<span class="muted">${data.summary.modules_touched.length} modules</span>`);
  badgeParts.push(`<span class="muted ref">${esc(data.base_ref)} → ${esc(data.head_ref)}</span>`);

  const summaryHtml  = `<div class="summary">${badgeParts.join("")}</div>`;
  const zoomHtml     = `<div class="zoom-controls"><button id="z-in">+</button><button id="z-fit">⊡</button><button id="z-out">−</button></div>`;
  const diagramHtml  = `<div id="diagram-wrap" style="flex:1;position:relative;overflow:hidden"></div>`;
  rootEl.innerHTML   = summaryHtml + zoomHtml + diagramHtml;

  const { nodes, edges } = buildGraph(data);
  runLayout(nodes, edges);

  const wrap = document.getElementById("diagram-wrap")!;
  wrap.innerHTML = renderSVG(nodes, edges);

  const svgEl = wrap.querySelector<SVGSVGElement>("#uml-svg")!;
  initPanZoom(svgEl);

  // Zoom control buttons
  const fit = () => { svgEl.setAttribute("viewBox", `0 0 ${svgEl.viewBox.baseVal.width} ${svgEl.viewBox.baseVal.height}`); };
  document.getElementById("z-in")! .addEventListener("click", () => { const vb = svgEl.viewBox.baseVal; const cx = vb.x + vb.width/2; const cy = vb.y + vb.height/2; svgEl.setAttribute("viewBox", `${cx - vb.width/2.6} ${cy - vb.height/2.6} ${vb.width/1.3} ${vb.height/1.3}`); });
  document.getElementById("z-out")!.addEventListener("click", () => { const vb = svgEl.viewBox.baseVal; const cx = vb.x + vb.width/2; const cy = vb.y + vb.height/2; svgEl.setAttribute("viewBox", `${cx - vb.width*0.65} ${cy - vb.height*0.65} ${vb.width*1.3} ${vb.height*1.3}`); });
  document.getElementById("z-fit")!.addEventListener("click", fit);

  // Per-method click → navigate
  svgEl.querySelectorAll<SVGTextElement>(".method-text").forEach(el => {
    el.addEventListener("click", e => {
      e.stopPropagation();
      vscode.postMessage({ type: "navigate", functionId: el.dataset.fid, filePath: el.dataset.fp });
    });
  });

  // Hover highlight on method rows
  svgEl.querySelectorAll<SVGTextElement>(".method-text").forEach(el => {
    const bg = el.previousElementSibling as SVGRectElement | null;
    el.addEventListener("mouseenter", () => { bg?.setAttribute("fill", "rgba(0,0,0,0.06)"); });
    el.addEventListener("mouseleave", () => { bg?.setAttribute("fill", "transparent"); });
  });
}
