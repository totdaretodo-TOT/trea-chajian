
const vscode = require('vscode');
const http = require('http');
const https = require('https');

let currentPanel;
let currentPlanSession;

// The API key secret now depends on the selected provider.
function apiKeySecretName(provider) {
  return `traePromptOptimizer.${provider}.apiKey`;
}
const PLAN_CONTEXT_FILE_LIMIT = 20 * 1024;
const PLAN_CONTEXT_TOTAL_LIMIT = 60 * 1024;
const PLAN_QUESTION_MIN = 5;
const PLAN_QUESTION_MAX = 8;

const DEFAULT_AI_SYSTEM_PROMPT = [
  'You are a senior product-and-engineering prompt coach for Trae users.',
  'Turn a rough one-sentence idea into a question-driven landing plan and a Trae-ready execution prompt.',
  'Do not merely polish wording. Ask the missing questions, make safe temporary assumptions, define the MVP, and write clear acceptance criteria.',
  'Return Markdown only and never include API keys, tokens, credentials, or secrets.'
].join(' ');

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

function deactivate() { }

function getProviderPreset(provider) {
  const presets = {
    openai: {
      label: 'OpenAI-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini'
    },
    nvidia: {
      label: 'NVIDIA API Catalog',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'nvidia/llama-3.1-nemotron-nano-8b-v1'
    },
    deepseek: {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat'
    },
    gemini: {
      label: 'Gemini OpenAI-compatible',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.0-flash'
    },
    kimi: {
      label: 'Kimi / Moonshot',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k2-0711-preview'
    },
    groq: {
      label: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile'
    },
    openrouter: {
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4o-mini'
    },
    doubao: {
      label: 'Volcengine Ark / Doubao',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seed-1-6-250615'
    },
    doubaoCoding: {
      label: 'Doubao Coding Plan',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      model: 'doubao-seed-2-0-code-preview-260215'
    },
    custom: {
      label: 'Custom OpenAI-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini'
    }
  };

  return presets[provider] || presets.openai;
}

function getAiConfig(overrides) {
  const config = vscode.workspace.getConfiguration('traePromptOptimizer');
  const provider = overrides && overrides.provider
    ? overrides.provider
    : config.get('ai.provider', 'openai');
  const preset = getProviderPreset(provider);
  const rawBaseUrl = overrides && overrides.baseUrl
    ? overrides.baseUrl
    : config.get('ai.baseUrl', preset.baseUrl);
  const rawModel = overrides && overrides.model
    ? overrides.model
    : config.get('ai.model', preset.model);

  return {
    provider,
    label: preset.label,
    baseUrl: normalizeBaseUrl(rawBaseUrl || preset.baseUrl),
    model: rawModel || preset.model,
    systemPrompt: config.get(
      'ai.systemPrompt',
      DEFAULT_AI_SYSTEM_PROMPT
    )
  };
}

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
        await handleWebviewMessage(context, message || {});
      } catch (error) {
        const messageText = error && error.message ? error.message : String(error);
        vscode.window.showErrorMessage(`Trae Prompt Optimizer failed: ${messageText}`);
        if (message && ['planStart', 'planAnswer', 'planFinalize'].includes(message.type) && currentPanel) {
          currentPanel.webview.postMessage({ type: 'planError', value: friendlyAiError(messageText, message.options || (message.session && message.session.options) || {}) });
        } else if (message && message.type === 'exportMcpContext' && currentPanel) {
          currentPanel.webview.postMessage({ type: 'mcpContextError', value: messageText });
        } else if (message && ['aiOptimize', 'listModels', 'testAi', 'saveApiKey', 'diagnoseAi'].includes(message.type) && currentPanel) {
          currentPanel.webview.postMessage({ type: 'aiError', value: friendlyAiError(messageText, message.options || message.ai || {}) });
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

async function handleWebviewMessage(context, message) {
  const value = message.value || '';

  if (message.type === 'copy') {
    await vscode.env.clipboard.writeText(value);
    vscode.window.showInformationMessage('Optimized prompt copied.');
    return;
  }

  if (message.type === 'insert') {
    await insertIntoEditor(value);
    return;
  }

  if (message.type === 'exportMarkdown') {
    await exportMarkdown(value);
    return;
  }

  if (message.type === 'saveRule') {
    await saveWorkspaceRule(value);
    return;
  }

  if (message.type === 'sendToTrae') {
    await sendToTraeChat(value);
    return;
  }

  if (message.type === 'aiOptimize') {
    const optimized = await optimizeWithAi(context, message);
    if (currentPanel) {
      currentPanel.webview.postMessage({ type: 'aiOptimized', value: optimized });
    }
    return;
  }

  if (message.type === 'planStart') {
    const result = await startPlanSession(context, message);
    if (currentPanel) {
      currentPanel.webview.postMessage({ type: 'planUpdated', value: result });
    }
    return;
  }

  if (message.type === 'planAnswer') {
    const result = await continuePlanSession(context, message);
    if (currentPanel) {
      currentPanel.webview.postMessage({ type: 'planUpdated', value: result });
    }
    return;
  }

  if (message.type === 'planFinalize') {
    const result = await finalizePlanSession(context, message);
    if (currentPanel) {
      currentPanel.webview.postMessage({ type: 'planUpdated', value: result });
    }
    return;
  }

  if (message.type === 'listModels') {
    const models = await listAiModels(context, message.options || {});
    if (currentPanel) {
      currentPanel.webview.postMessage({ type: 'modelsListed', value: models });
    }
    return;
  }

  if (message.type === 'testAi') {
    const result = await testAiConnection(context, message.options || {});
    if (currentPanel) {
      currentPanel.webview.postMessage({ type: 'aiTested', value: result });
    }
    return;
  }

  if (message.type === 'saveApiKey') {
    await storeApiKey(context, message.apiKey || '', message.options && message.options.provider);
    if (currentPanel) {
      currentPanel.webview.postMessage({ type: 'apiKeySaved' });
    }
    return;
  }

  if (message.type === 'getApiKeyStatus') {
    const provider = message.options && message.options.provider ? message.options.provider : getAiConfig({}).provider;
    const hasApiKey = Boolean(await context.secrets.get(apiKeySecretName(provider)));
    if (currentPanel) {
      currentPanel.webview.postMessage({ type: 'apiKeyStatus', value: { hasApiKey } });
    }
    return;
  }

  if (message.type === 'diagnoseAi') {
    if (message.apiKey) {
      await storeApiKey(context, message.apiKey, message.options && message.options.provider);
    }
    const models = await listAiModels(context, message.options || {});
    if (currentPanel) {
      currentPanel.webview.postMessage({
        type: 'aiDiagnosed',
        value: {
          provider: models.provider,
          baseUrl: models.baseUrl,
          count: models.models.length,
          sample: models.models.slice(0, 5),
          models: models.models
        }
      });
    }
    return;
  }

  if (message.type === 'exportMcpContext') {
    const result = await exportMcpContext(message);
    if (currentPanel) {
      currentPanel.webview.postMessage({ type: 'mcpContextExported', value: result });
    }
  }
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

async function exportMcpContext(message) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('Open a workspace folder before exporting MCP context.');
  }

  const root = folders[0].uri;
  const selection = message.contextSelection || {};
  const workspaceContext = hasAnyContextSelection(selection)
    ? await collectWorkspaceContext(selection)
    : { enabled: false, summary: '未选择工作区上下文。', labels: [] };
  const targetDir = vscode.Uri.joinPath(root, '.trae', 'prompt-optimizer');
  await vscode.workspace.fs.createDirectory(targetDir);

  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workspace: root.fsPath,
    source: 'Trae Prompt Optimizer',
    rawPrompt: String(message.raw || ''),
    optimizedPrompt: String(message.value || ''),
    options: message.options || {},
    contextSelection: selection,
    workspaceContext: {
      enabled: workspaceContext.enabled,
      labels: workspaceContext.labels || [],
      summary: workspaceContext.summary || ''
    },
    planSession: message.planState || null
  };

  const contextUri = vscode.Uri.joinPath(targetDir, 'context.json');
  const memoryUri = vscode.Uri.joinPath(targetDir, 'memory.md');
  const ignoreUri = vscode.Uri.joinPath(targetDir, '.gitignore');
  await vscode.workspace.fs.writeFile(ignoreUri, Buffer.from('*\n!.gitignore\n', 'utf8'));
  await vscode.workspace.fs.writeFile(contextUri, Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8'));

  const existingMemory = await readTextIfExists(memoryUri);
  const memoryEntry = buildMemoryEntry(snapshot);
  const memory = existingMemory
    ? `${existingMemory.trim()}\n\n${memoryEntry}`
    : `# Trae Prompt Optimizer Memory\n\n${memoryEntry}`;
  await vscode.workspace.fs.writeFile(memoryUri, Buffer.from(memory, 'utf8'));

  vscode.window.showInformationMessage(`Exported MCP context: ${contextUri.fsPath}`);
  return {
    contextPath: contextUri.fsPath,
    memoryPath: memoryUri.fsPath,
    labels: workspaceContext.labels || []
  };
}

async function readTextIfExists(uri) {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return '';
  }
}

function buildMemoryEntry(snapshot) {
  const finalText = snapshot.optimizedPrompt || '未生成优化结果';
  return [
    `## ${snapshot.generatedAt}`,
    '',
    '### Goal',
    truncateText(snapshot.rawPrompt || '未提供', 2000),
    '',
    '### Context Labels',
    (snapshot.workspaceContext.labels || []).length ? (snapshot.workspaceContext.labels || []).map(label => `- ${label}`).join('\n') : '- 未选择上下文',
    '',
    '### Latest Output',
    truncateText(finalText, 12000)
  ].join('\n');
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

  await storeApiKey(context, value);
  vscode.window.showInformationMessage('AI API key saved for Trae Prompt Optimizer.');
  return true;
}

async function storeApiKey(context, value, provider) {
  const apiKey = String(value || '').trim();
  if (!apiKey) {
    throw new Error('API Key cannot be empty.');
  }
  // Validate that the key does not contain illegal whitespace.
  if (/\s/.test(apiKey)) {
    throw new Error('API Key contains illegal whitespace.');
  }
  // Store under a provider‑specific secret name.
  const secretName = apiKeySecretName(provider || getAiConfig({}).provider);
  await context.secrets.store(secretName, apiKey);
}

async function getApiKey(context, provider) {
  // Provider‑specific secret name.
  const resolvedProvider = provider || getAiConfig({}).provider;
  const secretName = apiKeySecretName(resolvedProvider);
  let apiKey = await context.secrets.get(secretName);

  // Fallback to environment variable for headless usage.
  if (!apiKey) {
    const envVar = `TRAE_API_KEY_${String(resolvedProvider || '').toUpperCase()}`;
    apiKey = process.env[envVar];
  }

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

  apiKey = await context.secrets.get(secretName);
  if (!apiKey) {
    throw new Error('AI API key is not configured.');
  }

  return apiKey;
}

