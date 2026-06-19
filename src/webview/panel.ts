// @ts-ignore
import dagre from "@dagrejs/dagre";

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
    render(msg.data);
  }
});

// ── Types ──────────────────────────────────────────────────────────────────────
interface AddedFn   { function_id:string; file_path:string; class_name:string|null; is_entry_point:boolean; new_callers:string[]; existing_callers:string[]; new_calls:string[]; existing_calls:string[]; }
interface ModifiedFn{ function_id:string; file_path:string; class_name:string|null; signature_changed:boolean; calls_added_new:string[]; calls_added_existing:string[]; calls_removed:string[]; callers:string[]; }
interface RemovedFn { function_id:string; file_path:string; class_name:string|null; was_called_by:string[]; }
interface DiffData  { base_ref:string; head_ref:string; summary:{added_functions:number;modified_functions:number;removed_functions:number;modules_touched:string[];}; added:AddedFn[]; modified:ModifiedFn[]; removed:RemovedFn[]; }

type Change = "added"|"modified"|"removed";
const C: Record<Change,{header:string;border:string;bg:string;text:string}> = {
  added:    {header:"#16a34a", border:"#4ade80", bg:"#f0fdf4", text:"#14532d"},
  modified: {header:"#d97706", border:"#fbbf24", bg:"#fefce8", text:"#78350f"},
  removed:  {header:"#dc2626", border:"#f87171", bg:"#fff1f2", text:"#7f1d1d"},
};

// ── Layout constants ───────────────────────────────────────────────────────────
const CHAR_W   = 7;    // monospace px per char @12px
const HDR_H    = 34;   // class header (name only)
const ROW_H    = 22;   // per method
const PAD_B    = 10;   // bottom padding inside node
const MIN_W    = 160;
const H_PAD    = 20;   // left text margin
const NS_HDR   = 30;   // namespace dark header
const NS_PAD   = 14;   // namespace inner padding
const COL_GAP  = 90;   // gap between file columns
const NODE_GAP = 16;   // gap between nodes in same column
const FILE_GAP = 36;   // gap between files in same column
const MARGIN   = 30;

interface Method { fid:string; fp:string; prefix:string; name:string; hint:string; }
interface Node   { id:string; fp:string; cn:string|null; change:Change; methods:Method[]; w:number; h:number; x:number; y:number; fid:string; }
interface Edge   { src:string; dst:string; style:"solid"|"dashed"; }

