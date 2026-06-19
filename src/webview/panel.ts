// @ts-ignore – elk.bundled is a self-contained browser build
import ELK from "elkjs/lib/elk.bundled.js";

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
const vscode = acquireVsCodeApi();

// ── DOM ────────────────────────────────────────────────────────────────────────
const statusEl = document.getElementById("status")!;
const emptyEl  = document.getElementById("empty")!;
const rootEl   = document.getElementById("root")!;

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as { type: string; data?: DiffData; status?: string };
  if (msg.type === "status") {
    statusEl.textContent = msg.status === "refreshing" ? "↻  refreshing…" : "";
    statusEl.classList.toggle("visible", msg.status === "refreshing");
    if (msg.status === "refreshing") emptyEl.style.display = "none";
  } else if (msg.type === "update" && msg.data) {
    statusEl.classList.remove("visible");
    render(msg.data).catch(console.error);
  }
});

// ── Types ──────────────────────────────────────────────────────────────────────
interface AddedFn   { function_id:string; file_path:string; class_name:string|null; is_entry_point:boolean; new_callers:string[]; existing_callers:string[]; new_calls:string[]; }
interface ModifiedFn{ function_id:string; file_path:string; class_name:string|null; signature_changed:boolean; calls_added_new:string[]; calls_added_existing:string[]; calls_removed:string[]; callers:string[]; }
interface RemovedFn { function_id:string; file_path:string; class_name:string|null; was_called_by:string[]; }
interface DiffData  { base_ref:string; head_ref:string; summary:{added_functions:number;modified_functions:number;removed_functions:number;modules_touched:string[];}; added:AddedFn[]; modified:ModifiedFn[]; removed:RemovedFn[]; }

type Change = "added"|"modified"|"removed";
const COLORS: Record<Change,{header:string;border:string;bg:string;text:string}> = {
  added:    {header:"#16a34a", border:"#4ade80", bg:"#f0fdf4", text:"#14532d"},
  modified: {header:"#d97706", border:"#fbbf24", bg:"#fefce8", text:"#78350f"},
  removed:  {header:"#dc2626", border:"#f87171", bg:"#fff1f2", text:"#7f1d1d"},
};

// ── Node geometry constants ────────────────────────────────────────────────────
const CHAR_W  = 7;    // monospace px/char @12px
const HDR_H   = 34;   // class header height
const ROW_H   = 22;   // method row height
const PAD_B   = 10;   // bottom padding
const MIN_W   = 160;
const H_PAD   = 20;   // horizontal text margin
const NS_PAD  = 16;   // namespace inner padding
const NS_HDR  = 28;   // namespace header strip height

interface Method { fid:string; fp:string; prefix:string; name:string; hint:string; }
interface Node   { id:string; fp:string; cn:string|null; change:Change; methods:Method[]; w:number; h:number; x:number; y:number; fid:string; }
interface Edge   {
  src:string; dst:string;          // class node IDs — used by ELK for layout
  callerFid:string; calleeFid:string; // function IDs — used for SVG anchor points
  style:"solid"|"dashed";
  pts?:{x:number;y:number}[];
}