async function optimizeWithAi(context, message) {
  const aiConfig = getAiConfig(message.ai || {});
  const apiKey = await getApiKey(context, aiConfig.provider);

  const raw = message.raw || '';
  const current = message.value || '';
  const options = message.options || {};
  const mode = normalizeAiMode(message.ai && message.ai.mode);
  const systemPrompt = buildAiSystemPrompt(aiConfig.systemPrompt, mode);
  const userContent = mode === 'execution'
    ? buildExecutionAiUserContent(aiConfig, raw, current, options)
    : buildLandingAiUserContent(aiConfig, raw, current, options);

  const response = await postOpenAICompatible(getChatCompletionsEndpoint(aiConfig.baseUrl), apiKey, {
    model: aiConfig.model,
    temperature: mode === 'landing' ? 0.35 : 0.2,
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

function normalizeAiMode(value) {
  if (value === 'execution' || value === 'plan') {
    return value;
  }
  return 'landing';
}

function buildAiSystemPrompt(configuredPrompt, mode) {
  const modeInstruction = mode === 'execution'
    ? [
      'Mode: direct execution prompt.',
      'Rewrite the input into one complete prompt that a Trae coding agent can execute immediately.',
      'Keep the output concise enough to copy, but include role, context, task, constraints, acceptance criteria, verification, and final response format.'
    ].join('\n')
    : [
      'Mode: question-driven idea landing.',
      'The mode-specific instruction overrides older instructions that only ask you to polish an existing prompt.',
      'Your output must help a user turn a rough idea into something real.',
      'Start by asking 8-12 sharp clarifying questions. Each question should decide scope, user value, data, workflow, constraints, success criteria, or risk.',
      'After the questions, do not stop. Make explicit temporary assumptions and produce a first usable MVP plan under those assumptions.',
      'Then write detailed execution specs and one final prompt that can be pasted into Trae.',
      'Separate MVP from later versions and avoid expanding the project beyond the user goal.'
    ].join('\n');

  return [
    configuredPrompt || DEFAULT_AI_SYSTEM_PROMPT,
    modeInstruction,
    'Never expose API keys, tokens, credentials, private URLs, or secret values.'
  ].join('\n\n');
}

function buildAiMetadata(aiConfig, options) {
  return [
    `AI 提供商：${aiConfig.label}`,
    `模型：${aiConfig.model}`,
    `项目类型：${options.projectType || 'unknown'}`,
    `任务场景：${options.taskScenario || 'coding'}`,
    `执行强度：${options.rigor || 'balanced'}`,
    `输出语言：${options.language || 'zh'}`,
    `关注领域：${(options.focus || []).join(', ') || 'auto'}`
  ].join('\n');
}

function buildLandingAiUserContent(aiConfig, raw, current, options) {
  return [
    '请把下面的“简单目标/粗提示词”转成一个提问式落地稿。重点不是润色，而是把想法推到可执行。',
    '',
    '你必须按 Markdown 输出，并严格包含这些一级/二级结构：',
    '1. 标题：# 想法落地问答',
    '2. ## 1. 我先要问你的关键问题',
    '   - 8-12 个问题，按「目标与用户 / 范围与边界 / 数据与接口 / UI 与流程 / 验收与风险」分组。',
    '   - 每个问题后用一句短话说明：这个答案会决定什么。',
    '3. ## 2. 在你没回答前，我先做的合理假设',
    '   - 不虚构事实；只写为了继续推进 MVP 所需的最小假设。',
    '4. ## 3. MVP 落地方案',
    '   - 写清楚先做什么、不做什么、用户主流程、交付物。',
    '5. ## 4. 详细执行规格',
    '   - 包含背景、目标用户、目标、用户流程、功能需求、非功能需求、数据/API/UI 要求、约束、验收标准、验证计划、风险与回滚。',
    '   - 如果任务是论坛/汇报/PRD/分析等非代码场景，要把结构改成对应交付物，而不是硬写代码模块。',
    '6. ## 5. 可以直接交给 Trae 的执行 Prompt',
    '   - 写成一段自包含 Prompt，让 Trae 先读上下文，再按 MVP 实施或产出文档。',
    '   - 对阻塞问题要求先提问；非阻塞问题按上面的临时假设继续推进。',
    '7. ## 6. 给用户的回答模板',
    '   - 提供一个简短表格或列表，方便用户按问题补充答案。',
    '',
    '输出要求：',
    '- 保留用户真实目标，不要扩成无关产品。',
    '- 要比本地规则生成稿更具体、更可执行。',
    '- 不要只改措辞，不要只重复本地生成稿。',
    '- 不要包含任何 API Key、token 或敏感信息。',
    '- 输出语言遵循用户选择；中文优先使用清晰中文标题。',
    '',
    buildAiMetadata(aiConfig, options),
    '',
    '原始简单目标/粗提示词：',
    raw || '未提供',
    '',
    '本地规则生成稿：',
    current || '未提供'
  ].join('\n');
}

function buildExecutionAiUserContent(aiConfig, raw, current, options) {
  return [
    '请把下面的粗提示词和本地规则生成稿，进一步优化成适合 Trae 编程代理执行的高质量提示词。',
    '要求：',
    '- 只返回最终 Markdown 提示词，不要解释过程。',
    '- 保留用户真实目标，不要扩写成无关产品。',
    '- 明确角色、项目上下文、任务、约束、验收标准、验证命令和最终回复格式。',
    '- 如果缺少关键上下文，写出最小安全假设；如果问题会阻塞执行，要求 Trae 先提问。',
    '- 如果是 Harness/DevOps 平台方向，要强调 Go 后端、React/TypeScript 前端、OpenAPI、权限、安全、测试和小步修改。',
    '- 不要包含任何 API Key、token 或敏感信息。',
    '',
    buildAiMetadata(aiConfig, options),
    '',
    '原始提示词：',
    raw || '未提供',
    '',
    '本地规则生成稿：',
    current || '未提供'
  ].join('\n');
}

async function startPlanSession(context, message) {
  const options = message.options || {};
  const workspaceContext = message.includeWorkspaceContext || hasAnyContextSelection(message.contextSelection)
    ? await collectWorkspaceContext(message.contextSelection || {})
    : { enabled: false, summary: '未读取工作区上下文。', labels: [] };

  currentPlanSession = {
    id: `plan-${Date.now()}`,
    goal: message.raw || '',
    draft: message.value || '',
    options,
    ai: message.ai || {},
    workspaceContext,
    turns: []
  };

  return runPlanAi(context, currentPlanSession, 'start', '');
}

async function continuePlanSession(context, message) {
  const answer = String(message.answer || '').trim();
  if (!answer) {
    throw new Error('Plan answer cannot be empty.');
  }

  const session = ensurePlanSession(message.session);
  session.turns.push({ role: 'user', content: answer });
  currentPlanSession = session;
  return runPlanAi(context, session, 'answer', answer);
}

async function finalizePlanSession(context, message) {
  const session = ensurePlanSession(message.session);
  currentPlanSession = session;
  return runPlanAi(context, session, 'finalize', '');
}

function ensurePlanSession(fallbackSession) {
  if (currentPlanSession && (!fallbackSession || fallbackSession.id === currentPlanSession.id)) {
    return currentPlanSession;
  }

  if (fallbackSession && fallbackSession.id) {
    return {
      id: fallbackSession.id,
      goal: fallbackSession.goal || '',
      draft: fallbackSession.draft || '',
      options: fallbackSession.options || {},
      ai: fallbackSession.ai || {},
      workspaceContext: fallbackSession.workspaceContext || { enabled: false, summary: '会话恢复后未携带工作区上下文。', labels: [] },
      turns: Array.isArray(fallbackSession.turns) ? fallbackSession.turns : []
    };
  }

  throw new Error('Plan session is not available. Start a new plan first.');
}

async function runPlanAi(context, session, action, latestAnswer) {
  const aiConfig = getAiConfig({ ...(session.options.ai || {}), ...(session.ai || {}) });
  const apiKey = await getApiKey(context, aiConfig.provider);
  const response = await postOpenAICompatible(getChatCompletionsEndpoint(aiConfig.baseUrl), apiKey, {
    model: aiConfig.model,
    temperature: action === 'finalize' ? 0.2 : 0.25,
    messages: [
      { role: 'system', content: buildPlanSystemPrompt(aiConfig.systemPrompt) },
      { role: 'user', content: buildPlanUserContent(aiConfig, session, action, latestAnswer) }
    ]
  });

  const content = response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '';

  if (!content || !content.trim()) {
    throw new Error('Plan Mode returned an empty response.');
  }

  const parsed = parsePlanResponse(content, action);
  const assistantTurn = {
    role: 'assistant',
    stage: parsed.stage,
    status: parsed.status,
    diagnosis: parsed.diagnosis,
    questions: parsed.questions,
    draftPlan: parsed.draftPlan,
    finalPlan: parsed.finalPlan,
    raw: content.trim()
  };
  session.turns.push(assistantTurn);

  return {
    session: serializePlanSession(session),
    stage: parsed.stage,
    status: parsed.status,
    diagnosis: parsed.diagnosis,
    questions: parsed.questions,
    draftPlan: parsed.draftPlan,
    finalPlan: parsed.finalPlan,
    workspaceContext: {
      enabled: session.workspaceContext.enabled,
      labels: session.workspaceContext.labels || []
    }
  };
}

function serializePlanSession(session) {
  return {
    id: session.id,
    goal: session.goal,
    draft: session.draft,
    options: session.options,
    ai: session.ai || {},
    workspaceContext: {
      enabled: session.workspaceContext.enabled,
      summary: session.workspaceContext.enabled ? '工作区上下文已由扩展宿主保留，localStorage 只保存摘要标记。' : session.workspaceContext.summary,
      labels: session.workspaceContext.labels || []
    },
    turns: session.turns
  };
}

function buildPlanSystemPrompt(configuredPrompt) {
  return [
    configuredPrompt || DEFAULT_AI_SYSTEM_PROMPT,
    '',
    'You are running a Codex-like Plan Mode for a Trae prompt optimizer extension.',
    'Your job is not to implement. Your job is to plan by conversation.',
    'Use three phases:',
    'Phase 1: diagnose the user goal, available context, missing details, and high-impact ambiguities.',
    `Phase 2: ask only material questions, ${PLAN_QUESTION_MIN}-${PLAN_QUESTION_MAX} per round, that change scope, interfaces, constraints, acceptance, or testing.`,
    'Phase 3: when enough information exists, produce a decision-complete implementation plan.',
    '',
    'Return strict JSON only. Do not wrap it in markdown fences.',
    'JSON shape:',
    '{',
    '  "stage": "waiting_answer" | "ready_to_finalize" | "final_plan",',
    '  "status": "诊断中" | "等待回答" | "继续追问" | "生成最终计划",',
    '  "diagnosis": "short markdown summary",',
    '  "questions": ["question 1", "question 2"],',
    '  "draftPlan": "short markdown draft or empty string",',
    '  "finalPlan": "markdown containing <proposed_plan>...</proposed_plan> only when stage is final_plan"',
    '}',
    '',
    'Rules:',
    '- Do not ask questions that can be answered from provided workspace context.',
    '- Do not ask vague questions like "anything else?".',
    '- If a question is blocking, make it specific and explain the decision it controls.',
    '- For start/answer actions, prefer questions over finalizing unless the intent is already decision-complete.',
    '- For finalize actions, always return stage "final_plan" and finalPlan with exactly one <proposed_plan> block.',
    '- The final plan must include Title, Summary, Key Changes, Test Plan, and Assumptions.',
    '- Do not end the final plan with "should I proceed?".',
    '- Never include API keys, tokens, credentials, private URLs, or secret values.'
  ].join('\n');
}

function buildPlanUserContent(aiConfig, session, action, latestAnswer) {
  const transcript = session.turns.map((turn, index) => {
    if (turn.role === 'user') {
      return `Turn ${index + 1} User Answer:\n${turn.content}`;
    }
    return [
      `Turn ${index + 1} Assistant:`,
      `Stage: ${turn.stage || 'unknown'}`,
      `Diagnosis: ${turn.diagnosis || ''}`,
      `Questions: ${(turn.questions || []).join(' | ')}`,
      `Draft Plan: ${turn.draftPlan || ''}`
    ].join('\n');
  }).join('\n\n');

  return [
    `Action: ${action}`,
    action === 'start'
      ? 'Start a new plan session. Diagnose first and ask the first 5-8 material questions. Do not output the final plan yet.'
      : action === 'answer'
        ? 'Continue the plan session using the latest user answer. Ask another 5-8 material questions if important ambiguity remains; otherwise mark ready_to_finalize with a compact draft plan.'
        : 'Finalize the plan now. Output a decision-complete plan in finalPlan with a <proposed_plan> block.',
    '',
    buildAiMetadata(aiConfig, session.options || {}),
    '',
    'User goal / raw prompt:',
    session.goal || '未提供',
    '',
    'Local generated draft:',
    session.draft || '未提供',
    '',
    'Optional workspace context:',
    session.workspaceContext && session.workspaceContext.summary ? session.workspaceContext.summary : '未读取工作区上下文。',
    '',
    'Conversation transcript:',
    transcript || 'No prior turns.',
    '',
    'Latest answer:',
    latestAnswer || 'None'
  ].join('\n');
}

function parsePlanResponse(content, action) {
  const trimmed = content.trim();
  let data;

  try {
    data = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        data = JSON.parse(match[0]);
      } catch {
        data = undefined;
      }
    }
  }

  if (!data || typeof data !== 'object') {
    const questions = extractQuestions(trimmed).slice(0, PLAN_QUESTION_MAX);
    if (action === 'finalize') {
      return {
        stage: 'final_plan',
        status: '生成最终计划',
        diagnosis: '模型返回了非 JSON 内容，已保留为最终计划。',
        questions: [],
        draftPlan: '',
        finalPlan: ensureProposedPlan(trimmed)
      };
    }
    return {
      stage: 'waiting_answer',
      status: '等待回答',
      diagnosis: '模型返回了非 JSON 内容，已提取可用问题；原文保留在草稿区。',
      questions,
      draftPlan: trimmed,
      finalPlan: ''
    };
  }

  const stage = data.stage === 'final_plan'
    ? 'final_plan'
    : data.stage === 'ready_to_finalize'
      ? 'ready_to_finalize'
      : 'waiting_answer';
  const finalPlan = stage === 'final_plan' || action === 'finalize'
    ? ensureProposedPlan(String(data.finalPlan || data.draftPlan || trimmed))
    : '';

  return {
    stage: action === 'finalize' ? 'final_plan' : stage,
    status: data.status || (stage === 'final_plan' ? '生成最终计划' : stage === 'ready_to_finalize' ? '生成最终计划' : '等待回答'),
    diagnosis: String(data.diagnosis || ''),
    questions: Array.isArray(data.questions) ? data.questions.map(item => String(item)).slice(0, PLAN_QUESTION_MAX) : [],
    draftPlan: String(data.draftPlan || ''),
    finalPlan
  };
}

function extractQuestions(content) {
  return content
    .split(/\r?\n/)
    .map(line => line.replace(/^[-*\d.、\s]+/, '').trim())
    .filter(line => line.includes('?') || line.includes('？'));
}

function ensureProposedPlan(value) {
  const text = String(value || '').trim();
  if (/<proposed_plan>[\s\S]*<\/proposed_plan>/.test(text)) {
    return text;
  }

  return [
    '<proposed_plan>',
    text || '# 执行计划\n\n## Summary\n\n信息不足，未生成有效计划。\n\n## Key Changes\n\n- 重新启动计划模式并补充目标。\n\n## Test Plan\n\n- 暂无。\n\n## Assumptions\n\n- 暂无。',
    '</proposed_plan>'
  ].join('\n');
}

function hasAnyContextSelection(selection) {
  if (!selection || typeof selection !== 'object') {
    return false;
  }
  return Boolean(selection.structure || selection.readme || selection.packageJson || selection.activeEditor);
}

async function collectWorkspaceContext(selection) {
  const picks = {
    structure: Boolean(selection && selection.structure),
    readme: Boolean(selection && selection.readme),
    packageJson: Boolean(selection && selection.packageJson),
    activeEditor: Boolean(selection && selection.activeEditor)
  };
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) {
    return { enabled: true, summary: '未打开工作区，无法读取项目上下文。', labels: [] };
  }

  const root = folders[0].uri;
  const sections = [];
  const labels = [];
  let total = 0;

  const addSection = (label, content) => {
    if (!content || total >= PLAN_CONTEXT_TOTAL_LIMIT) {
      return;
    }
    const remaining = PLAN_CONTEXT_TOTAL_LIMIT - total;
    const clipped = truncateText(String(content), Math.min(PLAN_CONTEXT_FILE_LIMIT, remaining));
    if (!clipped.trim()) {
      return;
    }
    sections.push(`## ${label}\n${clipped}`);
    labels.push(label);
    total += clipped.length;
  };

  const entries = picks.structure ? await safeReadDirectory(root) : [];
  if (picks.structure && entries.length) {
    const visible = entries
      .map(([name, type]) => ({ name, type }))
      .filter(item => !isBlockedContextName(item.name))
      .slice(0, 80)
      .map(item => `${item.type === vscode.FileType.Directory ? 'dir ' : 'file'} ${item.name}`)
      .join('\n');
    addSection('Top-level workspace structure', visible);
  }

  if (picks.readme) {
    await addWorkspaceFile(root, 'README.md', addSection);
  }
  if (picks.packageJson) {
    await addWorkspaceFile(root, 'package.json', addSection);
  }

  const editor = vscode.window.activeTextEditor;
  if (picks.activeEditor && editor && editor.document && !editor.document.isUntitled) {
    const fileName = editor.document.uri.fsPath || editor.document.fileName || 'active file';
    if (!isBlockedContextName(fileName)) {
      const selected = editor.selection && !editor.selection.isEmpty
        ? editor.document.getText(editor.selection)
        : editor.document.getText();
      addSection(`Active editor: ${fileName}`, selected);
    }
  }

  return {
    enabled: true,
    summary: sections.join('\n\n') || '工作区未发现可安全读取的轻量上下文。',
    labels
  };
}

