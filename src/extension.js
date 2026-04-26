const vscode = require('vscode');
const path = require('path');
const { analyzeWorkspace } = require('./pythonAnalyzer');

let graphPanel;

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('pythonCodeGraph.openGraph', async () => {
      await openGraphPanel(context);
    })
  );
}

async function openGraphPanel(context) {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('Open a Python workspace folder first.');
    return;
  }

  if (graphPanel) {
    graphPanel.reveal(vscode.ViewColumn.Beside);
    await refreshGraph(graphPanel);
    return;
  }

  graphPanel = vscode.window.createWebviewPanel(
    'pythonCodeGraph',
    'Python Code Graph',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
    }
  );

  graphPanel.webview.html = getWebviewHtml(graphPanel.webview, context.extensionPath);

  graphPanel.onDidDispose(() => {
    graphPanel = undefined;
  });

  graphPanel.webview.onDidReceiveMessage(async (message) => {
    switch (message.type) {
      case 'ready':
      case 'refreshGraph':
        await refreshGraph(graphPanel);
        break;
      case 'openNode':
        if (message.node) {
          await openNodeInEditor(message.node);
        }
        break;
      default:
        break;
    }
  });

  await refreshGraph(graphPanel);
}

async function refreshGraph(panel) {
  try {
    const graph = await analyzeWorkspace();
    panel.webview.postMessage({ type: 'graphData', graph });
  } catch (error) {
    panel.webview.postMessage({
      type: 'graphError',
      error: error && error.message ? error.message : String(error)
    });
    vscode.window.showErrorMessage(`Python Code Graph failed: ${error.message || String(error)}`);
  }
}

async function openNodeInEditor(node) {
  if (!node || !node.filePath) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(node.filePath));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const lineIndex = Math.max((node.line || 1) - 1, 0);
  const position = new vscode.Position(lineIndex, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

function getWebviewHtml(webview, extensionPath) {
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'media', 'graph.js')));
  const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'media', 'styles.css')));
  const nonce = String(Date.now());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Python Code Graph</title>
</head>
<body>
  <div class="app">
    <header class="toolbar">
      <div class="toolbar__left">
        <div>
          <div class="eyebrow">Codebase understanding</div>
          <h1>Python Code Graph</h1>
        </div>
        <span id="stats" class="stats">Indexing workspace…</span>
      </div>
      <div class="toolbar__right">
        <input id="searchInput" type="text" placeholder="Search file, symbol, route, command" />
        <button id="resetButton">Reset View</button>
        <button id="refreshButton" class="button-primary">Refresh</button>
      </div>
    </header>

    <section class="summary-bar">
      <div id="summaryChips" class="summary-chips"></div>
      <div class="summary-note">Find entry points, explain code, and estimate blast radius before you change anything.</div>
    </section>

    <section class="filters">
      <label><input type="checkbox" value="calls" checked /> Calls</label>
      <label><input type="checkbox" value="imports" checked /> Imports</label>
      <label><input type="checkbox" value="contains" /> Contains</label>
      <span class="hint">Click to focus. Double-click to open source. Drag nodes to arrange. Drag canvas to pan. Mouse wheel to zoom.</span>
    </section>

    <main class="main">
      <section class="graph-pane">
        <div class="graph-head">
          <div>
            <div class="section-kicker">Graph</div>
            <h2>Architecture map</h2>
          </div>
          <div id="graphLegend" class="graph-legend">
            <span><i class="legend-dot legend-dot--entry"></i> Entry point</span>
            <span><i class="legend-dot legend-dot--hot"></i> Hotspot</span>
            <span><i class="legend-dot legend-dot--selected"></i> Selected</span>
          </div>
        </div>
        <div class="graph-shell">
          <canvas id="graphCanvas"></canvas>
          <div id="emptyState" class="empty-state hidden">No graph data yet.</div>
        </div>
      </section>

      <aside class="sidebar">
        <div class="panel-block compact-block">
          <div class="panel-header">
            <div>
              <div class="section-kicker">Start here</div>
              <h2>Entry points</h2>
            </div>
          </div>
          <div id="startHereList" class="stack-list"></div>
        </div>

        <div class="panel-block compact-block">
          <div class="panel-header">
            <div>
              <div class="section-kicker">Critical paths</div>
              <h2>High-signal flows</h2>
            </div>
          </div>
          <div id="criticalPathsList" class="stack-list"></div>
        </div>

        <div class="panel-block compact-block">
          <div class="panel-header">
            <div>
              <div class="section-kicker">Hotspots</div>
              <h2>Most connected areas</h2>
            </div>
          </div>
          <div id="hotspotsList" class="stack-list"></div>
        </div>

        <div class="panel-block inspector-block">
          <div class="panel-header panel-header--spaced">
            <div>
              <div class="section-kicker">Selected symbol</div>
              <h2 id="inspectorTitle">Nothing selected</h2>
            </div>
            <button id="openButton" class="button-primary" disabled>Open in editor</button>
          </div>

          <div class="tabbar" role="tablist" aria-label="Inspector tabs">
            <button class="tab is-active" data-tab="overview">Overview</button>
            <button class="tab" data-tab="explain">Explain</button>
            <button class="tab" data-tab="impact">Impact</button>
            <button class="tab" data-tab="path">Path</button>
          </div>

          <div id="inspectorContent" class="inspector-content muted">Select a node to inspect it.</div>
        </div>
      </aside>
    </main>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