const san  = (s:string) => s.replace(/[^a-zA-Z0-9]/g,"_");
const last = (id:string) => id.split(".").at(-1) ?? id;
const esc  = (s:string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

function nodeWidth(methods:Method[], cn:string|null): number {
  const title = cn ?? "«standalone»";
  const lens  = [title.length, ...methods.map(m => (m.prefix+" "+m.name+"()  "+m.hint).length)];
  return Math.max(MIN_W, Math.max(...lens) * CHAR_W + H_PAD * 2);
}

// ── Build flat graph ───────────────────────────────────────────────────────────
function buildGraph(data:DiffData): {nodes:Node[]; edges:Edge[]} {
  type Mbrs = {added:AddedFn[];modified:ModifiedFn[];removed:RemovedFn[]};
  const byFile = new Map<string,Map<string|null,Mbrs>>();
  const ensure = (fp:string,cn:string|null) => {
    if (!byFile.has(fp)) byFile.set(fp,new Map());
    const m = byFile.get(fp)!;
    if (!m.has(cn)) m.set(cn,{added:[],modified:[],removed:[]});
    return m.get(cn)!;
  };
  data.added.forEach(fn    => ensure(fn.file_path,fn.class_name).added.push(fn));
  data.modified.forEach(fn => ensure(fn.file_path,fn.class_name).modified.push(fn));
  data.removed.forEach(fn  => ensure(fn.file_path,fn.class_name).removed.push(fn));

  const nodes:Node[] = [];
  const fidMap = new Map<string,string>();

  for (const [fp,classes] of byFile) {
    for (const [cn,mbrs] of classes) {
      const nid = cn ? `c_${san(fp)}_${san(cn)}` : `m_${san(fp)}`;
      const change:Change = !mbrs.added.length&&!mbrs.modified.length ? "removed"
                          : !mbrs.modified.length&&!mbrs.removed.length ? "added" : "modified";
      const methods:Method[] = [
        ...mbrs.added.map(fn => ({fid:fn.function_id,fp:fn.file_path,prefix:"+",name:last(fn.function_id),
          hint:fn.is_entry_point?"entry":(fn.new_callers.length+fn.existing_callers.length)>0?`←${fn.new_callers.length+fn.existing_callers.length}`:""})),
        ...mbrs.modified.map(fn => ({fid:fn.function_id,fp:fn.file_path,prefix:"~",name:last(fn.function_id),
          hint:fn.signature_changed?"sig":(fn.calls_added_new.length||fn.calls_removed.length)?"calls":"body"})),
        ...mbrs.removed.map(fn => ({fid:fn.function_id,fp:fn.file_path,prefix:"−",name:last(fn.function_id),
          hint:fn.was_called_by.length?`←${fn.was_called_by.length}`:""})),
      ];
      const w = nodeWidth(methods,cn);
      const h = HDR_H + methods.length*ROW_H + PAD_B;
      nodes.push({id:nid,fp,cn,change,methods,w,h,x:0,y:0,
        fid:[...mbrs.added,...mbrs.modified,...mbrs.removed][0]?.function_id??""});
      [...mbrs.added,...mbrs.modified,...mbrs.removed].forEach(fn => fidMap.set(fn.function_id,nid));
    }
  }

  const seen = new Set<string>();
  const edges:Edge[] = [];
  // Edges at function level: callerFid → calleeFid
  // ELK uses class-level src/dst for layout; SVG uses fids for method anchors
  const addE = (callerFid:string, calleeFid:string, style:"solid"|"dashed") => {
    const s=fidMap.get(callerFid), d=fidMap.get(calleeFid);
    if (!s||!d||s===d) return;
    const k=`${callerFid}→${calleeFid}`; if (seen.has(k)) return; seen.add(k);
    edges.push({src:s,dst:d,callerFid,calleeFid,style});
  };
  data.added.forEach(fn => {
    fn.new_calls.forEach(fid    => addE(fn.function_id,fid,"solid"));
    fn.new_callers.forEach(fid  => addE(fid,fn.function_id,"solid"));
  });
  data.modified.forEach(fn => {
    fn.calls_added_new.forEach(fid => addE(fn.function_id,fid,"solid"));
    fn.calls_removed.forEach(fid   => addE(fn.function_id,fid,"dashed"));
  });
  return {nodes,edges};
}

// ── ELK layout (compound: namespace parents contain class children) ───────────
async function layoutELK(nodes:Node[], edges:Edge[]): Promise<void> {
  // Group nodes by file for compound namespace nodes
  const byFile = new Map<string,Node[]>();
  nodes.forEach(n => {if(!byFile.has(n.fp))byFile.set(n.fp,[]);byFile.get(n.fp)!.push(n);});

  const nMap = new Map(nodes.map(n => [n.id,n]));

  // Build ELK compound graph: each file = compound parent, classes = children
  const elkChildren = [...byFile.entries()].map(([fp,fnodes]) => ({
    id: `ns_${san(fp)}`,
    layoutOptions: {
      "elk.algorithm":          "layered",
      "elk.direction":          "DOWN",
      "elk.spacing.nodeNode":   "20",
      "elk.padding":            `[top=${NS_HDR+NS_PAD}, left=${NS_PAD}, bottom=${NS_PAD}, right=${NS_PAD}]`,
    },
    children: fnodes.map(n => ({id:n.id, width:n.w, height:n.h})),
    edges: [],
  }));

  // Edges: only cross-namespace edges go at root level
  // (ELK requires edges inside the lowest common ancestor)
  const nToNs = new Map(nodes.map(n => [n.id, `ns_${san(n.fp)}`]));
  const crossEdges = edges
    .filter(e => nToNs.get(e.src) !== nToNs.get(e.dst))
    .map((e,i) => ({id:`e${i}`, sources:[e.src], targets:[e.dst]}));

  const elk = new ELK();
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm":                              "layered",
      "elk.direction":                              "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers":  "80",
      "elk.spacing.nodeNode":                       "40",
      "elk.layered.nodePlacement.strategy":         "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy":  "LAYER_SWEEP",
      "elk.edgeRouting":                            "SPLINES",
      "elk.padding":                                "[top=30, left=30, bottom=30, right=30]",
    },
    children: elkChildren,
    edges:    crossEdges,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await elk.layout(graph as any);

  // Extract compound (namespace) positions and sizes
  const nsPos = new Map<string,{x:number;y:number;w:number;h:number}>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const child of (result.children ?? []) as any[]) {
    nsPos.set(child.id, {x:child.x??0, y:child.y??0, w:child.width??0, h:child.height??0});
    // Extract child node positions (relative → absolute)
    for (const gc of (child.children ?? [])) {
      const n = nMap.get(gc.id);
      if (n) { n.x = (child.x??0)+(gc.x??0); n.y = (child.y??0)+(gc.y??0); }
    }
  }

  // Extract edge waypoints (absolute coords)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const re of (result.edges ?? []) as any[]) {
    const eIdx = parseInt(re.id.slice(1));
    const e = edges[eIdx];
    if (!e) continue;
    const pts:{x:number;y:number}[] = [];
    for (const sec of (re.sections ?? [])) {
      pts.push(sec.startPoint);
      for (const bp of (sec.bendPoints ?? [])) pts.push(bp);
      pts.push(sec.endPoint);
    }
    if (pts.length) e.pts = pts;
  }

  // Store namespace bounds for rendering
  (nodes as unknown as {__nsBounds?: Map<string,{x:number;y:number;w:number;h:number}>}).__nsBounds = nsPos;
}

