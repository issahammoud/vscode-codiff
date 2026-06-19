declare const acquireVsCodeApi: () => {
  postMessage: (msg: unknown) => void;
};
const vscode = acquireVsCodeApi();

// ── DOM ────────────────────────────────────────────────────────────────────────
const loadingEl = document.getElementById("loading")!;
const emptyEl   = document.getElementById("empty")!;
const rootEl    = document.getElementById("root")!;

// ── Types ──────────────────────────────────────────────────────────────────────
interface Summary {
  added_functions: number; modified_functions: number;
  removed_functions: number; modules_touched: string[];
}
interface AddedFn {
  function_id: string; file_path: string; class_name: string | null;
  is_entry_point: boolean; new_callers: string[]; existing_callers: string[];
  new_calls: string[]; existing_calls: string[];
}
interface ModifiedFn {
  function_id: string; file_path: string; class_name: string | null;
  signature_changed: boolean; calls_added_new: string[];
  calls_added_existing: string[]; calls_removed: string[]; callers: string[];
}
interface RemovedFn {
  function_id: string; file_path: string; class_name: string | null;
  was_called_by: string[];
}
interface DiffData {
  schema_version: string; base_ref: string; head_ref: string;
  summary: Summary; added: AddedFn[]; modified: ModifiedFn[]; removed: RemovedFn[];
}

// ── Messages ───────────────────────────────────────────────────────────────────
window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as { type: string; data?: DiffData; loading?: boolean };
  if (msg.type === "loading") {
    loadingEl.style.display = msg.loading ? "block" : "none";
    if (msg.loading) emptyEl.style.display = "none";
  } else if (msg.type === "update" && msg.data) {
    render(msg.data);
  }
});

// ── Main renderer ──────────────────────────────────────────────────────────────
function render(data: DiffData) {
  loadingEl.style.display = "none";
  emptyEl.style.display   = "none";
  rootEl.innerHTML = buildHtml(data);

  // click → navigate
  rootEl.querySelectorAll<HTMLElement>("[data-fid]").forEach(el => {
    el.addEventListener("click", () =>
      vscode.postMessage({ type: "navigate", functionId: el.dataset.fid })
    );
  });
}

