import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import { DiffPanel } from "./diffPanel";

// Debounce timer and running process — cancel both on new save
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let runningProc:   ChildProcess | undefined;

const DEBOUNCE_MS = 400;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("codiff.showDiff", () => {
      const root = getWorkspaceRoot();
      if (!root) { vscode.window.showErrorMessage("codiff: no workspace folder open."); return; }
      DiffPanel.createOrShow(context, root);
      scheduleRun(root);
    }),

    vscode.commands.registerCommand("codiff.refreshDiff", () => {
      const root = getWorkspaceRoot();
      if (root) scheduleRun(root);
    }),

    // Auto-refresh: debounced so rapid saves don't pile up
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const config = vscode.workspace.getConfiguration("codiff");
      if (!config.get<boolean>("autoRefresh", true)) return;
      if (!doc.fileName.endsWith(".py")) return;
      if (!DiffPanel.currentPanel) return;
      const root = getWorkspaceRoot();
      if (root) scheduleRun(root);
    })
  );
}

export function deactivate() {
  clearTimeout(debounceTimer);
  runningProc?.kill();
}

// ── Scheduling ────────────────────────────────────────────────────────────────

function scheduleRun(root: string) {
  // Cancel any pending debounce and kill any still-running process
  clearTimeout(debounceTimer);
  runningProc?.kill();
  runningProc = undefined;

  DiffPanel.setStatus("refreshing");

  debounceTimer = setTimeout(() => runCodiff(root), DEBOUNCE_MS);
}

// ── Runner ────────────────────────────────────────────────────────────────────

function runCodiff(root: string) {
  const config       = vscode.workspace.getConfiguration("codiff");
  const baseRef      = config.get<string>("baseRef", "HEAD");
  const includeTests = config.get<boolean>("includeTests", false);
  const codiffPath   = config.get<string>("executablePath", "codiff");

  const args = ["diff", "--json", "--repo", root, "--base", baseRef];
  if (includeTests) args.push("--include-tests");

  let stdout = "";
  let stderr = "";

  const proc = spawn(codiffPath, args, { cwd: root });
  runningProc = proc;

  proc.stdout.on("data", (c: { toString(): string }) => { stdout += c.toString(); });
  proc.stderr.on("data", (c: { toString(): string }) => { stderr += c.toString(); });

  proc.on("close", (code: number | null) => {
    if (proc !== runningProc) return; // superseded
    runningProc = undefined;
    DiffPanel.setStatus("idle");

    if (code !== 0 || !stdout.trim()) {
      const msg = stderr.trim() || `codiff exited with code ${code}`;
      vscode.window.showErrorMessage(`codiff: ${msg}`);
      return;
    }
    try {
      DiffPanel.update(JSON.parse(stdout));
    } catch {
      vscode.window.showErrorMessage("codiff: failed to parse JSON output.");
    }
  });

  proc.on("error", (err: Error & { code?: string }) => {
    runningProc = undefined;
    DiffPanel.setStatus("idle");
    if (err.code === "ENOENT") {
      vscode.window.showErrorMessage(
        `codiff: '${codiffPath}' not found. Install with: pip install codiff`
      );
    } else {
      vscode.window.showErrorMessage(`codiff: ${err.message}`);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

