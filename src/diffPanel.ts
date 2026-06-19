import * as vscode from "vscode";
import * as path from "path";
import { navigateToFunction } from "./navigation";

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
    DiffPanel.currentPanel?._panel.webview.postMessage({ type: "update", data });
  }

  public static setStatus(status: "refreshing" | "idle") {
    DiffPanel.currentPanel?._panel.webview.postMessage({ type: "status", status });
  }

  private _handleMessage(msg: { type: string; functionId?: string; filePath?: string }) {
    if (msg.type === "navigate" && msg.functionId && msg.filePath) {
      navigateToFunction(msg.functionId, msg.filePath);
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
    }
    #status {
      position: fixed; top: 8px; right: 12px;
      font-size: 11px; color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px; padding: 3px 8px;
      display: none; align-items: center; gap: 5px; z-index: 20;
    }
    #status.visible { display: flex; }

    .class-header {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 12px;
      font-weight: 600;
    }
    /* ── Cytoscape canvas fills remaining space ─────────── */
    html, body { height: 100%; overflow: hidden; }
    body {
      display: flex; flex-direction: column;
      padding: 0;
    }
    #root { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }

    /* ── Summary bar ──────────────────────────────────────── */
    .summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .stats {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .stat {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 6px 18px;
      border-radius: 8px;
      min-width: 72px;
    }
    .stat-num {
      font-size: 22px;
      font-weight: 700;
      line-height: 1;
      font-family: ui-monospace, SFMono-Regular, monospace;
      letter-spacing: -0.5px;
    }
    .stat-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-top: 3px;
      opacity: 0.75;
    }
    .stat.add { background: #dcfce7; }
    .stat.add .stat-num   { color: #15803d; }
    .stat.add .stat-label { color: #16a34a; }
    .stat.mod { background: #fef9c3; }
    .stat.mod .stat-num   { color: #a16207; }
    .stat.mod .stat-label { color: #ca8a04; }
    .stat.rem { background: #fee2e2; }
    .stat.rem .stat-num   { color: #b91c1c; }
    .stat.rem .stat-label { color: #dc2626; }
    .stat.zero { opacity: 0.4; }
    .stat-sep {
      width: 1px; height: 36px;
      background: var(--vscode-panel-border);
      margin: 0 4px;
    }
    .stat.modules {
      background: var(--vscode-input-background, #f1f5f9);
      border: 1px solid var(--vscode-panel-border);
    }
    .stat.modules .stat-num   { color: var(--vscode-foreground); font-size: 18px; }
    .stat.modules .stat-label { color: var(--vscode-descriptionForeground); }
    .ref-badge {
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, monospace;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-input-background, #f1f5f9);
      border: 1px solid var(--vscode-panel-border);
      padding: 4px 10px;
      border-radius: 5px;
      white-space: nowrap;
    }
    .muted  { color: var(--vscode-descriptionForeground); font-size: 12px; }

    .zoom-controls {
      position: absolute; bottom: 16px; right: 16px;
      display: flex; flex-direction: column; gap: 4px; z-index: 10;
    }
    .zoom-controls button {
      width: 28px; height: 28px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      border-radius: 5px; cursor: pointer;
      font-size: 15px; font-weight: 600;
      display: flex; align-items: center; justify-content: center;
    }
    .zoom-controls button:hover { background: var(--vscode-list-hoverBackground); }

    #cy { flex: 1; position: relative; width: 100%; min-height: 0; }
    .empty { text-align: center; padding: 60px 0; color: var(--vscode-descriptionForeground); }
    code { font-family: monospace; }
  </style>
</head>
<body>
  <div id="status"></div>
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

