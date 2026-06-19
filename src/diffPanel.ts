import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

/**
 * Manages the single webview panel that renders the codiff output.
 * Only one panel can be open at a time (createOrShow reuses existing).
 */
export class DiffPanel {
  public static currentPanel: DiffPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext
  ) {
    this._panel = panel;
    this._context = context;

    this._panel.webview.html = this._getHtml();

    // Handle messages from the webview (e.g. navigate to function)
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      null,
      this._disposables
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    workspaceRoot: string
  ) {
    const column = vscode.ViewColumn.Beside;
    if (DiffPanel.currentPanel) {
      DiffPanel.currentPanel._panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "codiffDiff",
      "codiff",
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, "dist")),
        ],
        retainContextWhenHidden: true,
      }
    );
    DiffPanel.currentPanel = new DiffPanel(panel, context);
  }

  public static update(data: unknown) {
    DiffPanel.currentPanel?._panel.webview.postMessage({
      type: "update",
      data,
    });
  }

  public static setLoading(loading: boolean) {
    DiffPanel.currentPanel?._panel.webview.postMessage({
      type: "loading",
      loading,
    });
  }

  private _handleMessage(msg: { type: string; functionId?: string }) {
    if (msg.type === "navigate" && msg.functionId) {
      // functionId format: "package.module.ClassName.method"
      // Convert to file path hint and open in editor
      navigateToFunction(msg.functionId);
    }
  }

  private _getHtml(): string {
    const webview = this._panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this._context.extensionPath, "dist", "webview", "panel.js")
      )
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src 'unsafe-inline';" />
  <title>codiff</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
      overflow-x: auto;
    }
    #loading {
      display: none;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 32px 0;
      text-align: center;
    }
    #empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 32px 0;
      text-align: center;
    }
    #diagram { width: 100%; }
    .summary {
      display: flex;
      gap: 16px;
      margin-bottom: 20px;
      font-size: 13px;
    }
    .badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 600;
    }
    .badge-added    { background: #dcfce7; color: #166534; }
    .badge-modified { background: #fefce8; color: #854d0e; }
    .badge-removed  { background: #fff1f2; color: #9f1239; }
  </style>
</head>
<body>
  <div id="loading">Running codiff…</div>
  <div id="empty">Run <strong>codiff: Show Structural Diff</strong> to see the call-graph diff.</div>
  <div id="summary" class="summary" style="display:none"></div>
  <div id="diagram"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose() {
    DiffPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

async function navigateToFunction(functionId: string) {
  // Best-effort: convert "pkg.module.Class.method" → search in workspace
  const parts = functionId.split(".");
  const name = parts[parts.length - 1];
  const files = await vscode.workspace.findFiles("**/*.py", "**/node_modules/**");

  for (const file of files) {
    const doc = await vscode.workspace.openTextDocument(file);
    const text = doc.getText();
    const idx = text.indexOf(`def ${name}`);
    if (idx !== -1) {
      const pos = doc.positionAt(idx);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(pos, pos),
        preview: false,
      });
      return;
    }
  }
  vscode.window.showWarningMessage(`codiff: could not find definition of ${name}`);
}
