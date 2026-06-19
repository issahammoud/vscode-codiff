import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

import { DiffPanel } from "./diffPanel";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("codiff.showDiff", () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        vscode.window.showErrorMessage("codiff: no workspace folder open.");
        return;
      }
      DiffPanel.createOrShow(context, workspaceRoot);
      runCodiff(workspaceRoot, context);
    }),

    vscode.commands.registerCommand("codiff.refreshDiff", () => {
      const workspaceRoot = getWorkspaceRoot();
      if (workspaceRoot) {
        runCodiff(workspaceRoot, context);
      }
    })
  );

  // Auto-refresh on save when the panel is open
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const config = vscode.workspace.getConfiguration("codiff");
      if (!config.get<boolean>("autoRefresh", true)) return;
      if (!doc.fileName.endsWith(".py")) return;
      if (!DiffPanel.currentPanel) return;
      const workspaceRoot = getWorkspaceRoot();
      if (workspaceRoot) {
        runCodiff(workspaceRoot, context);
      }
    })
  );
}

export function deactivate() {}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getCodiffPath(): string {
  return vscode.workspace
    .getConfiguration("codiff")
    .get<string>("executablePath", "codiff");
}

function runCodiff(workspaceRoot: string, context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("codiff");
  const baseRef = config.get<string>("baseRef", "HEAD");
  const includeTests = config.get<boolean>("includeTests", false);
  const codiffPath = getCodiffPath();

  const args = [
    "diff",
    "--json",
    "--repo", workspaceRoot,
    "--base", baseRef,
  ];
  if (includeTests) args.push("--include-tests");

  DiffPanel.setLoading(true);

  const proc = spawn(codiffPath, args, { cwd: workspaceRoot });
  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  proc.on("close", (code) => {
    DiffPanel.setLoading(false);

    if (code !== 0 || !stdout.trim()) {
      const msg = stderr.trim() || `codiff exited with code ${code}`;
      vscode.window.showErrorMessage(`codiff: ${msg}`);
      return;
    }

    try {
      const data = JSON.parse(stdout);
      DiffPanel.update(data);
    } catch (e) {
      vscode.window.showErrorMessage("codiff: failed to parse JSON output.");
    }
  });

  proc.on("error", (err) => {
    DiffPanel.setLoading(false);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      vscode.window.showErrorMessage(
        `codiff: executable not found at '${codiffPath}'. Install with: pip install codiff`
      );
    } else {
      vscode.window.showErrorMessage(`codiff: ${err.message}`);
    }
  });
}
