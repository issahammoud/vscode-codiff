import { renderMermaidSVG } from "beautiful-mermaid";

// VS Code webview API
declare const acquireVsCodeApi: () => {
  postMessage: (msg: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

const vscode = acquireVsCodeApi();

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loadingEl = document.getElementById("loading")!;
const emptyEl   = document.getElementById("empty")!;
const summaryEl = document.getElementById("summary")!;
const diagramEl = document.getElementById("diagram")!;

// ── Message handler ────────────────────────────────────────────────────────────
window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as { type: string; data?: CodiffResult; loading?: boolean };

  if (msg.type === "loading") {
    loadingEl.style.display = msg.loading ? "block" : "none";
    if (msg.loading) emptyEl.style.display = "none";
    return;
  }

  if (msg.type === "update" && msg.data) {
    render(msg.data);
  }
});

// ── Types ─────────────────────────────────────────────────────────────────────
interface CodiffResult {
  schema_version: string;
  base_ref: string;
  head_ref: string;
  summary: {
    added_functions: number;
    removed_functions: number;
    modified_functions: number;
    modules_touched: string[];
  };
  added: FunctionInfo[];
  modified: ModifiedInfo[];
  removed: RemovedInfo[];
}

interface FunctionInfo {
  function_id: string;
  file_path: string;
  class_name: string | null;
  is_entry_point: boolean;
  new_callers: string[];
  existing_callers: string[];
  new_calls: string[];
  existing_calls: string[];
}

interface ModifiedInfo {
  function_id: string;
  file_path: string;
  class_name: string | null;
  signature_changed: boolean;
  calls_added_new: string[];
  calls_added_existing: string[];
  calls_removed: string[];
  callers: string[];
}

interface RemovedInfo {
  function_id: string;
  file_path: string;
  class_name: string | null;
  was_called_by: string[];
}

// ── Renderer ──────────────────────────────────────────────────────────────────
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
  if (removed_functions)  parts.push(`<span class="badge badge-removed">-${removed_functions} removed</span>`);
  parts.push(`<span style="color:var(--vscode-descriptionForeground)">${modules_touched.length} module${modules_touched.length !== 1 ? "s" : ""}</span>`);

  summaryEl.innerHTML = parts.join("");
  summaryEl.style.display = "flex";
}

function renderDiagram(data: CodiffResult) {
  const mermaid = buildMermaid(data);

  try {
    // Use VS Code's CSS custom properties for theming
    const isDark = document.body.classList.contains("vscode-dark") ||
                   document.body.classList.contains("vscode-high-contrast");

    const svg = renderMermaidSVG(mermaid, {
      bg: isDark ? "#1e1e1e" : "#ffffff",
      fg: isDark ? "#d4d4d4" : "#1e293b",
      transparent: false,
    });

    diagramEl.innerHTML = svg;

    // Make function nodes clickable
    diagramEl.querySelectorAll("[data-function-id]").forEach((el: Element) => {
      (el as HTMLElement).style.cursor = "pointer";
      el.addEventListener("click", () => {
        vscode.postMessage({
          type: "navigate",
          functionId: el.getAttribute("data-function-id"),
        });
      });
    });
  } catch (e) {
    // Fall back to pre-formatted Mermaid source if rendering fails
    diagramEl.innerHTML = `<pre style="font-size:12px;white-space:pre-wrap;opacity:0.7">${escapeHtml(mermaid)}</pre>`;
  }
}

// ── Mermaid builder (mirrors codiff/diff/mermaid.py logic) ───────────────────
function buildMermaid(data: CodiffResult): string {
  const lines: string[] = [
    "classDiagram",
    "    direction LR",
  ];

  // Group by file → class
  const byFile = new Map<string, Map<string | null, { added: FunctionInfo[]; modified: ModifiedInfo[]; removed: RemovedInfo[] }>>();

  for (const fn of data.added) {
    if (!byFile.has(fn.file_path)) byFile.set(fn.file_path, new Map());
    const classes = byFile.get(fn.file_path)!;
    if (!classes.has(fn.class_name)) classes.set(fn.class_name, { added: [], modified: [], removed: [] });
    classes.get(fn.class_name)!.added.push(fn);
  }
  for (const fn of data.modified) {
    if (!byFile.has(fn.file_path)) byFile.set(fn.file_path, new Map());
    const classes = byFile.get(fn.file_path)!;
    if (!classes.has(fn.class_name)) classes.set(fn.class_name, { added: [], modified: [], removed: [] });
    classes.get(fn.class_name)!.modified.push(fn);
  }
  for (const fn of data.removed) {
    if (!byFile.has(fn.file_path)) byFile.set(fn.file_path, new Map());
    const classes = byFile.get(fn.file_path)!;
    if (!classes.has(fn.class_name)) classes.set(fn.class_name, { added: [], modified: [], removed: [] });
    classes.get(fn.class_name)!.removed.push(fn);
  }

  const san = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");

  for (const [filePath, classes] of [...byFile.entries()].sort()) {
    const nsId = "`" + filePath.replace(/\.py$/, "") + "`";
    lines.push("", `    namespace ${nsId} {`);

    // Standalone functions
    const sa = classes.get(null);
    if (sa && (sa.added.length || sa.modified.length || sa.removed.length)) {
      const mid = san(`mod__${filePath}`);
      lines.push(`        class ${mid}["«standalone»"] {`, "            <<standalone>>");
      for (const fn of sa.added)    lines.push(`            + ${fn.function_id.split(".").at(-1)}()`);
      for (const fn of sa.modified) lines.push(`            ~ ${fn.function_id.split(".").at(-1)}()`);
      for (const fn of sa.removed)  lines.push(`            - ${fn.function_id.split(".").at(-1)}()`);
      lines.push("        }");
    }

    // Named classes
    for (const [className, members] of [...classes.entries()].sort()) {
      if (className === null) continue;
      const cid = san(`cls__${filePath}__${className}`);
      lines.push(`        class ${cid}["${className}"] {`);
      for (const fn of members.added)    lines.push(`            + ${fn.function_id.split(".").at(-1)}()`);
      for (const fn of members.modified) lines.push(`            ~ ${fn.function_id.split(".").at(-1)}()`);
      for (const fn of members.removed)  lines.push(`            - ${fn.function_id.split(".").at(-1)}()`);
      lines.push("        }");
    }

    lines.push("    }");
  }

  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