// ── SVG ───────────────────────────────────────────────────────────────────────
function buildSVG(nodes:Node[], edges:Edge[]): string {
  const byFile = new Map<string,Node[]>();
  nodes.forEach(n => {if(!byFile.has(n.fp))byFile.set(n.fp,[]);byFile.get(n.fp)!.push(n);});
  const nMap  = new Map(nodes.map(n => [n.id,n]));
  // Retrieve ns bounds stored during layout
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nsBounds: Map<string,{x:number;y:number;w:number;h:number}> =
    (nodes as any).__nsBounds ?? new Map();

  const totalW = Math.max(...nodes.map(n => n.x+n.w)) + 40;
  const totalH = Math.max(...nodes.map(n => n.y+n.h)) + 40;

  const p:string[] = [];
  p.push(`<svg id="uml-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" style="width:100%;height:100%;display:block">`);
  p.push(`<defs>
    <marker id="a-s" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
      <polygon points="0 0,10 4,0 8" fill="#3b82f6"/>
    </marker>
    <marker id="a-d" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
      <polygon points="0 0,10 4,0 8" fill="#f87171"/>
    </marker>
    <filter id="sh" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="rgba(0,0,0,0.1)"/>
    </filter>
  </defs>`);

  // ── Namespace backgrounds ────────────────────────────────────────────────────
  for (const [fp,fnodes] of byFile) {
    const nsId = `ns_${san(fp)}`;
    const b = nsBounds.get(nsId);
    // Fallback: compute from node positions
    const nx = b?.x ?? (Math.min(...fnodes.map(n=>n.x)) - NS_PAD);
    const ny = b?.y ?? (Math.min(...fnodes.map(n=>n.y)) - NS_HDR - NS_PAD);
    const nw = b?.w ?? (Math.max(...fnodes.map(n=>n.x+n.w)) - nx + NS_PAD);
    const nh = b?.h ?? (Math.max(...fnodes.map(n=>n.y+n.h)) - ny + NS_PAD);
    const name = fp.replace(/\.py$/,"");
    p.push(`
      <rect x="${nx}" y="${ny}" width="${nw}" height="${nh}" rx="10" fill="white" stroke="#1e293b" stroke-width="1.5" filter="url(#sh)"/>
      <clipPath id="nc_${san(fp)}"><rect x="${nx}" y="${ny}" width="${nw}" height="${NS_HDR}" rx="10"/></clipPath>
      <rect x="${nx}" y="${ny}" width="${nw}" height="${NS_HDR}" fill="#1e293b" clip-path="url(#nc_${san(fp)})"/>
      <rect x="${nx}" y="${ny+NS_HDR-6}" width="${nw}" height="6" fill="#1e293b"/>
      <text x="${nx+12}" y="${ny+NS_HDR-9}" font-size="11" font-family="ui-monospace,monospace" font-weight="600" fill="#e2e8f0">📄 ${esc(name)}.py</text>`);
  }

  // Build method-index lookup: fid → {node, rowIndex}
  const midxMap = new Map<string,{n:Node;i:number}>();
  nodes.forEach(n => n.methods.forEach((m,i) => midxMap.set(m.fid,{n,i})));

  // Helper: absolute y-centre of a method row
  const methodY = (n:Node,i:number) => n.y + HDR_H + i*ROW_H + ROW_H/2;

  // ── Edges — anchored to method rows ──────────────────────────────────────────
  for (const e of edges) {
    const solid  = e.style === "solid";
    const stroke = solid ? "#3b82f6" : "#f87171";   // blue for calls, red for removed
    const dash   = solid ? "" : `stroke-dasharray="6,3"`;
    const marker = solid ? "a-s" : "a-d";

    // Resolve method-level anchors
    const callerRef = midxMap.get(e.callerFid);
    const calleeRef = midxMap.get(e.calleeFid);

    let x1:number, y1:number, x2:number, y2:number;
    if (callerRef && calleeRef) {
      // Exit from the right edge of the caller's method row
      x1 = callerRef.n.x + callerRef.n.w;
      y1 = methodY(callerRef.n, callerRef.i);
      // Enter at the left edge of the callee's method row
      x2 = calleeRef.n.x;
      y2 = methodY(calleeRef.n, calleeRef.i);
    } else {
      // Fallback: box midpoints
      const sn=nMap.get(e.src), dn=nMap.get(e.dst); if(!sn||!dn) continue;
      x1=sn.x+sn.w; y1=sn.y+sn.h/2; x2=dn.x; y2=dn.y+dn.h/2;
    }

    // Cubic bezier: horizontal tangents for clean S-curves
    const dx = Math.abs(x2-x1);
    const cx = dx*0.5;
    const path = x2 >= x1
      ? `M${x1},${y1} C${x1+cx},${y1} ${x2-cx},${y2} ${x2},${y2}`
      : `M${x1},${y1} C${x1+40},${y1} ${x1+40},${y1+50} ${(x1+x2)/2},${(y1+y2)/2} S${x2-40},${y2-50} ${x2-40},${y2} ${x2},${y2}`;

    p.push(`<path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.5" opacity="0.85" ${dash} marker-end="url(#${marker})"/>`);
  }

  // ── Class nodes ──────────────────────────────────────────────────────────────
  for (const n of nodes) {
    const {x,y,w,h,change,cn,methods} = n;
    const col   = COLORS[change];
    const title = cn ?? "«standalone»";
    p.push(`<g>`);
    p.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${col.bg}" stroke="${col.border}" stroke-width="1.5"/>`);
    // Header
    p.push(`<clipPath id="hc_${san(n.id)}"><rect x="${x}" y="${y}" width="${w}" height="${HDR_H}" rx="6"/></clipPath>`);
    p.push(`<rect x="${x}" y="${y}" width="${w}" height="${HDR_H}" fill="${col.header}" clip-path="url(#hc_${san(n.id)})"/>`);
    p.push(`<rect x="${x}" y="${y+HDR_H-5}" width="${w}" height="5" fill="${col.header}"/>`);
    p.push(`<text x="${x+w/2}" y="${y+HDR_H-10}" text-anchor="middle" font-size="12" font-weight="bold" font-family="ui-monospace,monospace" fill="white">${esc(title)}</text>`);
    // Separator
    p.push(`<line x1="${x}" y1="${y+HDR_H}" x2="${x+w}" y2="${y+HDR_H}" stroke="${col.border}" stroke-width="1"/>`);
    // Methods
    methods.forEach((m,i) => {
      const ry = y+HDR_H+i*ROW_H;
      const pc = m.prefix==="+"?"#16a34a":m.prefix==="~"?"#d97706":"#dc2626";
      const dec = m.prefix==="−" ? " text-decoration='line-through'" : "";
      p.push(`<rect class="mbg" x="${x+2}" y="${ry+2}" width="${w-4}" height="${ROW_H-2}" rx="3" fill="transparent"/>`);
      p.push(`<text x="${x+H_PAD}" y="${ry+ROW_H-6}" font-size="12" font-family="ui-monospace,monospace"
        class="mrow" data-fid="${esc(m.fid)}" data-fp="${esc(m.fp)}" style="cursor:pointer"${dec}>
        <tspan fill="${pc}" font-weight="bold">${esc(m.prefix)}</tspan>
        <tspan fill="${col.text}"> ${esc(m.name)}()</tspan>
        ${m.hint?`<tspan fill="#94a3b8" font-size="10"> ${esc(m.hint)}</tspan>`:""}
      </text>`);
    });
    p.push(`</g>`);
  }

  p.push(`</svg>`);
  return p.join("\n");
}