async function addWorkspaceFile(root, name, addSection) {
  if (isBlockedContextName(name)) {
    return;
  }
  const uri = vscode.Uri.joinPath(root, name);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8');
    addSection(name, text);
  } catch {
    // Optional context file is absent or unreadable.
  }
}

async function safeReadDirectory(uri) {
  try {
    return await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return [];
  }
}

function isBlockedContextName(value) {
  const normalized = String(value || '').replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  return parts.some(part => {
    if (['.git', 'node_modules', 'dist', 'out', 'build', '.cache', '.next', 'coverage'].includes(part)) {
      return true;
    }
    if (part.startsWith('.env')) {
      return true;
    }
    return /(secret|token|credential|password|apikey|api-key|private-key|\.pem$|\.key$)/.test(part);
  });
}

function truncateText(value, limit) {
  const text = String(value || '');
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n\n[truncated at ${limit} characters]`;
}

async function listAiModels(context, options) {
  const aiConfig = getAiConfig(options || {});
  const apiKey = await getApiKey(context, aiConfig.provider);
  const response = await getOpenAICompatible(getModelsEndpoint(aiConfig.baseUrl), apiKey);
  const data = Array.isArray(response.data) ? response.data : [];
  const models = data
    .map(item => item && item.id)
    .filter(Boolean)
    .sort();

  if (!models.length) {
    throw new Error('No models were returned by the API.');
  }

  return {
    provider: aiConfig.provider,
    baseUrl: aiConfig.baseUrl,
    models
  };
}

async function testAiConnection(context, options) {
  const result = await listAiModels(context, options);
  return {
    provider: result.provider,
    baseUrl: result.baseUrl,
    count: result.models.length,
    sample: result.models.slice(0, 5)
  };
}

function friendlyAiError(message, options) {
  const text = String(message || '');
  const provider = options && options.provider ? options.provider : '';
  const base = [
    text,
    '',
    '排查建议：'
  ];
  const lower = text.toLowerCase();

  if (lower.includes('does not exist') || lower.includes('do not have access') || lower.includes('model')) {
    base.push('- 模型 ID 可能填错，或当前 API Key 没有这个模型权限。先点“获取模型”，以返回列表里的模型 id 为准。');
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('api key')) {
    base.push('- API Key 可能无效、过期，或不是当前提供商的 Key。');
  }
  if (lower.includes('404') || lower.includes('not found') || lower.includes('endpoint')) {
    base.push('- Base URL 可能填错。Base URL 只填到 /v1 或提供商兼容路径，不要手动加 /chat/completions。');
  }
  if (lower.includes('non-json') || lower.includes('timeout') || lower.includes('enotfound') || lower.includes('econn') || lower.includes('network')) {
    base.push('- 网络、代理或 Base URL 可能不可达；可以先用“一键诊断”确认。');
    base.push('- 请求可能被本地防火墙或公司代理拦截，请检查代理设置或使用直连网络。');
  }
  if (provider === 'doubao' || provider === 'doubaoCoding') {
    base.push('- 豆包/火山常见问题：控制台展示名不一定是 API 模型 id；Coding Plan 常用 Base URL 是 https://ark.cn-beijing.volces.com/api/coding/v3。');
  }
  if (base.length === 3) {
    base.push('- 请检查 API Key、Base URL 和模型 id 是否匹配同一家提供商。');
  }

  return base.join('\n');
}

function postOpenAICompatible(endpoint, apiKey, payload) {
  return new Promise((resolve, reject) => {
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
          'Accept': 'application/json',
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
          } catch (e) {
            const preview = text ? (text.length > 200 ? text.slice(0, 200) + '...' : text) : 'Empty response';
            reject(new Error(`AI API returned non-JSON response (Status ${response.statusCode}). Body: ${preview}`));
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
    request.on('error', err => {
      console.error('AI API Request Error:', err);
      const code = err.code ? ` (${err.code})` : '';
      reject(new Error(`网络请求失败${code}: ${err.message || '未知错误'}. 请检查 Base URL 是否正确、网络连接或代理设置。`));
    });
    request.write(body);
    request.end();
  });
}

function getOpenAICompatible(endpoint, apiKey) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const transport = url.protocol === 'http:' ? http : https;
    const request = transport.request(
      {
        method: 'GET',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json'
        },
        timeout: 30000
      },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;

          try {
            json = text ? JSON.parse(text) : {};
          } catch (e) {
            const preview = text ? (text.length > 200 ? text.slice(0, 200) + '...' : text) : 'Empty response';
            const err = new Error(`AI API returned non-JSON response (Status ${response.statusCode}). Body: ${preview}`);
            err.original = e; // preserve original stack for debugging
            reject(err);
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
    request.end();
  });
}

function normalizeBaseUrl(baseUrl) {
  let urlPart = String(baseUrl || '').trim();
  if (!urlPart) {
    throw new Error('AI base URL is not configured.');
  }

  let queryPart = '';
  if (urlPart.includes('?')) {
    const parts = urlPart.split('?');
    urlPart = parts[0];
    queryPart = parts.slice(1).join('?');
  }

  urlPart = urlPart.replace(/\/+$/, '');

  if (urlPart.endsWith('/chat/completions')) {
    urlPart = urlPart.slice(0, -'/chat/completions'.length);
  } else if (urlPart.endsWith('/models')) {
    urlPart = urlPart.slice(0, -'/models'.length);
  }

  urlPart = urlPart.replace(/\/+$/, '');
  return queryPart ? `${urlPart}?${queryPart}` : urlPart;
}

function getChatCompletionsEndpoint(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith('/chat/completions')) {
    return normalized; // already includes the suffix
  }
  if (normalized.includes('?')) {
    const [base, query] = normalized.split('?');
    return `${base}/chat/completions?${query}`;
  }
  return `${normalized}/chat/completions`;
}

function getModelsEndpoint(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith('/models')) {
    return normalized; // already includes the suffix
  }
  if (normalized.includes('?')) {
    const [base, query] = normalized.split('?');
    return `${base}/models?${query}`;
  }
  return `${normalized}/models`;
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
  const cspSource = webview && webview.cspSource ? webview.cspSource : 'vscode-resource:';
  const escapedInitial = escapeHtml(initialPrompt || '');
  const initialPromptJson = JSON.stringify(initialPrompt || '').replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
      --shadow: 0 18px 50px rgba(38, 43, 44, 0.08);
      --radius: 8px;
      color-scheme: light;
    }

    * { box-sizing: border-box; }

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

    button, select, textarea { font: inherit; }

    .shell { min-height: 100vh; padding: 12px; }

    .topbar {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
      margin-bottom: 12px;
    }

    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }

    .mark {
      width: 36px;
      height: 36px;
      display: grid;
      place-items: center;
      border-radius: var(--radius);
      background: var(--ink);
      color: #fffdf8;
      font-weight: 800;
      line-height: 1;
    }

    h1 { margin: 0; font-size: 16px; line-height: 1.2; }
    .subtitle { margin: 2px 0 0; color: var(--muted); font-size: 11px; }

    .top-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-start;
    }

    .workspace {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr));
      gap: 14px;
      min-height: calc(100vh - 150px);
    }

    .panel {
      display: flex;
      min-width: 0;
      /* min-height removed for responsive design */
      flex-direction: column;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(255, 253, 248, 0.96);
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

    .meta { color: var(--muted); font-size: 12px; white-space: nowrap; }

    .controls {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }

    label, .label {
      display: block;
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
    }

    select {
      width: 100%;
      height: 34px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      color: var(--ink);
      background: #fff;
      outline: none;
    }

    select:focus, textarea:focus {
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

    .chip input { accent-color: var(--teal); }

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
      display: flex;
      flex-direction: column;
      min-height: 0;
      flex: 1;
    }

    .scorebar {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px 12px;
      align-items: start;
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
      padding-top: 1px;
    }

    .score-title {
      margin: 0 0 4px;
      font-size: 13px;
      font-weight: 800;
      line-height: 1.35;
      word-break: normal;
      overflow-wrap: anywhere;
    }

    .score-reason {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
      word-break: normal;
      overflow-wrap: anywhere;
    }

    .diagnosis {
      display: grid;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 253, 248, 0.74);
    }

    .diagnosis-title {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
    }

    .diag-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .diag-item {
      padding: 4px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
    }

    .diag-item.ok {
      border-color: rgba(15, 118, 110, 0.28);
      background: rgba(15, 118, 110, 0.09);
      color: var(--teal-dark);
    }

    .diag-item.missing {
      border-color: rgba(185, 121, 18, 0.34);
      background: rgba(185, 121, 18, 0.10);
      color: #7b4c06;
    }

    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      grid-column: 1 / -1;
      min-width: 0;
      padding-left: 60px;
      justify-content: flex-start;
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
      min-height: 28px;
      padding: 4px 8px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      cursor: pointer;
      font-size: 11px;
      font-weight: 700;
    }

    .btn:hover { border-color: rgba(15, 118, 110, 0.55); color: var(--teal-dark); }
    .btn.primary { border-color: var(--teal); background: var(--teal); color: #fff; }
    .btn.primary:hover { border-color: var(--teal-dark); background: var(--teal-dark); color: #fff; }
    .btn.warn { border-color: rgba(185, 121, 18, 0.48); color: #7b4c06; }
    .btn:disabled { cursor: wait; opacity: 0.7; }

    .ai-settings {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 8px;
      padding: 12px 14px;
      border-top: 1px solid var(--line);
      background: rgba(240, 237, 229, 0.45);
    }

    .ai-settings input {
      width: 100%;
      height: 34px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      color: var(--ink);
      background: #fff;
      outline: none;
    }

    .ai-settings input:focus {
      border-color: rgba(15, 118, 110, 0.65);
      box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.12);
    }

    .status-line {
      padding: 8px 14px 12px;
      border-bottom: 1px solid var(--line);
      background: rgba(240, 237, 229, 0.45);
      color: var(--muted);
      font-size: 12px;
    }

    .status-line strong { color: var(--ink); }

    .fold {
      min-width: 0;
      margin-bottom: 12px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(255, 253, 248, 0.94);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .fold > summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 42px;
      padding: 9px 12px;
      cursor: pointer;
      user-select: none;
      list-style: none;
      background: rgba(240, 237, 229, 0.72);
    }

    .fold > summary::-webkit-details-marker { display: none; }

    .fold > summary::before {
      content: '›';
      display: grid;
      place-items: center;
      width: 18px;
      height: 18px;
      flex: 0 0 auto;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--teal-dark);
      font-weight: 900;
      transition: transform 140ms ease;
    }

    .fold[open] > summary::before { transform: rotate(90deg); }

    .fold-summary-main {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: max-content;
      margin-right: auto;
      font-size: 13px;
      font-weight: 800;
      line-height: 1.25;
      white-space: nowrap;
    }

    .fold-summary-note {
      min-width: 0;
      max-width: 54%;
      overflow: hidden;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      text-align: right;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .panel .fold {
      margin: 0;
      border-width: 0 0 1px;
      border-radius: 0;
      box-shadow: none;
    }

    .panel .fold > summary { min-height: 40px; }

    .panel .fold:last-of-type { border-bottom: 1px solid var(--line); }

    .fold .controls, .fold .chips, .fold .diagnosis { border-bottom: 0; }

    .history-actions {
      display: flex;
      justify-content: flex-end;
      padding: 10px 10px 0;
    }

    .is-hidden { display: none !important; }

    .plan-panel {
      margin-bottom: 14px;
    }

    .plan-body {
      display: grid;
      gap: 10px;
      min-width: 0;
      padding: 12px 14px;
    }

    .plan-toolbar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
      gap: 6px;
    }
    .plan-toolbar .btn {
      width: 100%;
      min-width: 0;
    }

    .plan-status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 28px;
      padding: 5px 9px;
      border: 1px solid rgba(15, 118, 110, 0.25);
      border-radius: 999px;
      background: rgba(15, 118, 110, 0.09);
      color: var(--teal-dark);
      font-size: 12px;
      font-weight: 800;
    }

    .plan-context-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      margin: 0;
      color: var(--ink);
      font-size: 12px;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .plan-context-toggle input { accent-color: var(--teal); }

    .context-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
      gap: 6px;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(240, 237, 229, 0.42);
    }

    .plan-diagnosis {
      min-height: 34px;
      padding: 9px 10px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #fff;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .plan-question-list {
      display: grid;
      gap: 8px;
    }

    .plan-question {
      display: grid;
      gap: 7px;
      min-width: 0;
      padding: 9px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #fff;
    }

    .plan-question-head {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }

    .plan-question strong {
      flex: 1 1 180px;
      min-width: 0;
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .plan-question-state {
      width: 96px;
      max-width: 100%;
      height: 30px;
      font-size: 12px;
    }

    .plan-question textarea, .plan-answer-box {
      width: 100%;
      min-height: 60px;
      padding: 9px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #fffdf8;
      color: var(--ink);
      resize: vertical;
      font-family: inherit;
      font-size: 12px;
      line-height: 1.5;
    }

    .plan-answer-box { min-height: 82px; }

    .plan-context-labels {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }

    .plan-context-labels .pill {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .mcp-note {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
      overflow-wrap: anywhere;
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

    .toast.show { transform: translateY(0); opacity: 1; }

    @media (max-width: 980px) {
      .topbar, .workspace { grid-template-columns: 1fr; }
      .top-actions { justify-content: flex-start; }
      .controls { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
      .ai-settings { grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); }
      .history-list { grid-template-columns: 1fr; }
      .brand .subtitle { display: none; }
    }

    @media (max-width: 560px) {
      .shell { padding: 8px; }
      .brand h1 { font-size: 14px; }
      .brand .mark { display: none; }
      .top-actions .btn { flex: 1 1 calc(50% - 6px); text-align: center; justify-content: center; }
      .fold-summary-note { display: none; }
      .fold-summary-main { min-width: 0; }
      .plan-status { grid-column: 1 / -1; }
      .context-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .scorebar { grid-template-columns: 1fr; }
      .score { width: 36px; height: 36px; font-size: 14px; }
      .pill-row { padding-left: 0; }
      .plan-toolbar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .plan-body { padding: 10px; }
      .plan-question-state { width: 100%; }
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
        <button class="btn warn" id="aiBtn">AI 提问式优化</button>
        <button class="btn" id="sendTraeBtn">发送到 Trae</button>
        <button class="btn warn" id="saveRuleBtn">保存为 Trae Rule</button>
        <button class="btn" id="exportBtn">导出 Markdown</button>
        <button class="btn" id="insertBtn">插入编辑器</button>
        <button class="btn primary" id="copyBtn">复制结果</button>
      </div>
    </header>

    <details class="fold">
      <summary>
        <span class="fold-summary-main"><span class="dot"></span>AI 配置</span>
        <span class="fold-summary-note">Key、模型与预设</span>
      </summary>
      <section class="ai-settings" aria-label="AI settings">
        <div>
          <label for="aiProvider">AI 提供商</label>
          <select id="aiProvider">
            <option value="openai">OpenAI 兼容</option>
            <option value="nvidia">NVIDIA</option>
            <option value="deepseek">DeepSeek</option>
            <option value="gemini">Gemini</option>
            <option value="kimi">Kimi</option>
            <option value="groq">Groq</option>
            <option value="openrouter">OpenRouter</option>
            <option value="doubao">豆包 / 火山方舟</option>
            <option value="doubaoCoding">豆包 Coding Plan</option>
            <option value="custom">自定义</option>
          </select>
        </div>
        <div>
          <label for="aiMode">AI 优化模式</label>
          <select id="aiMode">
            <option value="plan">计划模式</option>
            <option value="landing">提问式落地</option>
            <option value="execution">直接执行 Prompt</option>
          </select>
        </div>
        <div>
          <label for="aiBaseUrl">Base URL</label>
          <input id="aiBaseUrl" type="text" value="https://api.openai.com/v1">
        </div>
        <div>
          <label for="aiModel">模型</label>
          <input id="aiModel" type="text" list="aiModelList" value="gpt-4o-mini">
          <datalist id="aiModelList"></datalist>
        </div>
        <div>
          <label for="apiKeyInput">API Key</label>
          <input id="apiKeyInput" type="password" placeholder="粘贴后点保存">
        </div>
        <div>
          <label>&nbsp;</label>
          <button class="btn" id="saveApiKeyBtn">保存 Key</button>
        </div>
        <div>
          <label>&nbsp;</label>
          <button class="btn" id="listModelsBtn">获取模型</button>
        </div>
        <div>
          <label>&nbsp;</label>
          <button class="btn" id="diagnoseAiBtn">一键诊断</button>
        </div>
      </section>
      <div class="status-line" id="aiStatus">AI 状态：<strong>未检查</strong>。默认计划模式会多轮追问，再生成 proposed_plan。</div>
    </details>

    <details class="fold plan-panel" id="planPanel">
      <summary>
        <span class="fold-summary-main"><span class="dot"></span>计划模式</span>
        <span class="fold-summary-note">多轮对话细化方案</span>
      </summary>
      <div class="plan-body">
        <div class="plan-toolbar">
          <span class="plan-status" id="planStage">未开始</span>
          <button class="btn warn" id="planStartBtn">开始计划</button>
          <button class="btn" id="planAnswerBtn">提交回答</button>
          <button class="btn primary" id="planFinalizeBtn">生成最终计划</button>
          <button class="btn" id="mcpExportBtn">导出 MCP 上下文</button>
          <button class="btn" id="planResetBtn">重新开始</button>
        </div>
        <div class="context-grid" aria-label="Workspace context selection">
          <label class="plan-context-toggle"><input class="plan-context-option" type="checkbox" value="structure">目录结构</label>
          <label class="plan-context-toggle"><input class="plan-context-option" type="checkbox" value="readme">README</label>
          <label class="plan-context-toggle"><input class="plan-context-option" type="checkbox" value="packageJson">package.json</label>
          <label class="plan-context-toggle"><input class="plan-context-option" type="checkbox" value="activeEditor">当前编辑器</label>
        </div>
        <div class="plan-context-labels" id="planContextLabels"></div>
        <div class="mcp-note" id="mcpNote">MCP 上下文会保存到当前工作区 .trae/prompt-optimizer/context.json 和 memory.md。</div>
        <div class="plan-diagnosis" id="planDiagnosis">选择 AI 优化模式为“计划模式”后，输入一个目标并点击“开始计划”。</div>
        <div class="plan-question-list" id="planQuestions"></div>
        <textarea class="plan-answer-box" id="planAnswer" placeholder="也可以在这里整体粘贴回答、补充约束、贴背景。逐条问题的回答会和这里的内容一起发送。"></textarea>
      </div>
    </details>

    <section class="workspace">
      <article class="panel">
        <div class="panel-head">
          <div class="panel-title"><span class="dot"></span>原始提示词</div>
          <div class="meta"><span id="inputCount">0</span> 字</div>
        </div>
        <details class="fold">
          <summary>
            <span class="fold-summary-main"><span class="dot"></span>任务设置</span>
            <span class="fold-summary-note">项目、场景、强度与领域</span>
          </summary>
          <div class="controls">
            <div>
              <label for="projectType">项目类型</label>
              <select id="projectType">
                <option value="harness">Harness / DevOps 平台</option>
                <option value="fullstack">全栈产品</option>
                <option value="backend">Go 后端服务</option>
                <option value="frontend">前端应用</option>
                <option value="generic">通用代码任务</option>
              </select>
            </div>
            <div>
              <label for="rigor">执行强度</label>
              <select id="rigor">
                <option value="balanced">平衡：实现 + 验证</option>
                <option value="strict">严格：权限/测试/迁移优先</option>
                <option value="fast">快速：小改动优先</option>
              </select>
            </div>
            <div>
              <label for="language">输出语言</label>
              <select id="language">
                <option value="zh">中文</option>
                <option value="mixed">中文 + 英文术语</option>
                <option value="en">English</option>
              </select>
            </div>
            <div>
              <label for="taskScenario">任务场景</label>
              <select id="taskScenario">
                <option value="coding">AI 编程通用</option>
                <option value="bugfix">Bug 修复</option>
                <option value="feature">新功能开发</option>
                <option value="frontend-ui">前端界面</option>
                <option value="api-design">API / 后端设计</option>
                <option value="refactor">代码重构</option>
                <option value="prd">PRD / 产品文档</option>
                <option value="analysis">数据/业务分析</option>
                <option value="forum">论坛发帖</option>
                <option value="manager">老板汇报</option>
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
        </details>
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
          <details class="fold">
            <summary>
            <span class="fold-summary-main"><span class="dot"></span>诊断详情</span>
            <span class="fold-summary-note">缺失项与关注依据</span>
            </summary>
            <div class="diagnosis">
              <div class="diagnosis-title" id="diagnosisTitle">第一性原理诊断：把想法变成可执行任务规格</div>
              <div class="diag-grid" id="diagnosisGrid"></div>
            </div>
          </details>
          <textarea id="optimizedPrompt" readonly></textarea>
        </div>
      </article>
    </section>

    <details class="fold history">
      <summary>
        <span class="fold-summary-main"><span class="dot"></span>最近优化</span>
        <span class="fold-summary-note">展开查看历史记录</span>
      </summary>
      <div class="history-actions">
        <button class="btn" id="clearHistoryBtn">清空历史</button>
      </div>
      <div class="history-list" id="historyList"></div>
    </details>
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
    const taskScenario = document.getElementById('taskScenario');
    const aiProvider = document.getElementById('aiProvider');
    const aiMode = document.getElementById('aiMode');
    const aiBaseUrl = document.getElementById('aiBaseUrl');
    const aiModel = document.getElementById('aiModel');
    const aiModelList = document.getElementById('aiModelList');
    const apiKeyInput = document.getElementById('apiKeyInput');
    const aiStatus = document.getElementById('aiStatus');
    const inputCount = document.getElementById('inputCount');
    const score = document.getElementById('score');
    const scoreTitle = document.getElementById('scoreTitle');
    const scoreReason = document.getElementById('scoreReason');
    const diagnosisGrid = document.getElementById('diagnosisGrid');
    const pillRow = document.getElementById('pillRow');
    const historyList = document.getElementById('historyList');
    const planPanel = document.getElementById('planPanel');
    const planStage = document.getElementById('planStage');
    const planDiagnosis = document.getElementById('planDiagnosis');
    const planQuestions = document.getElementById('planQuestions');
    const planAnswer = document.getElementById('planAnswer');
    const planContextLabels = document.getElementById('planContextLabels');
    const mcpNote = document.getElementById('mcpNote');
    const toast = document.getElementById('toast');

    let planState = {
      session: null,
      stage: 'idle',
      status: '未开始',
      diagnosis: '选择 AI 优化模式为“计划模式”后，输入一个目标并点击“开始计划”。',
      questions: [],
      questionCards: [],
      draftPlan: '',
      finalPlan: '',
      workspaceContext: null
    };

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

    const taskScenarios = {
      coding: {
        title: 'AI 编程通用',
        role: '资深工程代理',
        intent: '把开发需求落成可实现、可验证、可回滚的代码变更。',
        deliverable: '代码修改、验证结果和剩余风险说明。',
        acceptance: ['核心用户流程可用', '改动范围小且不包含无关重构', '验证命令或手动检查路径明确'],
        rules: ['先读代码和测试再动手', '沿用现有架构和本地工具', '不能跳过验证']
      },
      bugfix: {
        title: 'Bug 修复',
        role: '负责定位根因的资深调试工程师',
        intent: '复现或推断问题，找到根因，做最小修复并防止回归。',
        deliverable: '根因说明、修复补丁、回归测试和验证结果。',
        acceptance: ['问题不再复现', '相关失败路径被测试覆盖', '未引入行为倒退'],
        rules: ['先定位触发条件和影响范围', '优先加回归测试', '不要用大重构掩盖根因']
      },
      feature: {
        title: '新功能开发',
        role: '能兼顾产品体验和工程质量的全栈工程师',
        intent: '在现有系统中小步实现新能力，并保证主流程可验收。',
        deliverable: '功能实现、必要 UI/API/数据改动、测试和使用说明。',
        acceptance: ['用户能完成新流程', '异常和空状态有处理', '权限、数据和验证路径清楚'],
        rules: ['先识别最小可行版本', '公共接口变化要明确', '不引入不必要依赖']
      },
      'frontend-ui': {
        title: '前端界面',
        role: '重视可用性和响应式细节的前端工程师',
        intent: '把界面需求落成清晰、可交互、状态完整的用户体验。',
        deliverable: '页面/组件实现、状态处理、交互验证和截图检查建议。',
        acceptance: ['loading/empty/error/permission 状态完整', '移动端和桌面端不溢出', '主要操作有反馈'],
        rules: ['沿用现有组件和样式系统', '避免营销式空壳页面', '文本不能重叠或溢出']
      },
      'api-design': {
        title: 'API / 后端设计',
        role: '关注接口契约、权限和数据一致性的后端工程师',
        intent: '把后端需求落成清晰的 API、服务层和数据行为。',
        deliverable: '接口设计/实现、权限判断、数据影响和测试计划。',
        acceptance: ['请求/响应契约清晰', '权限和错误码明确', '数据一致性和迁移风险说明清楚'],
        rules: ['API 层不塞复杂业务', '服务层和存储层边界清楚', '涉及契约要更新 OpenAPI']
      },
      refactor: {
        title: '代码重构',
        role: '谨慎的重构工程师',
        intent: '在不改变外部行为的前提下改善结构、可读性或维护性。',
        deliverable: '小步重构、行为不变说明、测试结果。',
        acceptance: ['外部行为不变', '复杂度或重复明显下降', '测试证明没有回归'],
        rules: ['先锁定重构边界', '避免顺手改功能', '每一步都可回滚']
      },
      prd: {
        title: 'PRD / 产品文档',
        role: '结构化产品经理',
        intent: '把模糊想法转成可评审、可开发、可验收的产品文档。',
        deliverable: '背景、目标、用户故事、范围、流程、验收标准和风险。',
        acceptance: ['需求边界清楚', '关键流程和异常场景完整', '研发可据此估时'],
        rules: ['避免空泛价值口号', '明确不做什么', '把验收标准写成可检查条目']
      },
      analysis: {
        title: '数据/业务分析',
        role: '严谨的数据分析助手',
        intent: '把分析问题转成数据口径、方法、输出和结论验证。',
        deliverable: '分析框架、指标口径、步骤、结论模板和风险提醒。',
        acceptance: ['指标口径清楚', '数据来源和假设明确', '结论能支撑决策'],
        rules: ['先定义问题和口径', '区分事实、推断和建议', '标注样本和数据限制']
      },
      forum: {
        title: '论坛发帖',
        role: '懂技术作品表达的社区内容编辑',
        intent: '把项目过程整理成清晰、有真实场景、有成果展示的参赛/分享帖。',
        deliverable: '标题、摘要、背景、过程、成果、效果总结。',
        acceptance: ['真实场景明确', '过程可复盘', '成果和链接/截图位置清楚'],
        rules: ['不要夸大效果', '突出实践过程', '保留可替换截图和链接位置']
      },
      manager: {
        title: '老板汇报',
        role: '面向管理者的项目汇报助手',
        intent: '把工作产出浓缩成价值、进展、结果、风险和下一步。',
        deliverable: '一段式汇报或结构化汇报稿。',
        acceptance: ['业务价值清楚', '结果可量化或可观察', '下一步明确'],
        rules: ['少讲技术细节，多讲价值和风险', '表达简洁', '不虚构数据']
      }
    };

    const scenarioFocusDefaults = {
      coding: ['backend', 'frontend', 'api', 'security', 'tests'],
      bugfix: ['backend', 'tests'],
      feature: ['backend', 'frontend', 'api', 'security', 'tests'],
      'frontend-ui': ['frontend', 'tests'],
      'api-design': ['backend', 'api', 'security', 'tests', 'data'],
      refactor: ['backend', 'tests'],
      prd: ['docs'],
      analysis: ['docs'],
      forum: ['docs'],
      manager: ['docs']
    };

    const aiPresets = {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini'
      },
      nvidia: {
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'nvidia/llama-3.1-nemotron-nano-8b-v1'
      },
      deepseek: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat'
      },
      gemini: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-2.0-flash'
      },
      kimi: {
        baseUrl: 'https://api.moonshot.cn/v1',
        model: 'kimi-k2-0711-preview'
      },
      groq: {
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'llama-3.3-70b-versatile'
      },
      openrouter: {
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/gpt-4o-mini'
      },
      doubao: {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        model: 'doubao-seed-1-6-250615'
      },
      doubaoCoding: {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
        model: 'doubao-seed-2-0-code-preview-260215'
      },
      custom: {
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini'
      }
    };

    function selectedFocus() {
      return Array.from(document.querySelectorAll('.chip input:checked')).map(input => input.value);
    }

    function setFocusForScenario() {
      const defaults = scenarioFocusDefaults[taskScenario.value] || scenarioFocusDefaults.coding;
      document.querySelectorAll('.chip input').forEach(input => {
        input.checked = defaults.includes(input.value);
      });
    }

    function analyze(raw) {
      const text = raw.trim();
      const checks = [
        {
          key: 'goal',
          label: '目标',
          weight: 1.3,
          ok: text.length >= 10 && /(想|要|需要|实现|修复|优化|生成|搭建|分析|写|做|create|build|fix|generate|analyze)/i.test(text),
          hint: '明确最终要得到什么产出。'
        },
        {
          key: 'background',
          label: '背景',
          weight: 0.9,
          ok: /(因为|目前|现在|场景|背景|用户|团队|业务|老板|论坛|参赛|痛点|原本|希望|current|because|context|user)/i.test(text),
          hint: '说明为什么要做、给谁用、当前痛点是什么。'
        },
        {
          key: 'current',
          label: '现状',
          weight: 0.9,
          ok: /(已有|当前|现有|项目|代码|仓库|页面|接口|数据|文件|插件|版本|现在|currently|existing|repo|codebase)/i.test(text),
          hint: '描述现有项目、已有材料或当前状态。'
        },
        {
          key: 'scope',
          label: '范围',
          weight: 1.0,
          ok: /(后端|前端|api|接口|页面|数据库|权限|测试|pipeline|流水线|仓库|repo|registry|gitspace|cli|bug|修复|实现|优化|PRD|报告|帖子|汇报)/i.test(text),
          hint: '说明任务属于哪些模块或工作类型。'
        },
        {
          key: 'output',
          label: '产出',
          weight: 1.0,
          ok: /(输出|生成|产出|文件|插件|页面|报告|文档|代码|链接|截图|Markdown|vsix|result|deliverable)/i.test(text),
          hint: '指定最终交付物格式。'
        },
        {
          key: 'acceptance',
          label: '验收',
          weight: 1.25,
          ok: /(验收|标准|必须|需要|完成|通过|用户能|能够|should|must|成功|可用|效果|入围|老板能看懂)/i.test(text),
          hint: '写出怎么判断做对了。'
        },
        {
          key: 'constraints',
          label: '约束',
          weight: 1.0,
          ok: /(不要|不能|避免|只|必须|保留|不改|不引入|兼容|权限|安全|secret|token|敏感|限制|约束|without|avoid|only)/i.test(text),
          hint: '补充不能做什么、必须保留什么。'
        },
        {
          key: 'verification',
          label: '验证',
          weight: 1.15,
          ok: /(测试|lint|build|构建|typecheck|go test|yarn|npm|验证|检查|截图|预览|运行|安装|诊断|test|verify)/i.test(text),
          hint: '说明如何验证结果。'
        },
        {
          key: 'risk',
          label: '风险',
          weight: 0.75,
          ok: /(风险|异常|失败|边界|回滚|兼容|旧版|错误|超时|权限|安全|fallback|edge)/i.test(text),
          hint: '让 AI 主动处理异常和风险。'
        },
        {
          key: 'final',
          label: '回复格式',
          weight: 0.75,
          ok: /(最后|最终|回复|总结|格式|汇总|说明|输出格式|final|summary)/i.test(text),
          hint: '要求最后按固定格式汇报。'
        }
      ];
      const passed = checks.filter(item => item.ok);
      const missingChecks = checks.filter(item => !item.ok);
      const totalWeight = checks.reduce((sum, item) => sum + item.weight, 0);
      const passedWeight = passed.reduce((sum, item) => sum + item.weight, 0);
      const lengthBonus = Math.min(text.length / 24, 12);
      const value = Math.min(98, Math.max(12, Math.round((passedWeight / totalWeight) * 86 + lengthBonus)));
      return {
        value,
        checks,
        passed,
        missingChecks,
        missing: missingChecks.map(item => item.label),
        hints: missingChecks.map(item => item.hint)
      };
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

    function getScenario() {
      return taskScenarios[taskScenario.value] || taskScenarios.coding;
    }

    function completionNotes(assessment, english) {
      if (!assessment.missingChecks.length) {
        return english
          ? ['The original prompt already covers the main execution fields; preserve the user intent and tighten wording only where useful.']
          : ['原始提示词已经覆盖主要执行字段；保留用户真实意图，只做结构化和措辞收敛。'];
      }

      return assessment.missingChecks.map(item => {
        if (english) {
          return 'Missing ' + item.label + ': infer it from the repository or context when possible; if it cannot be inferred, state the smallest safe assumption before acting.';
        }
        return '缺少「' + item.label + '」：能从仓库或上下文推断就先推断；无法推断时，先写出最小安全假设再执行。';
      });
    }

    function landingQuestions(assessment, english) {
      const missingQuestionMap = english ? {
        goal: 'What exact outcome should exist when this task is successful?',
        background: 'Who is this for, and what pain or work scenario makes it worth doing now?',
        current: 'What materials, code, data, pages, APIs, or documents already exist?',
        scope: 'Which parts are in the first version, and which parts must stay out of scope?',
        output: 'What final artifact should be delivered: code, page, plugin, report, PRD, forum post, or something else?',
        acceptance: 'How will we judge that the result is correct and usable?',
        constraints: 'What must not change, what dependencies are forbidden, and what compatibility rules matter?',
        verification: 'What checks, tests, screenshots, or manual flows should prove the result works?',
        risk: 'What failure cases, permissions, data issues, or rollback concerns need special handling?',
        final: 'What final response format will be easiest for you to review or share?'
      } : {
        goal: '最终成功时，用户应该看到什么结果、完成什么动作？',
        background: '这个想法给谁用，解决当前工作里的哪个具体痛点？',
        current: '现在已经有什么材料、代码、页面、接口、数据或文档？',
        scope: '第一版必须做哪些能力，哪些明确先不做？',
        output: '最终交付物是什么：代码、页面、插件、报告、PRD、帖子还是汇报稿？',
        acceptance: '怎么判断它真的可用，验收标准有哪些？',
        constraints: '哪些东西不能改，哪些依赖不能加，哪些兼容性必须保留？',
        verification: '要用什么测试、截图、预览或手动流程证明它能工作？',
        risk: '有哪些异常、权限、数据、安全或回滚风险需要提前处理？',
        final: '最后希望 AI 按什么格式汇报，方便你检查或转发？'
      };
      const core = english ? [
        'What is the smallest MVP that would still create visible value?',
        'What is the primary user workflow from start to finish?',
        'Which inputs are required, optional, or unknown?',
        'What should happen when the AI is uncertain or the request is under-specified?'
      ] : [
        '最小 MVP 是什么，做到哪一步就已经有真实价值？',
        '用户从开始到完成的一条主流程是什么？',
        '哪些输入是必填、可选或暂时未知的？',
        '当 AI 不确定时，应该先追问，还是按最小安全假设继续？'
      ];
      const questions = [];
      assessment.missingChecks.forEach(item => {
        const question = missingQuestionMap[item.key];
        if (question && !questions.includes(question)) {
          questions.push(question);
        }
      });
      core.forEach(question => {
        if (!questions.includes(question)) {
          questions.push(question);
        }
      });
      return questions.slice(0, 10);
    }

    function buildPrompt() {
      const raw = rawPrompt.value.trim();
      const focus = selectedFocus();
      const blueprint = projectBlueprints[projectType.value] || projectBlueprints.generic;
      const scenario = getScenario();
      const assessment = analyze(raw);
      const goal = firstSentence(raw);
      const strictMode = rigor.value === 'strict';
      const fastMode = rigor.value === 'fast';
      const isEnglish = language.value === 'en';
      const focusText = focus.length ? focus.map(key => focusLabels[key]).join('、') : '按代码上下文判断';
      const verification = [];
      const questions = landingQuestions(assessment, isEnglish);

      if (focus.includes('backend')) verification.push('Go: run targeted go test for changed packages; use make format / make lint-local when applicable.');
      if (focus.includes('frontend')) verification.push('Web: run typecheck/lint/test/build commands already defined by the project.');
      if (focus.includes('api')) verification.push('API: update OpenAPI/Swagger and generated client when request/response contracts change.');
      if (focus.includes('security')) verification.push('Security: verify authn/authz, scope checks, sensitive-data redaction, and audit/log behavior.');
      if (focus.includes('data')) verification.push('Data: include migration, rollback/compatibility notes, indexes, and backfill risks.');
      if (focus.includes('tests')) verification.push('Tests: add or update focused tests for success and failure paths.');
      if (focus.includes('docs')) verification.push('Docs: verify the output is complete, clear, reusable, and aligned with the requested audience.');
      if (focus.includes('ci')) verification.push('CI/CD: verify pipeline behavior, required checks, logs, and failure handling.');
      if (focus.includes('registry')) verification.push('Registry: verify artifact metadata, manifest/blob behavior, auth, and conformance-sensitive paths.');
      scenario.acceptance.forEach(item => verification.push('Scenario acceptance: ' + item));
      if (!verification.length) verification.push('Run the smallest relevant verification first, then broader checks if the blast radius is high.');

      const taskBody = raw || '【在这里粘贴你的具体功能、Bug、重构或优化需求】';
      const completion = completionNotes(assessment, isEnglish);

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
          '## Scenario',
          bulletList([
            'Scenario: ' + scenario.title,
            'Intent: ' + scenario.intent,
            'Expected deliverable: ' + scenario.deliverable
          ]),
          '',
          '## Current Task',
          taskBody,
          '',
          '## Goal',
          goal,
          '',
          '## Prompt Diagnosis',
          bulletList(completion),
          '',
          '## Clarifying Questions',
          'If any answer blocks implementation, ask before editing. If not, continue with the smallest safe assumption and call it out.',
          bulletList(questions),
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
            'Do not leak secrets, tokens, credentials, repository data, or private URLs in logs or examples.',
            ...scenario.rules
          ]),
          '',
          '## Acceptance Criteria',
          bulletList([
            'The requested user workflow works end to end.',
            'Behavior is covered by focused tests or a clearly stated manual verification path.',
            'API, data, permission, and UI state changes are documented in the final response.',
            'No unrelated files or broad refactors are included.',
            ...scenario.acceptance
          ]),
          '',
          '## Verification',
          bulletList(verification),
          '',
          '## Final Response Format',
          bulletList(['Summary of changes', 'Files changed', 'Verification run', 'Remaining risks or follow-ups'])
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
        '## 场景判断',
        bulletList([
          '任务场景：' + scenario.title,
          '核心意图：' + scenario.intent,
          '期望产出：' + scenario.deliverable
        ]),
        '',
        '## 当前任务',
        taskBody,
        '',
        '## 目标',
        goal,
        '',
        '## 诊断补齐',
        bulletList(completion),
        '',
        '## 先问清楚的问题',
        '如果答案会阻塞执行，先提问再动手；如果不阻塞，就按最小安全假设继续，并在最终回复里说明。',
        bulletList(questions),
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
          '不要把 secret、token、PAT、registry 凭据、私有 URL 或敏感数据写入日志、示例或测试快照。',
          ...scenario.rules
        ]),
        '',
        '## 验收标准',
        bulletList([
          '用户描述的核心流程可以端到端完成。',
          '新增或修改的行为有聚焦测试，或给出明确的手动验证路径。',
          '涉及 API 合约时同步 OpenAPI/Swagger，并说明是否需要重新生成前端 client。',
          '涉及数据结构时说明 migration、兼容旧数据、索引和回滚风险。',
          '最终改动不包含无关文件和大范围格式化。',
          ...scenario.acceptance
        ]),
        '',
        '## 建议验证',
        bulletList(verification),
        '',
        '## 最终回复格式',
        bulletList(['变更摘要', '关键文件', '验证命令与结果', '未覆盖风险或后续建议'])
      ].join('\\n');
    }

    function refresh() {
      const raw = rawPrompt.value;
      inputCount.textContent = String(raw.length);
      optimizedPrompt.value = buildPrompt();

      const assessment = analyze(raw);
      score.textContent = String(assessment.value);
      scoreTitle.textContent = assessment.value >= 82 ? '提示词结构完整' : assessment.value >= 58 ? '已补齐关键工程约束' : '需要更多上下文';
      scoreReason.textContent = assessment.missing.length
        ? '自动补齐：' + assessment.missing.join('、') + '。'
        : '目标、范围、验收、技术栈、验证和安全要点都比较明确。';

      diagnosisGrid.innerHTML = '';
      assessment.checks.forEach(item => {
        const el = document.createElement('span');
        el.className = 'diag-item ' + (item.ok ? 'ok' : 'missing');
        el.title = item.ok ? '已覆盖' : item.hint;
        el.textContent = (item.ok ? '✓ ' : '+ ') + item.label;
        diagnosisGrid.appendChild(el);
      });

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
        projectType: projectType.value,
        rigor: rigor.value,
        language: language.value,
        taskScenario: taskScenario.value,
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
          taskScenario.value = item.taskScenario || 'coding';
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

    function setStatus(message) {
      aiStatus.innerHTML = 'AI 状态：<strong>' + escapeHtml(message) + '</strong>';
    }

    function planModeActive() {
      return aiMode.value === 'plan';
    }

    function syncPlanVisibility() {
      planPanel.classList.toggle('is-hidden', !planModeActive());
      if (planModeActive()) {
        planPanel.open = true;
      }
    }

    function aiButtonText() {
      if (aiMode.value === 'plan') {
        return '开始计划';
      }
      return aiMode.value === 'landing' ? 'AI 提问式优化' : 'AI 二次优化';
    }

    function aiOptions() {
      return {
        provider: aiProvider.value,
        mode: aiMode.value,
        baseUrl: aiBaseUrl.value.trim(),
        model: aiModel.value.trim()
      };
    }

    function requestOptions() {
      return {
        projectType: projectType.value,
        rigor: rigor.value,
        language: language.value,
        taskScenario: taskScenario.value,
        focus: selectedFocus()
      };
    }

    function contextSelection() {
      const selection = {};
      document.querySelectorAll('.plan-context-option').forEach(input => {
        selection[input.value] = input.checked;
      });
      return selection;
    }

    function hasContextSelection(selection) {
      return Boolean(selection.structure || selection.readme || selection.packageJson || selection.activeEditor);
    }

    function persistPlanState() {
      localStorage.setItem('traePromptOptimizer.planState', JSON.stringify(planState));
    }

    function restorePlanState() {
      try {
        const saved = JSON.parse(localStorage.getItem('traePromptOptimizer.planState') || 'null');
        if (saved && saved.session) {
          planState = {
            session: saved.session,
            stage: saved.stage || 'waiting_answer',
            status: saved.status || '等待回答',
            diagnosis: saved.diagnosis || '',
            questions: Array.isArray(saved.questions) ? saved.questions : [],
            questionCards: Array.isArray(saved.questionCards) ? saved.questionCards : [],
            draftPlan: saved.draftPlan || '',
            finalPlan: saved.finalPlan || '',
            workspaceContext: saved.workspaceContext || null
          };
        }
      } catch {
        localStorage.removeItem('traePromptOptimizer.planState');
      }
    }

    function setPlanBusy(busy, label) {
      ['planStartBtn', 'planAnswerBtn', 'planFinalizeBtn'].forEach(id => {
        document.getElementById(id).disabled = busy;
      });
      const aiBtn = document.getElementById('aiBtn');
      if (planModeActive()) {
        aiBtn.disabled = busy;
        aiBtn.textContent = busy ? (label || '计划中...') : aiButtonText();
      }
    }

    function renderPlanState() {
      planStage.textContent = planState.status || '未开始';
      planDiagnosis.textContent = planState.diagnosis || '暂无诊断。';
      planQuestions.innerHTML = '';
      planContextLabels.innerHTML = '';

      const labels = planState.workspaceContext && planState.workspaceContext.labels ? planState.workspaceContext.labels : [];
      labels.forEach(label => {
        const pill = document.createElement('span');
        pill.className = 'pill';
        pill.textContent = label;
        planContextLabels.appendChild(pill);
      });

      if (!planState.questions || !planState.questions.length) {
        const empty = document.createElement('div');
        empty.className = 'plan-diagnosis';
        empty.textContent = planState.stage === 'final_plan' ? '最终计划已生成。' : '暂无问题，点击“开始计划”生成第一轮追问。';
        planQuestions.appendChild(empty);
      } else {
        planState.questions.forEach((question, index) => {
          const item = document.createElement('div');
          item.className = 'plan-question';
          const stored = planState.questionCards && planState.questionCards[index] ? planState.questionCards[index] : {};
          item.innerHTML = [
            '<div class="plan-question-head">',
            '<strong>Q' + (index + 1) + '：' + escapeHtml(question) + '</strong>',
            '<select class="plan-question-state" data-index="' + index + '">',
            '<option value="answered">已回答</option>',
            '<option value="unsure">不确定</option>',
            '<option value="skip">跳过</option>',
            '</select>',
            '</div>',
            '<textarea class="plan-question-answer" data-index="' + index + '" placeholder="在这里回答这个问题">' + escapeHtml(stored.answer || '') + '</textarea>'
          ].join('');
          planQuestions.appendChild(item);
          const state = item.querySelector('.plan-question-state');
          state.value = stored.state || 'answered';
        });
      }

      if (planState.finalPlan) {
        optimizedPrompt.value = planState.finalPlan;
        score.textContent = 'PLAN';
        scoreTitle.textContent = '计划已生成';
        scoreReason.textContent = '最终结果包含 proposed_plan，可复制给 Trae 或先评审。';
      } else if (planState.draftPlan || planState.questions.length) {
        optimizedPrompt.value = planMarkdownFromState();
        score.textContent = 'PLAN';
        scoreTitle.textContent = '计划模式进行中';
        scoreReason.textContent = planState.stage === 'ready_to_finalize' ? '信息基本足够，可以生成最终计划。' : '回答关键问题后继续收敛方案。';
      }
    }

    function planMarkdownFromState() {
      const lines = [
        '# 计划模式',
        '',
        '## 状态',
        planState.status || '未开始',
        '',
        '## 诊断',
        planState.diagnosis || '暂无诊断。'
      ];
      if (planState.questions && planState.questions.length) {
        lines.push('', '## 下一轮需要回答的问题');
        planState.questions.forEach((question, index) => {
          lines.push((index + 1) + '. ' + question);
        });
      }
      if (planState.draftPlan) {
        lines.push('', '## 草稿计划', planState.draftPlan);
      }
      return lines.join('\\n');
    }

    function collectPlanAnswer() {
      const answers = [];
      document.querySelectorAll('.plan-question-answer').forEach(input => {
        const index = Number(input.getAttribute('data-index'));
        const value = input.value.trim();
        const stateEl = document.querySelector('.plan-question-state[data-index="' + index + '"]');
        const state = stateEl ? stateEl.value : 'answered';
        if (!planState.questionCards) {
          planState.questionCards = [];
        }
        planState.questionCards[index] = { state, answer: value };
        if (value || state !== 'answered') {
          answers.push('Q' + (index + 1) + ': ' + (planState.questions[index] || '') + '\\n状态: ' + state + '\\nA: ' + (value || '未填写'));
        }
      });
      const extra = planAnswer.value.trim();
      if (extra) {
        answers.push('补充说明：\\n' + extra);
      }
      return answers.join('\\n\\n');
    }

    function postPlanStart() {
      saveHistory();
      setPlanBusy(true, '诊断中...');
      planState = {
        session: null,
        stage: 'diagnosing',
        status: '诊断中',
        diagnosis: '正在诊断目标、上下文和缺口。',
        questions: [],
        questionCards: [],
        draftPlan: '',
        finalPlan: '',
        workspaceContext: null
      };
      renderPlanState();
      const selection = contextSelection();
      vscode.postMessage({
        type: 'planStart',
        value: optimizedPrompt.value,
        raw: rawPrompt.value,
        options: requestOptions(),
        ai: aiOptions(),
        includeWorkspaceContext: hasContextSelection(selection),
        contextSelection: selection
      });
      notify(hasContextSelection(selection) ? '正在读取所选上下文并开始计划' : '正在开始计划');
    }

    function postPlanAnswer() {
      const answer = collectPlanAnswer();
      if (!answer) {
        notify('请先填写至少一个回答');
        return;
      }
      setPlanBusy(true, '追问中...');
      vscode.postMessage({
        type: 'planAnswer',
        session: planState.session,
        answer
      });
      notify('正在继续计划');
    }

    function postPlanFinalize() {
      if (!planState.session) {
        notify('请先开始计划');
        return;
      }
      setPlanBusy(true, '生成中...');
      vscode.postMessage({
        type: 'planFinalize',
        session: planState.session
      });
      notify('正在生成最终计划');
    }

    function postExportMcpContext() {
      const selection = contextSelection();
      const btn = document.getElementById('mcpExportBtn');
      btn.disabled = true;
      btn.textContent = '导出中...';
      vscode.postMessage({
        type: 'exportMcpContext',
        value: optimizedPrompt.value,
        raw: rawPrompt.value,
        options: requestOptions(),
        contextSelection: selection,
        planState
      });
      notify('正在导出 MCP 上下文');
    }

    function resetPlanState() {
      planState = {
        session: null,
        stage: 'idle',
        status: '未开始',
        diagnosis: '选择 AI 优化模式为“计划模式”后，输入一个目标并点击“开始计划”。',
        questions: [],
        questionCards: [],
        draftPlan: '',
        finalPlan: '',
        workspaceContext: null
      };
      planAnswer.value = '';
      localStorage.removeItem('traePromptOptimizer.planState');
      renderPlanState();
      notify('计划已重置');
    }

    function applyAiPreset() {
      const preset = aiPresets[aiProvider.value] || aiPresets.openai;
      aiBaseUrl.value = preset.baseUrl;
      aiModel.value = preset.model;
      aiModelList.innerHTML = '';
      const special = aiProvider.value === 'nvidia'
        ? 'NVIDIA 预设已就绪，请保存 Key 后一键诊断'
        : aiProvider.value === 'doubaoCoding'
          ? '豆包 Coding Plan 预设已就绪，模型名请以获取模型结果为准'
          : aiProvider.value === 'doubao'
            ? '豆包/火山方舟预设已就绪，请确认模型权限'
            : 'AI 预设已切换';
      setStatus(special);
      notify('已切换 AI 预设');
      vscode.postMessage({ type: 'getApiKeyStatus', options: aiOptions() });
    }

    function setModels(models) {
      aiModelList.innerHTML = '';
      models.forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        aiModelList.appendChild(option);
      });
      if (models.length && !models.includes(aiModel.value)) {
        aiModel.value = models[0];
      }
    }

    function post(type) {
      saveHistory();
      vscode.postMessage({ type, value: optimizedPrompt.value });
    }

    function postAiOptimize() {
      if (planModeActive()) {
        postPlanStart();
        return;
      }
      saveHistory();
      const aiBtn = document.getElementById('aiBtn');
      aiBtn.disabled = true;
      aiBtn.textContent = aiMode.value === 'landing' ? '生成中...' : '优化中...';
      vscode.postMessage({
        type: 'aiOptimize',
        value: optimizedPrompt.value,
        raw: rawPrompt.value,
        options: requestOptions(),
        ai: aiOptions()
      });
      notify(aiMode.value === 'landing' ? '正在生成提问式落地稿' : '正在请求 AI 优化');
    }

    function postListModels() {
      const btn = document.getElementById('listModelsBtn');
      btn.disabled = true;
      btn.textContent = '获取中...';
      setStatus('正在获取模型列表');
      vscode.postMessage({ type: 'listModels', options: aiOptions() });
    }

    function postDiagnoseAi() {
      const btn = document.getElementById('diagnoseAiBtn');
      btn.disabled = true;
      btn.textContent = '诊断中...';
      setStatus('正在保存 Key 并检查模型列表');
      vscode.postMessage({ type: 'diagnoseAi', options: aiOptions(), apiKey: apiKeyInput.value.trim() });
    }

    function postSaveApiKey() {
      const btn = document.getElementById('saveApiKeyBtn');
      btn.disabled = true;
      btn.textContent = '保存中...';
      vscode.postMessage({ type: 'saveApiKey', apiKey: apiKeyInput.value.trim(), options: aiOptions() });
    }

    document.getElementById('copyBtn').addEventListener('click', () => post('copy'));
    document.getElementById('sendTraeBtn').addEventListener('click', () => post('sendToTrae'));
    document.getElementById('aiBtn').addEventListener('click', postAiOptimize);
    document.getElementById('saveApiKeyBtn').addEventListener('click', postSaveApiKey);
    document.getElementById('listModelsBtn').addEventListener('click', postListModels);
    document.getElementById('diagnoseAiBtn').addEventListener('click', postDiagnoseAi);
    document.getElementById('planStartBtn').addEventListener('click', postPlanStart);
    document.getElementById('planAnswerBtn').addEventListener('click', postPlanAnswer);
    document.getElementById('planFinalizeBtn').addEventListener('click', postPlanFinalize);
    document.getElementById('mcpExportBtn').addEventListener('click', postExportMcpContext);
    document.getElementById('planResetBtn').addEventListener('click', resetPlanState);
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
    taskScenario.addEventListener('change', () => {
      setFocusForScenario();
      refresh();
    });
    aiMode.addEventListener('change', () => {
      document.getElementById('aiBtn').textContent = aiButtonText();
      syncPlanVisibility();
      setStatus(aiMode.value === 'plan'
        ? '计划模式：多轮追问后生成 proposed_plan'
        : aiMode.value === 'landing'
          ? '提问式落地：会生成问题清单、MVP、执行规格和 Trae Prompt'
          : '直接执行 Prompt：会把当前结果压缩成可复制的 Trae Prompt');
    });
    aiProvider.addEventListener('change', applyAiPreset);
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
        aiBtn.textContent = aiButtonText();
        score.textContent = 'AI';
        scoreTitle.textContent = aiMode.value === 'landing' ? 'AI 已生成落地稿' : 'AI 已二次优化';
        scoreReason.textContent = aiMode.value === 'landing'
          ? '结果包含关键问题、临时假设、MVP、执行规格和 Trae Prompt。'
          : '结果来自你配置的 OpenAI-compatible API。';
        notify(aiMode.value === 'landing' ? '落地稿生成完成' : 'AI 优化完成');
      }

      if (message.type === 'modelsListed') {
        const btn = document.getElementById('listModelsBtn');
        btn.disabled = false;
        btn.textContent = '获取模型';
        const models = message.value && message.value.models ? message.value.models : [];
        setModels(models);
        setStatus('模型获取成功：' + models.length + ' 个');
        notify('已获取 ' + models.length + ' 个模型');
      }

      if (message.type === 'aiTested') {
        const btn = document.getElementById('diagnoseAiBtn');
        btn.disabled = false;
        btn.textContent = '一键诊断';
        const value = message.value || {};
        setStatus('连接正常，模型数：' + (value.count || 0));
        notify('连接正常，模型数：' + (value.count || 0));
      }

      if (message.type === 'apiKeySaved') {
        const btn = document.getElementById('saveApiKeyBtn');
        btn.disabled = false;
        btn.textContent = '保存 Key';
        apiKeyInput.value = '';
        setStatus('API Key 已保存');
        notify('API Key 已保存');
      }

      if (message.type === 'apiKeyStatus') {
        const hasApiKey = message.value && message.value.hasApiKey;
        setStatus(hasApiKey ? '已有已保存的 API Key' : '未保存 API Key');
      }

      if (message.type === 'aiDiagnosed') {
        const btn = document.getElementById('diagnoseAiBtn');
        btn.disabled = false;
        btn.textContent = '一键诊断';
        const value = message.value || {};
        const models = value.models || [];
        setModels(models);
        apiKeyInput.value = '';
        setStatus('诊断通过：' + (value.count || 0) + ' 个模型可用');
        notify('诊断通过');
      }

      if (message.type === 'planUpdated') {
        const value = message.value || {};
        planState = {
          session: value.session || planState.session,
          stage: value.stage || 'waiting_answer',
          status: value.status || '等待回答',
          diagnosis: value.diagnosis || '',
          questions: Array.isArray(value.questions) ? value.questions : [],
          questionCards: [],
          draftPlan: value.draftPlan || '',
          finalPlan: value.finalPlan || '',
          workspaceContext: value.workspaceContext || null
        };
        planAnswer.value = '';
        setPlanBusy(false);
        renderPlanState();
        persistPlanState();
        setStatus(planState.stage === 'final_plan' ? '计划已生成' : '计划模式等待回答');
        notify(planState.stage === 'final_plan' ? '最终计划已生成' : '计划已更新');
      }

      if (message.type === 'planError') {
        setPlanBusy(false);
        setStatus('计划模式失败：' + (message.value || '请检查 Key、Base URL 和模型'));
        notify('计划模式失败');
      }

      if (message.type === 'mcpContextExported') {
        const btn = document.getElementById('mcpExportBtn');
        btn.disabled = false;
        btn.textContent = '导出 MCP 上下文';
        const value = message.value || {};
        mcpNote.textContent = '已导出：' + (value.contextPath || '.trae/prompt-optimizer/context.json');
        notify('MCP 上下文已导出');
      }

      if (message.type === 'mcpContextError') {
        const btn = document.getElementById('mcpExportBtn');
        btn.disabled = false;
        btn.textContent = '导出 MCP 上下文';
        mcpNote.textContent = '导出失败：' + (message.value || '请打开工作区后重试');
        notify('MCP 导出失败');
      }

      if (message.type === 'aiError') {
        const aiBtn = document.getElementById('aiBtn');
        aiBtn.disabled = false;
        aiBtn.textContent = aiButtonText();
        document.getElementById('saveApiKeyBtn').disabled = false;
        document.getElementById('saveApiKeyBtn').textContent = '保存 Key';
        document.getElementById('listModelsBtn').disabled = false;
        document.getElementById('listModelsBtn').textContent = '获取模型';
        document.getElementById('diagnoseAiBtn').disabled = false;
        document.getElementById('diagnoseAiBtn').textContent = '一键诊断';
        setStatus('操作失败：' + (message.value || '请检查 Key、Base URL 和模型'));
        notify('操作失败');
      }
    });

    if (!rawPrompt.value.trim() && initialPrompt) {
      rawPrompt.value = initialPrompt;
    }
    document.getElementById('aiBtn').textContent = aiButtonText();
    syncPlanVisibility();
    restorePlanState();
    vscode.postMessage({ type: 'getApiKeyStatus' });
    refresh();
    renderPlanState();
    renderHistory();
  </script>
</body>
</html>`;
}

module.exports = {
  activate,
  deactivate,
  __test: {
    getWebviewHtml,
    isBlockedContextName,
    ensureProposedPlan,
    parsePlanResponse
  }
};
