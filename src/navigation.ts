import * as vscode from "vscode";
import * as path from "path";

export async function navigateToFunction(
  functionId: string,
  filePath: string
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;

  const absPath = path.join(root, filePath);
  const fnName  = functionId.split(".").at(-1) ?? functionId;

  try {
    const doc  = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
    const text = doc.getText();

    let pos = new vscode.Position(0, 0);
    for (const pat of [`def ${fnName}`, `class ${fnName}`]) {
      const idx = text.indexOf(pat);
      if (idx !== -1) { pos = doc.positionAt(idx); break; }
    }

    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      selection:  new vscode.Range(pos, pos),
      preview:    false,
    });
  } catch {
    vscode.window.showWarningMessage(`codiff: could not open ${filePath}`);
  }
}
