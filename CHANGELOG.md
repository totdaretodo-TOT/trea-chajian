# Changelog

## 0.12.0

- Add a local MCP context bridge with `mcp-server.js`.
- Add `导出 MCP 上下文` in Plan Mode to write `.trae/prompt-optimizer/context.json` and append `.trae/prompt-optimizer/memory.md`.
- Expose MCP tools for reading the latest context snapshot, memory, exported context files, and safe workspace files.
- Include the MCP server in VSIX packaging and document MCP client configuration.
- Fix provider-specific API key status/storage so each provider can keep its own saved key.
- Write a `.gitignore` beside exported MCP context to avoid committing snapshots by accident.

## 0.11.2

- Improve OpenAI-compatible API diagnostics for non-JSON responses and network failures.
- Preserve query parameters when normalizing Base URLs for providers that require them.
- Add an explicit `Accept: application/json` header to chat completion requests.

## 0.11.1

- Improve narrow Webview layout so fold titles, plan controls, context options, and diagnosis text stay inside their containers.
- Hide low-priority fold summaries on small widths and keep primary titles on one line.
- Make Plan Mode actions use a stable responsive grid instead of cramped wrapping buttons.

## 0.11.0

- Add provider presets for DeepSeek, Gemini OpenAI compatibility, Kimi, Groq, OpenRouter, Volcengine Ark/Doubao, and Doubao Coding Plan.
- Improve AI error messages with actionable Chinese diagnostics for wrong model IDs, missing permissions, bad Base URLs, invalid keys, and provider mismatch.
- Replace the single workspace-context checkbox with a selector for directory structure, README, package.json, and active editor context.
- Upgrade Plan Mode questions into answer cards with `已回答`, `不确定`, and `跳过` states.

## 0.10.0

- Add AI `计划模式` for multi-round planning before producing a final implementation plan.
- Add plan session actions: start plan, submit answers, generate final plan, and reset.
- Add optional lightweight workspace context collection with safety filters for secrets, build output, dependencies, and VCS folders.
- Require final plan output to contain a `<proposed_plan>` block with Summary, Key Changes, Test Plan, and Assumptions.
- Keep existing `提问式落地` and `直接执行 Prompt` modes available.

## 0.9.2

- Fix the score header layout so the reason text no longer gets squeezed into a vertical column.
- Move focus pills to their own row under the score summary for narrow Webview widths.
- Add a mobile fallback for the score header to keep text readable.

## 0.9.1

- Make the Webview less crowded with collapsible AI configuration, task settings, diagnosis details, and history sections.
- Keep the main screen focused on the raw prompt, generated prompt, and primary actions.
- Switch the output panel layout to a stable flex column so the generated prompt keeps the main vertical space.

## 0.9.0

- Change the default AI optimizer from light prompt polishing to a question-driven idea landing workflow.
- Add an AI mode selector for `提问式落地` and `直接执行 Prompt`.
- Make AI landing output include clarifying questions, temporary assumptions, MVP scope, detailed execution specs, a Trae-ready prompt, and a user answer template.
- Add local clarifying questions to the generated prompt so rough ideas expose missing decisions before execution.
- Update README guidance and installation path for the new workflow.

## 0.8.0

- Add first-principles prompt diagnosis with 10 dimensions: goal, background, current state, scope, output, acceptance, constraints, verification, risk, and final response format.
- Add visible diagnosis chips in the Webview so users can see what the rough prompt already covers and what will be auto-completed.
- Add task scenario templates for coding, bug fix, feature work, frontend UI, API/backend design, refactor, PRD, analysis, forum posts, and manager reports.
- Add scenario-aware prompt generation with scenario intent, expected deliverable, acceptance criteria, and execution rules.
- Automatically adjust focus chips when the task scenario changes.

## 0.7.0

- Add fully graphical API Key save flow inside the Webview panel.
- Add one-click AI diagnostics that saves the key, requests `/models`, and fills model candidates.
- Add visual AI status line for key/model/connection feedback.
- Keep the command palette API Key command only as a fallback.

## 0.6.0

- Add AI provider presets for OpenAI-compatible, NVIDIA, and custom endpoints.
- Add NVIDIA API Catalog preset with `https://integrate.api.nvidia.com/v1`.
- Add Webview controls for provider, base URL, model, model listing, and API test.
- Add `/models` request support so users can fetch valid model IDs before optimizing.
- Improve error recovery so AI buttons are re-enabled after model list/test failures.

## 0.5.0

- Restore a stable Webview implementation with valid UTF-8 Chinese text.
- Replace fragile long string concatenation with a clear HTML template.
- Remove the broken 0.4 template/scoring expansion from the shipped UI.
- Remove the `Ctrl+Shift+P` keybinding so the command palette is not overridden.
- Keep core flows: optimize prompt, copy, insert, export Markdown, save Trae Rule, send to Trae Chat, and optional OpenAI-compatible AI optimization.
- Keep API keys in VS Code/Trae SecretStorage and route AI requests through the extension host.
- Make the offline VSIX packager clean its temporary `dist/vsix-build` directory after packaging.

## 0.4.0

- Added an experimental scoring/template expansion. This version was unstable and is superseded by 0.5.0.

## 0.3.0

- Added dark mode, template library, examples, and keyboard shortcuts.

## 0.2.0

- Added "Send to Trae" workflow that copies the optimized prompt and tries to open a compatible chat panel.
- Added optional OpenAI-compatible AI optimization.
- Stored AI API key in VS Code/Trae SecretStorage.
- Added extension settings for API base URL, model, system prompt, and chat command ID.

## 0.1.0

- Initial Trae-compatible VS Code extension.
- Added prompt optimizer webview.
- Added optimize-selection command.
- Supported copy, insert, markdown export, and `.trae/rules` save flow.
