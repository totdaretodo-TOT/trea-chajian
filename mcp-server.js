#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_NAME = 'trae-prompt-optimizer-mcp';
const SERVER_VERSION = '0.12.0';
const MAX_FILE_CHARS = 120000;

const workspaceRoot = resolveWorkspaceRoot();

function resolveWorkspaceRoot() {
  const arg = process.argv[2];
  const env = process.env.TRAE_PROMPT_OPTIMIZER_WORKSPACE;
  return path.resolve(arg || env || process.cwd());
}

function contextDir() {
  return path.join(workspaceRoot, '.trae', 'prompt-optimizer');
}

function contextPath() {
  return path.join(contextDir(), 'context.json');
}

function memoryPath() {
  return path.join(contextDir(), 'memory.md');
}

function isBlockedPath(value) {
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

function safeResolve(relativePath) {
  const target = path.resolve(workspaceRoot, String(relativePath || '.'));
  const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
  if (target !== workspaceRoot && !target.startsWith(rootWithSep)) {
    throw new Error('Refusing to read outside the workspace root.');
  }
  if (isBlockedPath(path.relative(workspaceRoot, target))) {
    throw new Error('Refusing to read blocked or sensitive path.');
  }
  return target;
}

function readText(filePath, maxChars = MAX_FILE_CHARS) {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error('Path is not a file.');
  }
  const text = fs.readFileSync(filePath, 'utf8');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]` : text;
}

function listContextFiles() {
  if (!fs.existsSync(contextDir())) {
    return [];
  }
  return fs.readdirSync(contextDir(), { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const filePath = path.join(contextDir(), entry.name);
      const stat = fs.statSync(filePath);
      return {
        name: entry.name,
        path: filePath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      };
    });
}

function textContent(text) {
  return [{ type: 'text', text: String(text || '') }];
}

function jsonText(value) {
  return textContent(JSON.stringify(value, null, 2));
}

const tools = [
  {
    name: 'get_prompt_optimizer_context',
    description: 'Read the latest Trae Prompt Optimizer context snapshot from .trae/prompt-optimizer/context.json.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_prompt_optimizer_memory',
    description: 'Read Trae Prompt Optimizer memory.md accumulated from exported planning sessions.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_prompt_optimizer_context_files',
    description: 'List files currently exported under .trae/prompt-optimizer.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'read_workspace_file',
    description: 'Safely read a non-sensitive file inside the workspace root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        maxChars: { type: 'number', description: 'Maximum characters to return.' }
      },
      required: ['path']
    }
  }
];

function callTool(name, args) {
  if (name === 'get_prompt_optimizer_context') {
    const text = readText(contextPath());
    return textContent(text || 'No context snapshot found. Export MCP context from the Trae Prompt Optimizer panel first.');
  }
  if (name === 'get_prompt_optimizer_memory') {
    const text = readText(memoryPath());
    return textContent(text || 'No memory file found. Export MCP context from the Trae Prompt Optimizer panel first.');
  }
  if (name === 'list_prompt_optimizer_context_files') {
    return jsonText({ workspaceRoot, files: listContextFiles() });
  }
  if (name === 'read_workspace_file') {
    const target = safeResolve(args && args.path);
    const text = readText(target, Math.min(Number(args && args.maxChars) || MAX_FILE_CHARS, MAX_FILE_CHARS));
    return textContent(text);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function listResources() {
  return [
    {
      uri: 'trae-prompt-optimizer://context',
      name: 'Trae Prompt Optimizer Context Snapshot',
      mimeType: 'application/json',
      description: 'Latest exported planning context snapshot.'
    },
    {
      uri: 'trae-prompt-optimizer://memory',
      name: 'Trae Prompt Optimizer Memory',
      mimeType: 'text/markdown',
      description: 'Accumulated planning memory exported by the extension.'
    }
  ];
}

function readResource(uri) {
  if (uri === 'trae-prompt-optimizer://context') {
    return {
      contents: [{ uri, mimeType: 'application/json', text: readText(contextPath()) || '{}' }]
    };
  }
  if (uri === 'trae-prompt-optimizer://memory') {
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: readText(memoryPath()) || '' }]
    };
  }
  throw new Error(`Unknown resource: ${uri}`);
}

function makeResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id, error) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: error && error.message ? error.message : String(error)
    }
  };
}

function handleRequest(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return makeResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
        resources: {}
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION
      }
    });
  }
  if (method === 'tools/list') {
    return makeResponse(id, { tools });
  }
  if (method === 'tools/call') {
    const result = callTool(params && params.name, params && params.arguments ? params.arguments : {});
    return makeResponse(id, { content: result });
  }
  if (method === 'resources/list') {
    return makeResponse(id, { resources: listResources() });
  }
  if (method === 'resources/read') {
    return makeResponse(id, readResource(params && params.uri));
  }
  if (method === 'ping') {
    return makeResponse(id, {});
  }
  if (method && method.startsWith('notifications/')) {
    return undefined;
  }
  return makeError(id, new Error(`Unsupported MCP method: ${method}`));
}

function writeMessage(message) {
  if (!message) {
    return;
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      let request;
      try {
        request = JSON.parse(line);
        writeMessage(handleRequest(request));
      } catch (error) {
        writeMessage(makeError(request && request.id !== undefined ? request.id : null, error));
      }
    }
    index = buffer.indexOf('\n');
  }
});