const san  = (s:string) => s.replace(/[^a-zA-Z0-9]/g,"_");
const last = (id:string) => id.split(".").at(-1) ?? id;
const esc  = (s:string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const fileName = (fp:string) => fp.replace(/\.py$/,"");

function nodeWidth(methods:Method[], cn:string|null): number {
  const title  = cn ?? "«standalone»";
  const lines  = [title, ...methods.map(m => `${m.prefix} ${m.name}()  ${m.hint}`)];
  return Math.max(MIN_W, Math.max(...lines.map(l=>l.length)) * CHAR_W + H_PAD * 2);
}

// ── Build nodes & edges ────────────────────────────────────────────────────────
function buildGraph(data:DiffData): {nodes:Node[]; edges:Edge[]} {
  type Mbrs = {added:AddedFn[];modified:ModifiedFn[];removed:RemovedFn[]};
  const byFile = new Map<string,Map<string|null,Mbrs>>();
  const ensure = (fp:string,cn:string|null) => {
    if (!byFile.has(fp)) byFile.set(fp,new Map());
    const m=byFile.get(fp)!;
    if (!m.has(cn)) m.set(cn,{added:[],modified:[],removed:[]});
    return m.get(cn)!;
  };
  data.added.forEach(fn    => ensure(fn.file_path,fn.class_name).added.push(fn));
  data.modified.forEach(fn => ensure(fn.file_path,fn.class_name).modified.push(fn));
  data.removed.forEach(fn  => ensure(fn.file_path,fn.class_name).removed.push(fn));

  const nodes:Node[] = [];
  const fidMap = new Map<string,string>(); // fn_id → node_id

  for (const [fp,classes] of byFile) {
    for (const [cn,mbrs] of classes) {
      const nid = cn ? `c_${san(fp)}_${san(cn)}` : `m_${san(fp)}`;
      const change:Change = !mbrs.added.length&&!mbrs.modified.length?"removed":
                            !mbrs.modified.length&&!mbrs.removed.length?"added":"modified";
      const methods:Method[] = [
        ...mbrs.added.map(fn=>({fid:fn.function_id,fp:fn.file_path,prefix:"+",name:last(fn.function_id),
          hint:fn.is_entry_point?"entry":(fn.new_callers.length+fn.existing_callers.length)>0?`←${fn.new_callers.length+fn.existing_callers.length}`:""})),
        ...mbrs.modified.map(fn=>({fid:fn.function_id,fp:fn.file_path,prefix:"~",name:last(fn.function_id),
          hint:fn.signature_changed?"sig":(fn.calls_added_new.length||fn.calls_removed.length)?"calls":"body"})),
        ...mbrs.removed.map(fn=>({fid:fn.function_id,fp:fn.file_path,prefix:"−",name:last(fn.function_id),
          hint:fn.was_called_by.length?`←${fn.was_called_by.length}`:""})),
      ];
      const w = nodeWidth(methods,cn);
      const h = HDR_H + methods.length*ROW_H + PAD_B;
      nodes.push({id:nid,fp,cn,change,methods,w,h,x:0,y:0,fid:[...mbrs.added,...mbrs.modified,...mbrs.removed][0]?.function_id??""});
      [...mbrs.added,...mbrs.modified,...mbrs.removed].forEach(fn=>fidMap.set(fn.function_id,nid));
    }
  }

  const seen=new Set<string>();
  const edges:Edge[]=[];
  const addE=(s:string,d:string,style:"solid"|"dashed")=>{
    if (s===d) return;
    const k=`${s}→${d}`; if (seen.has(k)) return; seen.add(k);
    edges.push({src:s,dst:d,style});
  };
  data.added.forEach(fn=>{
    const src=fidMap.get(fn.function_id); if (!src) return;
    [...fn.new_calls,...fn.new_callers].forEach(fid=>{const d=fidMap.get(fid);if(d)addE(src,d,"solid");});
  });
  data.modified.forEach(fn=>{
    const src=fidMap.get(fn.function_id); if (!src) return;
    fn.calls_added_new.forEach(fid=>{const d=fidMap.get(fid);if(d)addE(src,d,"solid");});
    fn.calls_removed.forEach(fid=>{const d=fidMap.get(fid);if(d)addE(src,d,"dashed");});
  });
  return {nodes,edges};
}

// ── Column layout: topo-rank files, stack nodes vertically ────────────────────
function layout(nodes:Node[], edges:Edge[]) {
  // Group nodes by file
  const byFile=new Map<string,Node[]>();
  nodes.forEach(n=>{if(!byFile.has(n.fp))byFile.set(n.fp,[]);byFile.get(n.fp)!.push(n);});

  // File-level directed edges
  const nToF=new Map(nodes.map(n=>[n.id,n.fp]));
  const fEdges=new Set<string>();
  edges.forEach(e=>{
    const sf=nToF.get(e.src),df=nToF.get(e.dst);
    if(sf&&df&&sf!==df) fEdges.add(`${sf}|${df}`);
  });

  // Topo rank files (longest path = column index)
  const files=[...byFile.keys()];
  const rank=new Map(files.map(f=>[f,0]));
  const inDeg=new Map(files.map(f=>[f,0]));
  const adj=new Map(files.map(f=>[f,[] as string[]]));
  for(const e of fEdges){const[s,d]=e.split("|");adj.get(s)?.push(d);inDeg.set(d,(inDeg.get(d)??0)+1);}
  const q=files.filter(f=>!inDeg.get(f));
  while(q.length){
    const f=q.shift()!; const r=rank.get(f)??0;
    for(const nb of (adj.get(f)??[])){
      if((r+1)>(rank.get(nb)??0)) rank.set(nb,r+1);
      inDeg.set(nb,(inDeg.get(nb)??0)-1);
      if((inDeg.get(nb)??0)<=0) q.push(nb);
    }
  }

  // Build rank→files map (sorted for determinism)
  const rankMap=new Map<number,string[]>();
  for(const[f,r] of rank){if(!rankMap.has(r))rankMap.set(r,[]);rankMap.get(r)!.push(f);}

  // Place nodes column by column
  let colX=MARGIN;
  const maxRank=Math.max(...rank.values(),0);
  for(let r=0;r<=maxRank;r++){
    const filesInCol=(rankMap.get(r)??[]).sort();
    if(!filesInCol.length) continue;
    // Column width = widest node across all files in this column + namespace padding
    const colW=Math.max(...filesInCol.flatMap(f=>byFile.get(f)!.map(n=>n.w)))+NS_PAD*2;
    let colY=MARGIN;
    for(const fp of filesInCol){
      const fnodes=byFile.get(fp)!;
      let nodeY=colY+NS_HDR+NS_PAD;
      for(const n of fnodes){n.x=colX+NS_PAD;n.y=nodeY;nodeY+=n.h+NODE_GAP;}
      colY=nodeY+NS_PAD+FILE_GAP;
    }
    colX+=colW+COL_GAP;
  }
}

// ── SVG ───────────────────────────────────────────────────────────────────────
function svg(nodes:Node[], edges:Edge[]): string {
  const byFile=new Map<string,Node[]>();
  nodes.forEach(n=>{if(!byFile.has(n.fp))byFile.set(n.fp,[]);byFile.get(n.fp)!.push(n);});
  const nMap=new Map(nodes.map(n=>[n.id,n]));
  const totalW=Math.max(...nodes.map(n=>n.x+n.w))+MARGIN;
  const totalH=Math.max(...nodes.map(n=>n.y+n.h))+MARGIN;

  const p:string[]=[];
  p.push(`<svg id="uml-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" style="width:100%;height:100%;display:block">`);

  // Defs: arrowheads + drop shadow
  p.push(`<defs>
    <marker id="a-solid" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0,10 3.5,0 7" fill="#475569"/></marker>
    <marker id="a-dash"  markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0,10 3.5,0 7" fill="#f87171"/></marker>
    <filter id="sh"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="rgba(0,0,0,0.12)"/></filter>
  </defs>`);

  // ── Namespace rectangles ──────────────────────────────────────────────────
  for(const[fp,fnodes] of byFile){
    const nx=Math.min(...fnodes.map(n=>n.x))-NS_PAD;
    const ny=Math.min(...fnodes.map(n=>n.y))-NS_HDR-NS_PAD;
    const nw=Math.max(...fnodes.map(n=>n.x+n.w))-nx+NS_PAD;
    const nh=Math.max(...fnodes.map(n=>n.y+n.h))-ny+NS_PAD;
    const name=fileName(fp);
    p.push(`
      <rect x="${nx}" y="${ny}" width="${nw}" height="${nh}" rx="10" fill="white" stroke="#1e293b" stroke-width="1.5" filter="url(#sh)"/>
      <clipPath id="nsclip_${san(fp)}"><rect x="${nx}" y="${ny}" width="${nw}" height="${NS_HDR}" rx="10"/></clipPath>
      <rect x="${nx}" y="${ny}" width="${nw}" height="${NS_HDR}" fill="#1e293b" clip-path="url(#nsclip_${san(fp)})"/>
      <rect x="${nx}" y="${ny+NS_HDR-8}" width="${nw}" height="8" fill="#1e293b"/>
      <text x="${nx+12}" y="${ny+NS_HDR-9}" font-size="11" font-family="ui-monospace,monospace" font-weight="600" fill="#f1f5f9">📄 ${esc(name)}.py</text>
    `);
  }

  // ── Edges ─────────────────────────────────────────────────────────────────
  for(const e of edges){
    const s=nMap.get(e.src),d=nMap.get(e.dst); if(!s||!d) continue;
    const x1=s.x+s.w, y1=s.y+s.h/2;
    const x2=d.x,     y2=d.y+d.h/2;
    const cx=(x1+x2)/2;
    const solid=e.style==="solid";
    p.push(`<path d="M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}"
      fill="none" stroke="${solid?"#475569":"#f87171"}" stroke-width="1.5"
      ${solid?"":`stroke-dasharray="6,3"`} marker-end="url(#${solid?"a-solid":"a-dash"})"/>`);
  }

  // ── Class nodes ────────────────────────────────────────────────────────────
  for(const n of nodes){
    const {x,y,w,h,change,cn,methods}=n;
    const col=C[change];
    const title=cn??"«standalone»";

    p.push(`<g>`);
    // Box
    p.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${col.bg}" stroke="${col.border}" stroke-width="1.5"/>`);
    // Coloured header
    p.push(`<clipPath id="hclip_${san(n.id)}"><rect x="${x}" y="${y}" width="${w}" height="${HDR_H}" rx="6"/></clipPath>`);
    p.push(`<rect x="${x}" y="${y}" width="${w}" height="${HDR_H}" fill="${col.header}" clip-path="url(#hclip_${san(n.id)})"/>`);
    p.push(`<rect x="${x}" y="${y+HDR_H-6}" width="${w}" height="6" fill="${col.header}"/>`);
    // Class name
    p.push(`<text x="${x+w/2}" y="${y+HDR_H-10}" text-anchor="middle" font-size="12" font-weight="bold" font-family="ui-monospace,monospace" fill="white">${esc(title)}</text>`);
    // Separator
    p.push(`<line x1="${x}" y1="${y+HDR_H}" x2="${x+w}" y2="${y+HDR_H}" stroke="${col.border}" stroke-width="1"/>`);
    // Methods
    methods.forEach((m,i)=>{
      const ry=y+HDR_H+i*ROW_H;
      const pc=m.prefix==="+"?"#16a34a":m.prefix==="~"?"#d97706":"#dc2626";
      const strike=m.prefix==="−"?" text-decoration='line-through'":"";
      // hover bg rect
      p.push(`<rect class="mbg" x="${x+1}" y="${ry+2}" width="${w-2}" height="${ROW_H-2}" rx="3" fill="transparent"/>`);
      p.push(`<text x="${x+H_PAD}" y="${ry+ROW_H-6}" font-size="12" font-family="ui-monospace,monospace"
        class="mrow" data-fid="${esc(m.fid)}" data-fp="${esc(m.fp)}" style="cursor:pointer"${strike}>
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
  const setVB=(x:number,y:number,w:number,h:number)=>svgEl.setAttribute("viewBox",`${x} ${y} ${w} ${h}`);
  let drag=false,ox=0,oy=0,pvbx=0,pvby=0;

  svgEl.addEventListener("wheel",e=>{
    e.preventDefault();
    const r=svgEl.getBoundingClientRect();
    const mx=(e.clientX-r.left)/r.width*vb().width+vb().x;
    const my=(e.clientY-r.top)/r.height*vb().height+vb().y;
    const f=e.deltaY<0?1/1.15:1.15;
    setVB(mx-(mx-vb().x)*f, my-(my-vb().y)*f, vb().width*f, vb().height*f);
  },{passive:false});

  svgEl.addEventListener("mousedown",e=>{
    drag=true; ox=e.clientX; oy=e.clientY; pvbx=vb().x; pvby=vb().y;
    svgEl.style.cursor="grabbing";
  });
  window.addEventListener("mousemove",e=>{
    if(!drag)return;
    const r=svgEl.getBoundingClientRect();
    const sx=vb().width/r.width, sy=vb().height/r.height;
    setVB(pvbx-(e.clientX-ox)*sx, pvby-(e.clientY-oy)*sy, vb().width, vb().height);
  });
  window.addEventListener("mouseup",()=>{drag=false;svgEl.style.cursor="default";});
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(data:DiffData) {
  emptyEl.style.display="none";
  rootEl.innerHTML="";

  const total=data.summary.added_functions+data.summary.modified_functions+data.summary.removed_functions;
  if(!total){rootEl.innerHTML=`<p class="empty">No structural changes.</p>`;return;}

  const badges:string[]=[];
  if(data.summary.added_functions)    badges.push(`<span class="badge add">+${data.summary.added_functions} added</span>`);
  if(data.summary.modified_functions) badges.push(`<span class="badge mod">~${data.summary.modified_functions} modified</span>`);
  if(data.summary.removed_functions)  badges.push(`<span class="badge rem">−${data.summary.removed_functions} removed</span>`);
  badges.push(`<span class="muted">${data.summary.modules_touched.length} modules</span>`);
  badges.push(`<span class="muted ref">${esc(data.base_ref)} → ${esc(data.head_ref)}</span>`);

  rootEl.innerHTML=`
    <div class="summary">${badges.join("")}</div>
    <div class="zoom-controls">
      <button id="z-in">+</button><button id="z-fit">⊡</button><button id="z-out">−</button>
    </div>
    <div id="dg" style="flex:1;position:relative;overflow:hidden"></div>`;

  const {nodes,edges}=buildGraph(data);
  layout(nodes,edges);

  const wrap=document.getElementById("dg")!;
  wrap.innerHTML=svg(nodes,edges);
  const svgEl=wrap.querySelector<SVGSVGElement>("#uml-svg")!;
  initPanZoom(svgEl);

  // Zoom buttons
  const vb=()=>svgEl.viewBox.baseVal;
  const set=(x:number,y:number,w:number,h:number)=>svgEl.setAttribute("viewBox",`${x} ${y} ${w} ${h}`);
  document.getElementById("z-in")! .addEventListener("click",()=>{const c=vb();set(c.x+c.width*0.115,c.y+c.height*0.115,c.width/1.3,c.height/1.3);});
  document.getElementById("z-out")!.addEventListener("click",()=>{const c=vb();set(c.x-c.width*0.115,c.y-c.height*0.115,c.width*1.3,c.height*1.3);});
  document.getElementById("z-fit")!.addEventListener("click",()=>{
    const orig=svgEl.getAttribute("viewBox")?.split(" ").map(Number)??[0,0,800,600];
    set(orig[0],orig[1],orig[2],orig[3]);
  });

  // Per-method click + hover
  svgEl.querySelectorAll<SVGTextElement>(".mrow").forEach(el=>{
    const bg=el.previousElementSibling as SVGRectElement|null;
    el.addEventListener("mouseenter",()=>bg?.setAttribute("fill","rgba(0,0,0,0.07)"));
    el.addEventListener("mouseleave",()=>bg?.setAttribute("fill","transparent"));
    el.addEventListener("click",e=>{
      e.stopPropagation();
      vscode.postMessage({type:"navigate",functionId:el.dataset.fid,filePath:el.dataset.fp});
    });
  });
}