// ── Pan / zoom ─────────────────────────────────────────────────────────────────
function initPanZoom(svgEl:SVGSVGElement) {
  const vb=()=>svgEl.viewBox.baseVal;
  const set=(x:number,y:number,w:number,h:number)=>svgEl.setAttribute("viewBox",`${x} ${y} ${w} ${h}`);
  let drag=false,ox=0,oy=0,pvbx=0,pvby=0;
  svgEl.addEventListener("wheel",e=>{
    e.preventDefault();
    const r=svgEl.getBoundingClientRect();
    const mx=(e.clientX-r.left)/r.width*vb().width+vb().x;
    const my=(e.clientY-r.top)/r.height*vb().height+vb().y;
    const f=e.deltaY<0?1/1.15:1.15;
    set(mx-(mx-vb().x)*f, my-(my-vb().y)*f, vb().width*f, vb().height*f);
  },{passive:false});
  svgEl.addEventListener("mousedown",e=>{drag=true;ox=e.clientX;oy=e.clientY;pvbx=vb().x;pvby=vb().y;svgEl.style.cursor="grabbing";});
  window.addEventListener("mousemove",e=>{if(!drag)return;const r=svgEl.getBoundingClientRect();set(pvbx-(e.clientX-ox)*vb().width/r.width,pvby-(e.clientY-oy)*vb().height/r.height,vb().width,vb().height);});
  window.addEventListener("mouseup",()=>{drag=false;svgEl.style.cursor="default";});
}

