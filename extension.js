const vscode = require('vscode');
const http = require('http');
const https = require('https');

let currentPanel;
const API_KEY_SECRET = 'traePromptOptimizer.openaiCompatibleApiKey';

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('traePromptOptimizer.openPanel', () => {
      openOptimizerPanel(context, '');
    }),
    vscode.commands.registerCommand('traePromptOptimizer.optimizeSelection', () => {
      const editor = vscode.window.activeTextEditor;
      const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
      openOptimizerPanel(context, selected);
    }),
    vscode.commands.registerCommand('traePromptOptimizer.setApiKey', async () => {
      await promptAndStoreApiKey(context);
    })
  );
}

function deactivate() {}

function openOptimizerPanel(context, initialPrompt) {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside);
    currentPanel.webview.postMessage({ type: 'setPrompt', value: initialPrompt || '' });
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    'traePromptOptimizer',
    'Trae Prompt Optimizer',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  currentPanel.webview.html = getWebviewHtml(currentPanel.webview, initialPrompt || '');

  currentPanel.webview.onDidReceiveMessage(
    async message => {
      try {
        if (message.type === 'copy') {
          await vscode.env.clipboard.writeText(message.value || '');
          vscode.window.showInformationMessage('Optimized prompt copied.');
        }

        if (message.type === 'insert') {
          await insertIntoEditor(message.value || '');
        }

        if (message.type === 'exportMarkdown') {
          await exportMarkdown(message.value || '');
        }

        if (message.type === 'saveRule') {
          await saveWorkspaceRule(message.value || '');
        }

        if (message.type === 'sendToTrae') {
          await sendToTraeChat(message.value || '');
        }

        if (message.type === 'aiOptimize') {
          const optimized = await optimizeWithAi(context, message);
          currentPanel.webview.postMessage({ type: 'aiOptimized', value: optimized });
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Trae Prompt Optimizer failed: ${error.message}`);
        if (message && message.type === 'aiOptimize' && currentPanel) {
          currentPanel.webview.postMessage({ type: 'aiError', value: error.message });
        }
      }
    },
    undefined,
    context.subscriptions
  );

  currentPanel.onDidDispose(() => {
    currentPanel = undefined;
  }, null, context.subscriptions);
}

async function insertIntoEditor(text) {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    await editor.edit(editBuilder => {
      if (editor.selection && !editor.selection.isEmpty) {
        editBuilder.replace(editor.selection, text);
      } else {
        editBuilder.insert(editor.selection.active, text);
      }
    });
    vscode.window.showInformationMessage('Optimized prompt inserted into the editor.');
    return;
  }

  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: text
  });
  await vscode.window.showTextDocument(document);
}

async function exportMarkdown(text) {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file('trae-optimized-prompt.md'),
    filters: {
      Markdown: ['md'],
      Text: ['txt']
    }
  });

  if (!uri) {
    return;
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  vscode.window.showInformationMessage(`Exported prompt to ${uri.fsPath}`);
}

async function saveWorkspaceRule(text) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('Open a workspace folder before saving a Trae rule.');
  }

  const root = folders[0].uri;
  const rulesDir = vscode.Uri.joinPath(root, '.trae', 'rules');
  await vscode.workspace.fs.createDirectory(rulesDir);
  const target = vscode.Uri.joinPath(rulesDir, 'harness-blueprint-prompt.md');
  await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
  vscode.window.showInformationMessage(`Saved workspace rule: ${target.fsPath}`);
}

async function sendToTraeChat(text) {
  await vscode.env.clipboard.writeText(text);

  const configuredCommand = vscode.workspace
    .getConfiguration('traePromptOptimizer')
    .get('traeChatCommand', 'workbench.action.chat.open');

  const candidates = [
    configuredCommand,
    'workbench.action.chat.open',
    'workbench.action.openChat',
    'workbench.panel.chat.view.copilot.focus',
    'github.copilot.openChat'
  ].filter(Boolean);

  const seen = new Set();
  for (const command of candidates) {
    if (seen.has(command)) {
      continue;
    }
    seen.add(command);

    try {
      await vscode.commands.executeCommand(command);
      vscode.window.showInformationMessage('Optimized prompt copied. Paste it into Trae Chat to send.');
      return;
    } catch {
      // Try the next compatible chat command.
    }
  }

  vscode.window.showInformationMessage('Optimized prompt copied. Open Trae Chat and paste it manually.');
}

async function promptAndStoreApiKey(context) {
  const value = await vscode.window.showInputBox({
    title: 'Set OpenAI-compatible API Key',
    prompt: 'Stored in VS Code/Trae SecretStorage. Leave empty to cancel.',
    password: true,
    ignoreFocusOut: true
  });

  if (!value) {
    return false;
  }

  await context.secrets.store(API_KEY_SECRET, value);
  vscode.window.showInformationMessage('AI API key saved for Trae Prompt Optimizer.');
  return true;
}

async function getApiKey(context) {
  let apiKey = await context.secrets.get(API_KEY_SECRET);
  if (apiKey) {
    return apiKey;
  }

  const action = await vscode.window.showWarningMessage(
    'AI optimization needs an OpenAI-compatible API key.',
    'Set API Key',
    'Cancel'
  );

  if (action !== 'Set API Key') {
    throw new Error('AI API key is not configured.');
  }

  const saved = await promptAndStoreApiKey(context);
  if (!saved) {
    throw new Error('AI API key is not configured.');
  }

  apiKey = await context.secrets.get(API_KEY_SECRET);
  if (!apiKey) {
    throw new Error('AI API key is not configured.');
  }

  return apiKey;
}

async function optimizeWithAi(context, message) {
  const config = vscode.workspace.getConfiguration('traePromptOptimizer');
  const baseUrl = config.get('ai.baseUrl', 'https://api.openai.com/v1');
  const model = config.get('ai.model', 'gpt-4o-mini');
  const systemPrompt = config.get(
    'ai.systemPrompt',
    'You are a senior prompt engineer for coding agents. Return only the optimized prompt in Markdown.'
  );
  const apiKey = await getApiKey(context);

  const raw = message.raw || '';
  const current = message.value || '';
  const options = message.options || {};

  const userContent = [
    '请把下面的粗提示词和本地规则生成稿，进一步优化成适合 Trae 编程代理执行的高质量提示词。',
    '要求：',
    '- 只返回最终 Markdown 提示词，不要解释过程。',
    '- 保留用户真实目标，不要扩写成无关产品。',
    '- 明确角色、项目上下文、任务、约束、验收标准、验证命令和最终回复格式。',
    '- 如果是 Harness/DevOps 平台方向，要强调 Go 后端、React/TypeScript 前端、OpenAPI、权限、安全、测试和小步修改。',
    '- 不要包含任何 API Key、token 或敏感信息。',
    '',
    `项目类型：${options.projectType || 'unknown'}`,
    `执行强度：${options.rigor || 'balanced'}`,
    `输出语言：${options.language || 'zh'}`,
    `关注领域：${(options.focus || []).join(', ') || 'auto'}`,
    '',
    '原始提示词：',
    raw || '未提供',
    '',
    '本地规则生成稿：',
    current || '未提供'
  ].join('\n');

  const response = await postOpenAICompatible(baseUrl, apiKey, {
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ]
  });

  const content = response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '';

  if (!content || !content.trim()) {
    throw new Error('AI optimizer returned an empty response.');
  }

  return content.trim();
}

function postOpenAICompatible(baseUrl, apiKey, payload) {
  return new Promise((resolve, reject) => {
    const endpoint = getChatCompletionsEndpoint(baseUrl);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const url = new URL(endpoint);

    const transport = url.protocol === 'http:' ? http : https;
    const request = transport.request(
      {
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': body.length
        },
        timeout: 60000
      },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            reject(new Error(`AI API returned non-JSON response with status ${response.statusCode}.`));
            return;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            const message = json && json.error && json.error.message
              ? json.error.message
              : `AI API request failed with status ${response.statusCode}.`;
            reject(new Error(message));
            return;
          }

          resolve(json);
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error('AI API request timed out.'));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function getChatCompletionsEndpoint(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('AI base URL is not configured.');
  }

  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }

  return `${trimmed}/chat/completions`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function getWebviewHtml(webview, initialPrompt) {
  const nonce = getNonce();
  const escapedInitial = escapeHtml(initialPrompt);
  const initialPromptJson = JSON.stringify(initialPrompt || '').replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trae Prompt Optimizer</title>
  <style>
    :root {
      --bg: #f6f4ef;
      --panel: #fffdf8;
      --panel-strong: #f0ede5;
      --ink: #262b2c;
      --muted: #687173;
      --line: #ded8cc;
      --teal: #0f766e;
      --teal-dark: #0b5f59;
      --amber: #b97912;
      --rose: #9f3a48;
      --shadow: 0 18px 50px rgba(38, 43, 44, 0.08);
      --radius: 8px;
      color-scheme: light;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: var(--ink);
      background:
        linear-gradient(rgba(38, 43, 44, 0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(38, 43, 44, 0.035) 1px, transparent 1px),
        var(--bg);
      background-size: 22px 22px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    button,
    select,
    textarea,
    input {
      font: inherit;
    }

    .shell {
      min-height: 100vh;
      padding: 18px;
    }

    .topbar {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) auto;
      gap: 16px;
      align-items: center;
      margin-bottom: 14px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .mark {
      width: 36px;
      height: 36px;
      display: grid;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--ink);
      color: #fffdf8;
      font-weight: 800;
      line-height: 1;
    }

    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.25;
    }

    .subtitle {
      margin: 3px 0 0;
      color: var(--muted);
      font-size: 12px;
    }

    .top-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }

    .workspace {
      display: grid;
      grid-template-columns: minmax(320px, 0.92fr) minmax(380px, 1.08fr);
      gap: 14px;
      min-height: calc(100vh - 150px);
    }

    .panel {
      display: flex;
      min-width: 0;
      min-height: 540px;
      flex-direction: column;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(255, 253, 248, 0.94);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: rgba(240, 237, 229, 0.72);
    }

    .panel-title {
      display: flex;
      align-items: center;
      gap: 9px;
      font-size: 13px;
      font-weight: 800;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 99px;
      background: var(--teal);
    }

    .meta {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .controls {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }

    .field {
      min-width: 0;
    }

    label,
    .label {
      display: block;
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
    }

    select,
    input[type="text"] {
      width: 100%;
      height: 34px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      color: var(--ink);
      background: #fff;
      outline: none;
    }

    select:focus,
    input[type="text"]:focus,
    textarea:focus {
      border-color: rgba(15, 118, 110, 0.65);
      box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.12);
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 29px;
      padding: 5px 9px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--ink);
      font-size: 12px;
      cursor: pointer;
      user-select: none;
    }

    .chip input {
      accent-color: var(--teal);
    }

    textarea {
      width: 100%;
      min-height: 0;
      flex: 1;
      padding: 14px;
      border: 0;
      resize: none;
      color: var(--ink);
      background: transparent;
      outline: none;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.62;
      letter-spacing: 0;
    }

    .output-wrap {
      display: grid;
      grid-template-rows: auto 1fr;
      min-height: 0;
      flex: 1;
    }

    .scorebar {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 12px;
      align-items: center;
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
    }

    .score {
      display: grid;
      place-items: center;
      width: 48px;
      height: 48px;
      border-radius: var(--radius);
      background: var(--ink);
      color: #fffdf8;
      font-size: 17px;
      font-weight: 900;
    }

    .score-copy {
      min-width: 0;
    }

    .score-title {
      margin: 0 0 4px;
      font-size: 13px;
      font-weight: 800;
    }

    .score-reason {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }

    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }

    .pill {
      padding: 4px 8px;
      border: 1px solid rgba(15, 118, 110, 0.25);
      border-radius: 999px;
      background: rgba(15, 118, 110, 0.09);
      color: var(--teal-dark);
      font-size: 11px;
      font-weight: 800;
    }

    .btn {
      min-height: 34px;
      padding: 7px 11px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #fff;
      color: var(--ink);
      cursor: pointer;
      font-size: 12px;
      font-weight: 800;
    }

    .btn:hover {
      border-color: rgba(15, 118, 110, 0.55);
      color: var(--teal-dark);
    }

    .btn.primary {
      border-color: var(--teal);
      background: var(--teal);
      color: #fff;
    }

    .btn.primary:hover {
      border-color: var(--teal-dark);
      background: var(--teal-dark);
      color: #fff;
    }

    .btn.warn {
      border-color: rgba(185, 121, 18, 0.48);
      color: #7b4c06;
    }

    .history {
      margin-top: 14px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(255, 253, 248, 0.92);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .history-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: rgba(240, 237, 229, 0.72);
    }

    .history-list {
      display: grid;
      grid-template-columns: repeat(4, minmax(160px, 1fr));
      gap: 8px;
      padding: 10px;
    }

    .history-item {
      min-height: 62px;
      padding: 9px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #fff;
      cursor: pointer;
      text-align: left;
    }

    .history-item strong {
      display: block;
      margin-bottom: 5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }

    .history-item span {
      display: -webkit-box;
      overflow: hidden;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.4;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      transform: translateY(18px);
      opacity: 0;
      padding: 10px 12px;
      border-radius: var(--radius);
      background: var(--ink);
      color: #fffdf8;
      font-size: 12px;
      box-shadow: var(--shadow);
      transition: 180ms ease;
      pointer-events: none;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    @media (max-width: 980px) {
      .topbar,
      .workspace {
        grid-template-columns: 1fr;
      }

      .top-actions {
        justify-content: flex-start;
      }

      .controls {
        grid-template-columns: 1fr;
      }

      .history-list {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="mark">T</div>
        <div>
          <h1>Trae Prompt Optimizer</h1>
          <p class="subtitle">把粗提示词整理成 Trae 可执行的工程化提示词，蓝本参考 Harness。</p>
        </div>
      </div>
      <div class="top-actions">
        <button class="btn" id="exampleBtn">示例</button>
        <button class="btn warn" id="aiBtn">AI 二次优化</button>
        <button class="btn" id="sendTraeBtn">发送到 Trae</button>
        <button class="btn warn" id="saveRuleBtn">保存为 Trae Rule</button>
        <button class="btn" id="exportBtn">导出 Markdown</button>
        <button class="btn" id="insertBtn">插入编辑器</button>
        <button class="btn primary" id="copyBtn">复制结果</button>
      </div>
    </header>

    <section class="workspace">
      <article class="panel">
        <div class="panel-head">
          <div class="panel-title"><span class="dot"></span>原始提示词</div>
          <div class="meta"><span id="inputCount">0</span> 字</div>
        </div>
        <div class="controls">
          <div class="field">
            <label for="projectType">项目类型</label>
            <select id="projectType">
              <option value="harness">Harness / DevOps 平台</option>
              <option value="fullstack">全栈产品</option>
              <option value="backend">Go 后端服务</option>
              <option value="frontend">前端应用</option>
              <option value="generic">通用代码任务</option>
            </select>
          </div>
          <div class="field">
            <label for="rigor">执行强度</label>
            <select id="rigor">
              <option value="balanced">平衡：实现 + 验证</option>
              <option value="strict">严格：权限/测试/迁移优先</option>
              <option value="fast">快速：小改动优先</option>
            </select>
          </div>
          <div class="field">
            <label for="language">输出语言</label>
            <select id="language">
              <option value="zh">中文</option>
              <option value="mixed">中文 + 英文术语</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>
        <div class="chips" aria-label="Focus areas">
          <label class="chip"><input type="checkbox" value="backend" checked>后端</label>
          <label class="chip"><input type="checkbox" value="frontend" checked>前端</label>
          <label class="chip"><input type="checkbox" value="api" checked>API</label>
          <label class="chip"><input type="checkbox" value="security" checked>安全权限</label>
          <label class="chip"><input type="checkbox" value="tests" checked>测试</label>
          <label class="chip"><input type="checkbox" value="data">数据迁移</label>
          <label class="chip"><input type="checkbox" value="docs">文档</label>
          <label class="chip"><input type="checkbox" value="ci">CI/CD</label>
          <label class="chip"><input type="checkbox" value="registry">制品仓库</label>
        </div>
        <textarea id="rawPrompt" placeholder="例：我想给项目加一个 PR 自动检查功能，能看流水线结果，合并前必须通过。">${escapedInitial}</textarea>
      </article>

      <article class="panel">
        <div class="panel-head">
          <div class="panel-title"><span class="dot"></span>优化结果</div>
          <div class="meta">Trae-ready Markdown</div>
        </div>
        <div class="output-wrap">
          <div class="scorebar">
            <div class="score" id="score">0</div>
            <div class="score-copy">
              <p class="score-title" id="scoreTitle">等待输入</p>
              <p class="score-reason" id="scoreReason">输入需求后会自动补齐角色、上下文、任务、验收标准和验证流程。</p>
            </div>
            <div class="pill-row" id="pillRow"></div>
          </div>
          <textarea id="optimizedPrompt" readonly></textarea>
        </div>
      </article>
    </section>

    <section class="history">
      <div class="history-head">
        <div class="panel-title"><span class="dot"></span>最近优化</div>
        <button class="btn" id="clearHistoryBtn">清空</button>
      </div>
      <div class="history-list" id="historyList"></div>
    </section>
  </main>
  <div class="toast" id="toast">已复制</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialPrompt = ${initialPromptJson};

    const rawPrompt = document.getElementById('rawPrompt');
    const optimizedPrompt = document.getElementById('optimizedPrompt');
    const projectType = document.getElementById('projectType');
    const rigor = document.getElementById('rigor');
    const language = document.getElementById('language');
    const inputCount = document.getElementById('inputCount');
    const score = document.getElementById('score');
    const scoreTitle = document.getElementById('scoreTitle');
    const scoreReason = document.getElementById('scoreReason');
    const pillRow = document.getElementById('pillRow');
    const historyList = document.getElementById('historyList');
    const toast = document.getElementById('toast');

    const example = '我想做一个像 Harness 一样的开源 DevOps 平台，先实现仓库页面和流水线执行列表。后端用 Go，前端用 React，希望 Trae 帮我先读代码结构再修改。';

    const focusLabels = {
      backend: 'Go 后端',
      frontend: 'React 前端',
      api: 'OpenAPI',
      security: '权限/安全',
      tests: '测试',
      data: '迁移',
      docs: '文档',
      ci: 'CI/CD',
      registry: 'Registry'
    };

    const projectBlueprints = {
      harness: {
        title: 'Harness / DevOps 平台蓝本',
        context: [
          '项目以 Harness Open Source 为工程蓝本：代码托管、CI/CD Pipelines、Gitspaces、Artifact Registry、权限、安全、API、CLI 和 Web UI 是统一产品的一部分。',
          '后端优先参考 Go 单体分层：api/handler/controller、services、store、cmd 入口、registry 独立域。',
          '前端优先参考 React + TypeScript + SCSS Modules + 生成式 API client 的模式。'
        ],
        domains: ['space/repo/branch/commit/pull request', 'pipeline/trigger/execution/log/secret', 'gitspace/infra provider/event', 'artifact/manifest/blob/remote proxy']
      },
      fullstack: {
        title: '全栈产品任务',
        context: [
          '先识别现有前后端边界、路由、服务层、数据层和测试框架。',
          '优先沿用项目已有组件、状态管理、API client、错误处理和验证流程。'
        ],
        domains: ['API', 'UI workflow', 'data model', 'tests']
      },
      backend: {
        title: 'Go 后端任务',
        context: [
          '先定位 handler/service/store/model/test 的既有模式。',
          '所有请求链路传递 context.Context，错误可诊断但不泄漏敏感数据。'
        ],
        domains: ['service layer', 'store layer', 'migration', 'authz', 'tests']
      },
      frontend: {
        title: '前端应用任务',
        context: [
          '先定位页面、组件、hooks、services、样式和路由模式。',
          '页面必须覆盖 loading、empty、error、permission denied、提交中和成功反馈。'
        ],
        domains: ['routing', 'components', 'forms', 'state', 'responsive UI']
      },
      generic: {
        title: '通用代码任务',
        context: [
          '先读代码再动手，优先使用现有模式和本地工具。',
          '保持改动小、可验证、可回滚，不做无关重构。'
        ],
        domains: ['scope', 'implementation', 'verification']
      }
    };

    function selectedFocus() {
      return Array.from(document.querySelectorAll('.chip input:checked')).map(input => input.value);
    }

    function analyze(raw) {
      const text = raw.trim();
      const checks = [
        { key: 'goal', ok: text.length >= 10, label: '目标' },
        { key: 'scope', ok: /(后端|前端|api|接口|页面|数据库|权限|测试|pipeline|流水线|仓库|repo|registry|gitspace|cli|bug|修复|实现|优化)/i.test(text), label: '范围' },
        { key: 'acceptance', ok: /(验收|标准|必须|需要|完成|通过|用户能|能够|should|must)/i.test(text), label: '验收' },
        { key: 'tech', ok: /(go|golang|react|typescript|ts|node|docker|postgres|mysql|sqlite|openapi|swagger|trae|harness)/i.test(text), label: '技术栈' },
        { key: 'verify', ok: /(测试|lint|build|构建|typecheck|go test|yarn|npm|验证|检查)/i.test(text), label: '验证' },
        { key: 'safety', ok: /(权限|安全|secret|token|pat|迁移|兼容|回滚|审计|敏感)/i.test(text), label: '安全' }
      ];
      const passed = checks.filter(item => item.ok);
      const value = Math.min(98, Math.max(18, Math.round((passed.length / checks.length) * 78 + Math.min(text.length / 18, 20))));
      return { value, checks, missing: checks.filter(item => !item.ok).map(item => item.label) };
    }

    function firstSentence(raw) {
      const cleaned = raw.trim().replace(/\\s+/g, ' ');
      if (!cleaned) {
        return '请根据下面的上下文完成当前代码任务。';
      }
      const match = cleaned.match(/^(.{1,120}?)(。|！|!|？|\\?|\\n|$)/);
      return match ? match[1].trim() : cleaned.slice(0, 120).trim();
    }

    function bulletList(items) {
      return items.map(item => '- ' + item).join('\\n');
    }

    function buildPrompt() {
      const raw = rawPrompt.value.trim();
      const focus = selectedFocus();
      const blueprint = projectBlueprints[projectType.value] || projectBlueprints.generic;
      const assessment = analyze(raw);
      const goal = firstSentence(raw);
      const strictMode = rigor.value === 'strict';
      const fastMode = rigor.value === 'fast';
      const isEnglish = language.value === 'en';

      const focusText = focus.length ? focus.map(key => focusLabels[key]).join('、') : '按代码上下文判断';
      const verification = [];

      if (focus.includes('backend')) verification.push('Go: run targeted go test for changed packages; use make format / make lint-local when applicable.');
      if (focus.includes('frontend')) verification.push('Web: run typecheck/lint/test/build commands already defined by the project.');
      if (focus.includes('api')) verification.push('API: update OpenAPI/Swagger and generated client when request/response contracts change.');
      if (focus.includes('security')) verification.push('Security: verify authn/authz, scope checks, sensitive-data redaction, and audit/log behavior.');
      if (focus.includes('data')) verification.push('Data: include migration, rollback/compatibility notes, indexes, and backfill risks.');
      if (focus.includes('tests')) verification.push('Tests: add or update focused tests for success and failure paths.');
      if (!verification.length) verification.push('Run the smallest relevant verification first, then broader checks if the blast radius is high.');

      const taskBody = raw || '【在这里粘贴你的具体功能、Bug、重构或优化需求】';

      if (isEnglish) {
        return [
          '# Trae Engineering Prompt',
          '',
          '## Role',
          'You are a senior engineering agent working inside Trae. Read the repository before editing, follow existing architecture, and finish with implementation plus verification.',
          '',
          '## Blueprint',
          blueprint.title,
          bulletList(blueprint.context),
          '',
          '## Current Task',
          taskBody,
          '',
          '## Goal',
          goal,
          '',
          '## Focus Areas',
          focusText,
          '',
          '## Execution Rules',
          bulletList([
            'Inspect existing files, types, helpers, routes, tests, and naming before changing code.',
            'Keep changes tightly scoped to the task.',
            'Reuse existing dependencies, components, services, stores, and generated clients.',
            strictMode ? 'Treat permissions, migrations, security, and tests as release blockers.' : fastMode ? 'Prefer the smallest useful patch, but do not skip necessary verification.' : 'Balance implementation speed with maintainability and verification.',
            'Do not leak secrets, tokens, credentials, repository data, or private URLs in logs or examples.'
          ]),
          '',
          '## Acceptance Criteria',
          bulletList([
            'The requested user workflow works end to end.',
            'Behavior is covered by focused tests or a clearly stated manual verification path.',
            'API, data, permission, and UI state changes are documented in the final response.',
            'No unrelated files or broad refactors are included.'
          ]),
          '',
          '## Verification',
          bulletList(verification),
          '',
          '## Final Response Format',
          bulletList([
            'Summary of changes',
            'Files changed',
            'Verification run',
            'Remaining risks or follow-ups'
          ])
        ].join('\\n');
      }

      return [
        '# Trae 工程提示词',
        '',
        '## 角色',
        '你是一个在 Trae 中工作的资深工程代理。先读仓库，再做修改；优先沿用现有架构、命名、组件、服务和测试模式；完成后必须说明验证结果。',
        '',
        '## 项目蓝本',
        blueprint.title,
        bulletList(blueprint.context),
        '',
        '可参考的业务域：',
        bulletList(blueprint.domains),
        '',
        '## 当前任务',
        taskBody,
        '',
        '## 目标',
        goal,
        '',
        '## 重点关注',
        focusText,
        '',
        '## 执行规则',
        bulletList([
          '先定位相关目录、接口、类型、测试和调用链，再开始编辑。',
          '保持改动范围小，不做无关重构，不随意引入新依赖。',
          '后端改动要检查 API、service、store、权限、审计、错误处理和测试。',
          '前端改动要检查路由、生成的 service client、loading/empty/error/permission 状态和响应式布局。',
          strictMode ? '把权限、安全、数据迁移、兼容性和测试作为阻塞项处理。' : fastMode ? '优先小步快改，但不能跳过必要验证。' : '在实现速度、可维护性和验证完整性之间保持平衡。',
          '不要把 secret、token、PAT、registry 凭据、私有 URL 或敏感数据写入日志、示例或测试快照。'
        ]),
        '',
        '## 验收标准',
        bulletList([
          '用户描述的核心流程可以端到端完成。',
          '新增或修改的行为有聚焦测试，或给出明确的手动验证路径。',
          '涉及 API 合约时同步 OpenAPI/Swagger，并说明是否需要重新生成前端 client。',
          '涉及数据结构时说明 migration、兼容旧数据、索引和回滚风险。',
          '最终改动不包含无关文件和大范围格式化。'
        ]),
        '',
        '## 建议验证',
        bulletList(verification),
        '',
        '## 最终回复格式',
        bulletList([
          '变更摘要',
          '关键文件',
          '验证命令与结果',
          '未覆盖风险或后续建议'
        ])
      ].join('\\n');
    }

    function refresh() {
      const raw = rawPrompt.value;
      inputCount.textContent = String(raw.length);
      const result = buildPrompt();
      optimizedPrompt.value = result;

      const assessment = analyze(raw);
      score.textContent = String(assessment.value);
      const missing = assessment.missing;
      scoreTitle.textContent = assessment.value >= 82 ? '提示词结构完整' : assessment.value >= 58 ? '已补齐关键工程约束' : '需要更多上下文';
      scoreReason.textContent = missing.length
        ? '自动补齐：' + missing.join('、') + '。'
        : '目标、范围、验收、技术栈、验证和安全要点都比较明确。';

      pillRow.innerHTML = '';
      selectedFocus().slice(0, 4).forEach(key => {
        const pill = document.createElement('span');
        pill.className = 'pill';
        pill.textContent = focusLabels[key];
        pillRow.appendChild(pill);
      });
    }

    function saveHistory() {
      const raw = rawPrompt.value.trim();
      if (!raw) return;
      const item = {
        at: new Date().toLocaleString(),
        raw,
        output: optimizedPrompt.value,
        projectType: projectType.value,
        rigor: rigor.value,
        language: language.value,
        focus: selectedFocus()
      };
      const history = loadHistory().filter(existing => existing.raw !== raw);
      history.unshift(item);
      localStorage.setItem('traePromptOptimizer.history', JSON.stringify(history.slice(0, 8)));
      renderHistory();
    }

    function loadHistory() {
      try {
        return JSON.parse(localStorage.getItem('traePromptOptimizer.history') || '[]');
      } catch {
        return [];
      }
    }

    function renderHistory() {
      const history = loadHistory();
      historyList.innerHTML = '';
      if (!history.length) {
        const empty = document.createElement('div');
        empty.className = 'history-item';
        empty.innerHTML = '<strong>暂无历史</strong><span>优化后会保存在这个面板里，方便反复调整。</span>';
        historyList.appendChild(empty);
        return;
      }

      history.forEach(item => {
        const button = document.createElement('button');
        button.className = 'history-item';
        button.innerHTML = '<strong>' + escapeHtml(item.raw.slice(0, 42)) + '</strong><span>' + escapeHtml(item.at) + ' · ' + escapeHtml((item.focus || []).map(key => focusLabels[key]).join(' / ')) + '</span>';
        button.addEventListener('click', () => {
          rawPrompt.value = item.raw;
          projectType.value = item.projectType || 'harness';
          rigor.value = item.rigor || 'balanced';
          language.value = item.language || 'zh';
          document.querySelectorAll('.chip input').forEach(input => {
            input.checked = (item.focus || []).includes(input.value);
          });
          refresh();
        });
        historyList.appendChild(button);
      });
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function notify(message) {
      toast.textContent = message;
      toast.classList.add('show');
      window.setTimeout(() => toast.classList.remove('show'), 1400);
    }

    function post(type) {
      saveHistory();
      vscode.postMessage({ type, value: optimizedPrompt.value });
    }

    function postAiOptimize() {
      saveHistory();
      const aiBtn = document.getElementById('aiBtn');
      aiBtn.disabled = true;
      aiBtn.textContent = '优化中...';
      vscode.postMessage({
        type: 'aiOptimize',
        value: optimizedPrompt.value,
        raw: rawPrompt.value,
        options: {
          projectType: projectType.value,
          rigor: rigor.value,
          language: language.value,
          focus: selectedFocus()
        }
      });
      notify('正在请求 AI 优化');
    }

    document.getElementById('copyBtn').addEventListener('click', () => post('copy'));
    document.getElementById('sendTraeBtn').addEventListener('click', () => post('sendToTrae'));
    document.getElementById('aiBtn').addEventListener('click', postAiOptimize);
    document.getElementById('insertBtn').addEventListener('click', () => post('insert'));
    document.getElementById('exportBtn').addEventListener('click', () => post('exportMarkdown'));
    document.getElementById('saveRuleBtn').addEventListener('click', () => post('saveRule'));
    document.getElementById('exampleBtn').addEventListener('click', () => {
      rawPrompt.value = example;
      refresh();
      notify('已填入示例');
    });
    document.getElementById('clearHistoryBtn').addEventListener('click', () => {
      localStorage.removeItem('traePromptOptimizer.history');
      renderHistory();
    });

    rawPrompt.addEventListener('input', refresh);
    projectType.addEventListener('change', refresh);
    rigor.addEventListener('change', refresh);
    language.addEventListener('change', refresh);
    document.querySelectorAll('.chip input').forEach(input => input.addEventListener('change', refresh));

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'setPrompt' && message.value) {
        rawPrompt.value = message.value;
        refresh();
      }

      if (message.type === 'aiOptimized') {
        optimizedPrompt.value = message.value || optimizedPrompt.value;
        saveHistory();
        const aiBtn = document.getElementById('aiBtn');
        aiBtn.disabled = false;
        aiBtn.textContent = 'AI 二次优化';
        score.textContent = 'AI';
        scoreTitle.textContent = 'AI 已二次优化';
        scoreReason.textContent = '结果来自你配置的 OpenAI-compatible API。';
        notify('AI 优化完成');
      }

      if (message.type === 'aiError') {
        const aiBtn = document.getElementById('aiBtn');
        aiBtn.disabled = false;
        aiBtn.textContent = 'AI 二次优化';
        notify('AI 优化失败');
      }
    });

    if (!rawPrompt.value.trim() && initialPrompt) {
      rawPrompt.value = initialPrompt;
    }
    refresh();
    renderHistory();
  </script>
</body>
</html>`;
}

module.exports = {
  activate,
  deactivate
};