// ── HTML builder ───────────────────────────────────────────────────────────────
function buildHtml(data: DiffData): string {
  const { summary, added, modified, removed, base_ref, head_ref } = data;
  const total = summary.added_functions + summary.modified_functions + summary.removed_functions;

  if (total === 0) {
    return `<div class="empty">No structural changes detected between <code>${esc(base_ref)}</code> and <code>${esc(head_ref)}</code>.</div>`;
  }

  // Group by file → class
  type Members = { added: AddedFn[]; modified: ModifiedFn[]; removed: RemovedFn[] };
  const byFile = new Map<string, Map<string | null, Members>>();

  const ensure = (fp: string, cn: string | null) => {
    if (!byFile.has(fp)) byFile.set(fp, new Map());
    const m = byFile.get(fp)!;
    if (!m.has(cn)) m.set(cn, { added: [], modified: [], removed: [] });
    return m.get(cn)!;
  };
  added.forEach(fn    => ensure(fn.file_path, fn.class_name).added.push(fn));
  modified.forEach(fn => ensure(fn.file_path, fn.class_name).modified.push(fn));
  removed.forEach(fn  => ensure(fn.file_path, fn.class_name).removed.push(fn));

  // Build relationship index: fid → cid (class card id)
  const san = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "_");
  const fidToCid = new Map<string, string>();
  byFile.forEach((classes, fp) => {
    classes.forEach((_, cn) => {
      const cid = cn ? san(`${fp}__${cn}`) : san(`${fp}__standalone`);
      classes.get(cn)!.added.forEach(fn    => fidToCid.set(fn.function_id, cid));
      classes.get(cn)!.modified.forEach(fn => fidToCid.set(fn.function_id, cid));
      classes.get(cn)!.removed.forEach(fn  => fidToCid.set(fn.function_id, cid));
    });
  });

  // Collect edges between class cards
  const edges = new Set<string>();
  added.forEach(fn => {
    const src = fidToCid.get(fn.function_id);
    [...fn.new_calls, ...fn.new_callers].forEach(fid => {
      const dst = fidToCid.get(fid);
      if (src && dst && src !== dst) edges.add(`${src}→${dst}`);
    });
  });
  modified.forEach(fn => {
    const src = fidToCid.get(fn.function_id);
    [...fn.calls_added_new].forEach(fid => {
      const dst = fidToCid.get(fid);
      if (src && dst && src !== dst) edges.add(`${src}→${dst}`);
    });
  });

  const parts: string[] = [];

  // ── Summary bar ──────────────────────────────────────────────────────────────
  parts.push(`<div class="summary">`);
  if (summary.added_functions)    parts.push(`<span class="badge add">+${summary.added_functions} added</span>`);
  if (summary.modified_functions) parts.push(`<span class="badge mod">~${summary.modified_functions} modified</span>`);
  if (summary.removed_functions)  parts.push(`<span class="badge rem">−${summary.removed_functions} removed</span>`);
  parts.push(`<span class="muted">${summary.modules_touched.length} module${summary.modules_touched.length !== 1 ? "s" : ""}</span>`);
  parts.push(`<span class="muted ref">${esc(base_ref)} → ${esc(head_ref)}</span>`);
  parts.push(`</div>`);

  // ── Module cards ──────────────────────────────────────────────────────────────
  parts.push(`<div class="modules">`);

  for (const [filePath, classes] of [...byFile.entries()].sort()) {
    // Dominant change type for module border accent
    const allAdded    = [...classes.values()].flatMap(m => m.added).length;
    const allModified = [...classes.values()].flatMap(m => m.modified).length;
    const allRemoved  = [...classes.values()].flatMap(m => m.removed).length;
    const accent = allRemoved && !allAdded && !allModified ? "rem" : allAdded && !allModified && !allRemoved ? "add" : "mod";

    parts.push(`<div class="module-card ${accent}">`);
    parts.push(`  <div class="module-header">`);
    parts.push(`    <span class="module-icon">📄</span>`);
    parts.push(`    <span class="module-path">${esc(filePath)}</span>`);
    parts.push(`  </div>`);
    parts.push(`  <div class="module-body">`);

    // Sort: standalone first, then classes alphabetically
    const sortedClasses: Array<[string | null, Members]> = [
      ...(classes.has(null) ? [[null, classes.get(null)!]] as [null, Members][] : []),
      ...[...classes.entries()].filter(([cn]) => cn !== null).sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")),
    ];

    for (const [className, members] of sortedClasses) {
      const cid = className ? san(`${filePath}__${className}`) : san(`${filePath}__standalone`);
      const allFids = [...members.added, ...members.modified, ...members.removed].map(f => f.function_id);
      const classAccent = members.removed.length && !members.added.length && !members.modified.length ? "rem"
                        : members.added.length && !members.modified.length && !members.removed.length ? "add"
                        : "mod";

      parts.push(`  <div class="class-card ${classAccent}" id="${cid}">`);
      if (className) {
        parts.push(`    <div class="class-header">`);
        parts.push(`      <span class="class-icon">C</span>`);
        parts.push(`      <span class="class-name">${esc(className)}</span>`);
        parts.push(`    </div>`);
      } else {
        parts.push(`    <div class="class-header standalone-header">`);
        parts.push(`      <span class="class-icon">ƒ</span>`);
        parts.push(`      <span class="class-name muted-name">standalone</span>`);
        parts.push(`    </div>`);
      }
      parts.push(`    <div class="methods">`);

      for (const fn of members.added) {
        const name = fn.function_id.split(".").at(-1)!;
        const hint = fn.is_entry_point ? "entry point"
                   : (fn.new_callers.length + fn.existing_callers.length) > 0
                     ? `← ${fn.new_callers.length + fn.existing_callers.length} caller${fn.new_callers.length + fn.existing_callers.length !== 1 ? "s" : ""}`
                     : "";
        parts.push(`    <div class="method add" data-fid="${esc(fn.function_id)}">`);
        parts.push(`      <span class="vis">+</span>`);
        parts.push(`      <span class="fn-name">${esc(name)}()</span>`);
        if (hint) parts.push(`      <span class="hint">${esc(hint)}</span>`);
        parts.push(`    </div>`);
      }

      for (const fn of members.modified) {
        const name = fn.function_id.split(".").at(-1)!;
        const hint = fn.signature_changed ? "sig changed"
                   : (fn.calls_added_new.length || fn.calls_removed.length) ? "calls changed"
                   : "body changed";
        parts.push(`    <div class="method mod" data-fid="${esc(fn.function_id)}">`);
        parts.push(`      <span class="vis">~</span>`);
        parts.push(`      <span class="fn-name">${esc(name)}()</span>`);
        parts.push(`      <span class="hint">${esc(hint)}</span>`);
        parts.push(`    </div>`);
      }

      for (const fn of members.removed) {
        const name = fn.function_id.split(".").at(-1)!;
        const hint = fn.was_called_by.length > 0 ? `← ${fn.was_called_by.length} caller${fn.was_called_by.length !== 1 ? "s" : ""} affected` : "";
        parts.push(`    <div class="method rem" data-fid="${esc(fn.function_id)}">`);
        parts.push(`      <span class="vis">−</span>`);
        parts.push(`      <span class="fn-name struck">${esc(name)}()</span>`);
        if (hint) parts.push(`      <span class="hint">${esc(hint)}</span>`);
        parts.push(`    </div>`);
      }

      parts.push(`    </div>`); // .methods
      parts.push(`  </div>`);   // .class-card
    }

    parts.push(`  </div>`); // .module-body
    parts.push(`</div>`);   // .module-card
  }

  parts.push(`</div>`); // .modules

  // ── Relationships ─────────────────────────────────────────────────────────────
  if (edges.size > 0) {
    parts.push(`<div class="relationships">`);
    parts.push(`  <div class="rel-title">Call relationships</div>`);
    parts.push(`  <div class="rel-list">`);
    for (const edge of [...edges].sort()) {
      const [src, dst] = edge.split("→");
      parts.push(`    <div class="rel-row"><span class="rel-src">${esc(src.replace(/_/g, " ").trim())}</span><span class="rel-arrow">→</span><span class="rel-dst">${esc(dst.replace(/_/g, " ").trim())}</span></div>`);
    }
    parts.push(`  </div>`);
    parts.push(`</div>`);
  }

  return parts.join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
