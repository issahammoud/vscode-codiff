import { renderMermaidSVG, THEMES } from "beautiful-mermaid";

declare const acquireVsCodeApi: () => {
  postMessage: (msg: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

const vscode = acquireVsCodeApi();

// ── DOM refs ───────────────────────────────────────────────────────────────────
const loadingEl = document.getElementById("loading")!;
const emptyEl   = document.getElementById("empty")!;
const summaryEl = document.getElementById("summary")!;
const diagramEl = document.getElementById("diagram")!;

// ── Theme selection ────────────────────────────────────────────────────────────
function getTheme() {
  const body = document.body;
  if (body.classList.contains("vscode-high-contrast-light")) {
    return THEMES["github-light"];
  }
  if (body.classList.contains("vscode-light")) {
    return THEMES["github-light"];
  }
  if (body.classList.contains("vscode-high-contrast")) {
    return THEMES["github-dark"];
  }
  return THEMES["github-dark"]; // default: dark
}

// ── Message handler ────────────────────────────────────────────────────────────
window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as { type: string; data?: CodiffResult; loading?: boolean };

  if (msg.type === "loading") {
    loadingEl.style.display = msg.loading ? "block" : "none";
    if (msg.loading) { emptyEl.style.display = "none"; }
    return;
  }

  if (msg.type === "update" && msg.data) {
    render(msg.data);
  }
});

// ── Types ──────────────────────────────────────────────────────────────────────
interface CodiffResult {
  schema_version: string;
  base_ref:        string;
  head_ref:        string;
  summary: {
    added_functions:    number;
    removed_functions:  number;
    modified_functions: number;
    modules_touched:    string[];
  };
  added:    FunctionInfo[];
  modified: ModifiedInfo[];
  removed:  RemovedInfo[];
}

interface FunctionInfo {
  function_id:       string;
  file_path:         string;
  class_name:        string | null;
  is_entry_point:    boolean;
  new_callers:       string[];
  existing_callers:  string[];
  new_calls:         string[];
  existing_calls:    string[];
}

interface ModifiedInfo {
  function_id:          string;
  file_path:            string;
  class_name:           string | null;
  signature_changed:    boolean;
  calls_added_new:      string[];
  calls_added_existing: string[];
  calls_removed:        string[];
  callers:              string[];
}

interface RemovedInfo {
  function_id:   string;
  file_path:     string;
  class_name:    string | null;
  was_called_by: string[];
}

// ── Renderer ───────────────────────────────────────────────────────────────────
function render(data: CodiffResult) {
  loadingEl.style.display = "none";
  emptyEl.style.display   = "none";
  renderSummary(data);
  renderDiagram(data);
}

function renderSummary(data: CodiffResult) {
  const { added_functions, modified_functions, removed_functions, modules_touched } = data.summary;
  const parts: string[] = [];
  if (added_functions)    parts.push(`<span class="badge badge-added">+${added_functions} added</span>`);
  if (modified_functions) parts.push(`<span class="badge badge-modified">~${modified_functions} modified</span>`);
  if (removed_functions)  parts.push(`<span class="badge badge-removed">−${removed_functions} removed</span>`);
  parts.push(`<span class="dim">${modules_touched.length} module${modules_touched.length !== 1 ? "s" : ""} · ${data.base_ref} → ${data.head_ref}</span>`);
  summaryEl.innerHTML = parts.join("");
  summaryEl.style.display = "flex";
}

function renderDiagram(data: CodiffResult) {
  if (!data.added.length && !data.modified.length && !data.removed.length) {
    diagramEl.innerHTML = `<p class="dim" style="text-align:center;padding:40px 0">No structural changes detected.</p>`;
    return;
  }

  const mermaid = buildMermaid(data);

  try {
    const theme = getTheme();
    const svg   = renderMermaidSVG(mermaid, theme);
    diagramEl.innerHTML = `<div class="svg-wrap">${svg}</div>`;
  } catch (e) {
    // Fall back to syntax-highlighted source so the user can copy it
    diagramEl.innerHTML = `
      <p class="dim" style="margin-bottom:8px">Rendering failed — raw Mermaid:</p>
      <pre class="mermaid-src">${escapeHtml(mermaid)}</pre>`;
  }
}

// ── Mermaid builder ────────────────────────────────────────────────────────────
function buildMermaid(data: CodiffResult): string {
  const lines: string[] = ["classDiagram", "    direction LR"];

  type Members = { added: FunctionInfo[]; modified: ModifiedInfo[]; removed: RemovedInfo[] };
  const byFile = new Map<string, Map<string | null, Members>>();

  const ensureClass = (fp: string, cn: string | null) => {
    if (!byFile.has(fp)) byFile.set(fp, new Map());
    const m = byFile.get(fp)!;
    if (!m.has(cn)) m.set(cn, { added: [], modified: [], removed: [] });
    return m.get(cn)!;
  };

  for (const fn of data.added)    ensureClass(fn.file_path, fn.class_name).added.push(fn);
  for (const fn of data.modified) ensureClass(fn.file_path, fn.class_name).modified.push(fn);
  for (const fn of data.removed)  ensureClass(fn.file_path, fn.class_name).removed.push(fn);

  const san = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");
  const last = (id: string) => id.split(".").at(-1) ?? id;

  for (const [filePath, classes] of [...byFile.entries()].sort()) {
    const ns = "`" + filePath.replace(/\.py$/, "") + "`";
    lines.push("", `    namespace ${ns} {`);

    const sa = classes.get(null);
    if (sa && (sa.added.length || sa.modified.length || sa.removed.length)) {
      const mid = san(`mod__${filePath}`);
      lines.push(`        class ${mid}["«standalone»"] {`, "            <<standalone>>");
      for (const fn of sa.added)    lines.push(`            + ${last(fn.function_id)}()`);
      for (const fn of sa.modified) lines.push(`            ~ ${last(fn.function_id)}()`);
      for (const fn of sa.removed)  lines.push(`            - ${last(fn.function_id)}()`);
      lines.push("        }");
    }

    for (const [cn, members] of [...classes.entries()].sort()) {
      if (cn === null) continue;
      const cid = san(`cls__${filePath}__${cn}`);
      lines.push(`        class ${cid}["${cn}"] {`);
      for (const fn of members.added)    lines.push(`            + ${last(fn.function_id)}()`);
      for (const fn of members.modified) lines.push(`            ~ ${last(fn.function_id)}()`);
      for (const fn of members.removed)  lines.push(`            - ${last(fn.function_id)}()`);
      lines.push("        }");
    }

    lines.push("    }");
  }

  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