// ── Main render ────────────────────────────────────────────────────────────────
async function render(data:DiffData) {
  emptyEl.style.display="none";
  rootEl.innerHTML="";
  const total=data.summary.added_functions+data.summary.modified_functions+data.summary.removed_functions;
  if (!total) { rootEl.innerHTML=`<p class="empty">No structural changes.</p>`; return; }

  const badges:string[]=[];
  if (data.summary.added_functions)    badges.push(`<span class="badge add">+${data.summary.added_functions} added</span>`);
  if (data.summary.modified_functions) badges.push(`<span class="badge mod">~${data.summary.modified_functions} modified</span>`);
  if (data.summary.removed_functions)  badges.push(`<span class="badge rem">−${data.summary.removed_functions} removed</span>`);
  badges.push(`<span class="muted">${data.summary.modules_touched.length} modules</span>`);
  badges.push(`<span class="muted ref">${esc(data.base_ref)} → ${esc(data.head_ref)}</span>`);

  rootEl.innerHTML=`
    <div class="summary">${badges.join("")}</div>
    <div class="zoom-controls">
      <button id="z-in">+</button><button id="z-fit">⊡</button><button id="z-out">−</button>
    </div>
    <div id="dg" style="flex:1;position:relative;overflow:hidden"></div>`;

  const {nodes,edges} = buildGraph(data);
  await layoutELK(nodes,edges);

  const wrap = document.getElementById("dg")!;
  wrap.innerHTML = buildSVG(nodes,edges);
  const svgEl = wrap.querySelector<SVGSVGElement>("#uml-svg")!;
  initPanZoom(svgEl);

  // Zoom buttons
  const vb=()=>svgEl.viewBox.baseVal;
  const set=(x:number,y:number,w:number,h:number)=>svgEl.setAttribute("viewBox",`${x} ${y} ${w} ${h}`);
  document.getElementById("z-in")!.addEventListener("click",()=>{const c=vb();set(c.x+c.width*.115,c.y+c.height*.115,c.width/1.3,c.height/1.3);});
  document.getElementById("z-out")!.addEventListener("click",()=>{const c=vb();set(c.x-c.width*.115,c.y-c.height*.115,c.width*1.3,c.height*1.3);});
  document.getElementById("z-fit")!.addEventListener("click",()=>{
    const orig=svgEl.getAttribute("viewBox")?.split(" ").map(Number)??[0,0,800,600];
    set(orig[0],orig[1],orig[2],orig[3]);
  });

  // Per-method click + hover
  svgEl.querySelectorAll<SVGTextElement>(".mrow").forEach(el=>{
    const bg=el.previousElementSibling as SVGRectElement|null;
    el.addEventListener("mouseenter",()=>bg?.setAttribute("fill","rgba(0,0,0,0.07)"));
    el.addEventListener("mouseleave",()=>bg?.setAttribute("fill","transparent"));
    el.addEventListener("click",e=>{e.stopPropagation();vscode.postMessage({type:"navigate",functionId:el.dataset.fid,filePath:el.dataset.fp});});
  });
}
