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
      line-height: 1.5;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
      overflow-x: auto;
    }

    /* ── Loading / empty ─────────────────────────────────── */
    #loading, .empty {
      text-align: center;
      padding: 60px 0;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }
    #loading { display: none; }

    /* ── Summary bar ─────────────────────────────────────── */
    .summary {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }
    .badge {
      padding: 2px 10px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .badge.add { background: #dcfce7; color: #166534; }
    .badge.mod { background: #fef9c3; color: #854d0e; }
    .badge.rem { background: #fee2e2; color: #991b1b; }
    .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .ref   { margin-left: auto; font-family: monospace; }

    /* ── Module grid ─────────────────────────────────────── */
    .modules {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: flex-start;
    }

    .module-card {
      border-radius: 10px;
      border: 1.5px solid var(--vscode-panel-border);
      overflow: hidden;
      min-width: 220px;
      max-width: 340px;
      flex: 1 1 240px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .module-card.add { border-color: #4ade80; }
    .module-card.mod { border-color: #fbbf24; }
    .module-card.rem { border-color: #f87171; }

    .module-header {
      display: flex;
      align-items: center;
      gap: 7px;
      background: #0f172a;
      color: #f8fafc;
      padding: 8px 12px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      letter-spacing: 0.01em;
    }
    .module-icon { font-size: 13px; flex-shrink: 0; }
    .module-path { word-break: break-all; }

    .module-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }

    /* ── Class card ──────────────────────────────────────── */
    .class-card {
      border-radius: 7px;
      border: 1.5px solid var(--vscode-panel-border);
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .class-card.add { border-color: #86efac; }
    .class-card.mod { border-color: #fde68a; }
    .class-card.rem { border-color: #fca5a5; }

    .class-header {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 12px;
      font-weight: 600;
    }
    .class-card.add .class-header { background: #f0fdf4; color: #166534; }
    .class-card.mod .class-header { background: #fefce8; color: #854d0e; }
    .class-card.rem .class-header { background: #fff1f2; color: #991b1b; }

    .standalone-header { opacity: 0.75; }
    .muted-name        { font-style: italic; font-weight: 400; }

    .class-icon {
      width: 18px; height: 18px;
      border-radius: 4px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 800;
      flex-shrink: 0;
    }
    .class-card.add .class-icon { background: #86efac; color: #14532d; }
    .class-card.mod .class-icon { background: #fde68a; color: #78350f; }
    .class-card.rem .class-icon { background: #fca5a5; color: #7f1d1d; }
    .class-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── Methods ─────────────────────────────────────────── */
    .methods { padding: 4px 0; }

    .method {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 3px 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      cursor: pointer;
      border-radius: 4px;
      margin: 1px 4px;
      transition: background 0.1s;
    }
    .method:hover { background: var(--vscode-list-hoverBackground); }

    .vis {
      font-weight: 700;
      width: 12px;
      flex-shrink: 0;
      text-align: center;
    }
    .method.add .vis { color: #16a34a; }
    .method.mod .vis { color: #d97706; }
    .method.rem .vis { color: #dc2626; }

    .fn-name  { color: var(--vscode-foreground); flex-shrink: 0; }
    .struck   { text-decoration: line-through; opacity: 0.6; }

    .hint {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ── Relationships ───────────────────────────────────── */
    .relationships {
      margin-top: 24px;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 16px;
    }
    .rel-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 10px;
    }
    .rel-list  { display: flex; flex-direction: column; gap: 4px; }
    .rel-row   {
      display: flex; align-items: center; gap: 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    .rel-src   { color: var(--vscode-foreground); }
    .rel-arrow { color: var(--vscode-descriptionForeground); }
    .rel-dst   { color: var(--vscode-foreground); }
  </style>
</head>
<body>
  <div id="loading">Running codiff…</div>
  <div id="empty">Run <strong>codiff: Show Structural Diff</strong> to see the call-graph diff.</div>
  <div id="root"></div>
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
