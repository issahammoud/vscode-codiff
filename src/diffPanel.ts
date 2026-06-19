import * as vscode from "vscode";
import * as path from "path";

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
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px 24px;
      overflow-x: auto;
      min-height: 100vh;
    }

    #loading, #empty {
      text-align: center;
      padding: 60px 0;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }
    #loading { display: none; }

    #summary {
      display: none;
      align-items: center;
      gap: 10px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.01em;
    }
    .badge-added    { background: #dcfce7; color: #166534; }
    .badge-modified { background: #fef9c3; color: #854d0e; }
    .badge-removed  { background: #fee2e2; color: #991b1b; }

    .dim {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .svg-wrap {
      border-radius: 12px;
      overflow: hidden;
      display: inline-block;
      max-width: 100%;
    }
    .svg-wrap svg {
      display: block;
      max-width: 100%;
      height: auto;
    }

    .mermaid-src {
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px 16px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--vscode-editor-foreground);
    }
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
