# Trae Prompt Optimizer

一个面向 Trae 的提示词优化插件。它把一句很粗的目标整理成多轮计划、关键问题、最终执行计划和 Trae Prompt，适合 Go 后端、React/TypeScript 前端、DevOps 平台、CI/CD、代码托管、Artifact Registry，也适合 PRD、分析、论坛发帖和老板汇报。

## 功能

- 在命令面板打开 `Trae Prompt Optimizer: Open`。
- 在编辑器里选中文本后右键运行 `Trae Prompt Optimizer: Optimize Selection`。
- 根据项目类型、执行强度和关注领域自动生成工程化提示词。
- 按第一性原理诊断提示词缺失项：目标、背景、现状、范围、产出、验收、约束、验证、风险、回复格式。
- 支持任务场景模板：AI 编程、Bug 修复、新功能、前端界面、API 设计、重构、PRD、分析、论坛发帖、老板汇报。
- 一键复制、插入编辑器、导出 Markdown。
- 一键复制并尝试打开 Trae Chat，方便粘贴发送。
- 一键保存到当前工作区 `.trae/rules/harness-blueprint-prompt.md`。
- 可选接入 OpenAI-compatible API，默认进行“计划模式”：多轮追问后生成 `<proposed_plan>` 执行计划。
- 支持在面板中切换 `计划模式`、`提问式落地` 和 `直接执行 Prompt` 三种 AI 优化模式。
- 计划模式支持每轮 5-8 个关键问题、卡片式回答、标记不确定/跳过、整体粘贴回答、最终生成可评审计划。
- 计划模式可选读取轻量工作区上下文，可分别勾选目录结构、README、package.json、当前编辑器，并排除 `.env*`、`.git`、`node_modules`、`dist`、secret/token/key 类文件。
- 支持导出 MCP 上下文快照到 `.trae/prompt-optimizer/context.json`，并内置无依赖 MCP Server 读取该快照。
- AI 配置、任务设置、诊断详情和历史记录都支持折叠，默认界面更清爽。
- 优化结果顶部的评分说明和关注标签分行展示，避免窄屏下中文被挤成竖排。
- 内置 OpenAI、NVIDIA、DeepSeek、Gemini、Kimi、Groq、OpenRouter、豆包/火山方舟和豆包 Coding Plan 预设，可一键填入 Base URL 并获取模型列表。
- 在插件面板内保存 API Key、获取模型和一键诊断，尽量减少命令行操作。
- 默认本地运行，不调用外部 API；只有点击 `开始计划` / `AI 提问式优化` / `AI 二次优化` 并配置 API Key 后才会把提示词发送到你设置的模型服务。

## 安装到 Trae

1. 在本目录运行：

   ```bash
   npm run package
   ```

2. 得到 `dist/trae-prompt-optimizer-0.12.0.vsix`。
3. 打开 Trae 的扩展商店。
4. 把 `.vsix` 文件拖入扩展商店安装。
5. 安装后打开命令面板，运行 `Trae Prompt Optimizer: Open`。

## 使用建议

输入时不用写得很完整，例如：

```text
我想做一个像 Harness 一样的开源 DevOps 平台，先实现仓库页面和流水线执行列表。后端用 Go，前端用 React，希望 Trae 帮我先读代码结构再修改。
```

插件会自动补齐：

- 角色定位
- 项目蓝本
- 场景判断
- 诊断补齐假设
- 先问清楚的问题
- 当前任务
- 目标
- 执行规则
- 验收标准
- 建议验证
- 最终回复格式

核心原则：Prompt 优化不是把话写长，而是降低 AI 的不确定性。插件会先判断缺什么，再把缺失信息转成“可推断则推断，不可推断则写出最小安全假设”的执行规则。

## AI 计划模式

插件不会直接调用 Trae 内置 AI，因为 Trae 目前没有公开稳定的第三方插件调用接口。

如果你想让模型像 Codex Plan Mode 一样先问问题、再形成可执行计划，推荐直接在插件面板里配置：

1. 选择 `AI 提供商`。
2. 选择 `AI 优化模式`：
   - `计划模式`：默认模式，适合“我只有一个想法，帮我多轮追问并生成执行计划”。
   - `提问式落地`：一次性输出问题、假设、MVP 和 Trae Prompt。
   - `直接执行 Prompt`：适合你已经想清楚，只想生成一段可复制给 Trae 的执行 Prompt。
3. 粘贴 API Key，点击 `保存 Key`。
4. 点击 `获取模型` 或 `一键诊断`。
5. 选择或填写模型。
6. 点击 `开始计划`。

计划模式会：

- 先诊断目标、上下文、缺口和高影响歧义。
- 每轮提出 5-8 个会改变方案的问题。
- 支持用户逐条填写答案，标记“不确定/跳过”，或在整体回答框里一次粘贴背景。
- 信息足够后生成包含 `<proposed_plan>` 的最终计划。
- 最终计划默认包含 Summary、Key Changes、Test Plan 和 Assumptions。

`提问式落地` 模式会要求模型一次性输出：

- 8-12 个关键澄清问题，并说明每个问题会决定什么。
- 在用户还没回答前的最小合理假设。
- MVP 落地方案：先做什么、不做什么、主流程和交付物。
- 详细执行规格：目标、用户、功能、数据/API/UI、约束、验收、验证、风险。
- 可以直接交给 Trae 的最终执行 Prompt。
- 给用户继续补充答案的简短模板。

API Key 会保存在 VS Code/Trae SecretStorage。命令 `Trae Prompt Optimizer: Set AI API Key` 仍保留为备用入口，但日常不需要使用命令行或命令面板配置。

## MCP 上下文桥

插件不能直接读取 Trae 内置 Chat 的私有历史，但可以把当前工作区上下文导出成 MCP 可读快照：

1. 在 `计划模式` 面板勾选需要的上下文：目录结构、README、package.json、当前编辑器。
2. 点击 `导出 MCP 上下文`。
3. 插件会写入：

   ```text
   .trae/prompt-optimizer/context.json
   .trae/prompt-optimizer/memory.md
   ```

   插件也会在该目录写入 `.gitignore`，默认避免把上下文快照和记忆文件提交进业务仓库。

4. 在支持 MCP 的客户端里配置本项目自带的 server：

   ```json
   {
     "mcpServers": {
       "trae-prompt-optimizer": {
         "command": "node",
         "args": [
           "E:/git storeplace/tot/tot/trae-prompt-optimizer-extension/mcp-server.js",
           "你的工作区绝对路径"
         ]
       }
     }
   }
   ```

MCP Server 暴露的工具：

- `get_prompt_optimizer_context`：读取最新 `context.json`。
- `get_prompt_optimizer_memory`：读取累计的 `memory.md`。
- `list_prompt_optimizer_context_files`：列出 `.trae/prompt-optimizer` 目录中的上下文文件。
- `read_workspace_file`：安全读取工作区内非敏感文件。

安全规则：MCP Server 会拒绝读取工作区外路径，并屏蔽 `.env*`、`.git`、`node_modules`、`dist`、secret/token/key/password/private-key 等敏感路径。

### API Provider 配置

插件面板内置多个 OpenAI-compatible 预设：

- OpenAI：`https://api.openai.com/v1`
- NVIDIA：`https://integrate.api.nvidia.com/v1`
- DeepSeek：`https://api.deepseek.com/v1`
- Gemini：`https://generativelanguage.googleapis.com/v1beta/openai`
- Kimi / Moonshot：`https://api.moonshot.cn/v1`
- Groq：`https://api.groq.com/openai/v1`
- OpenRouter：`https://openrouter.ai/api/v1`
- 豆包 / 火山方舟：`https://ark.cn-beijing.volces.com/api/v3`
- 豆包 Coding Plan：`https://ark.cn-beijing.volces.com/api/coding/v3`

如果使用 NVIDIA API Catalog：

1. 在插件面板的 `AI 提供商` 里选择 `NVIDIA`。
2. Base URL 会自动变成：

   ```text
   https://integrate.api.nvidia.com/v1
   ```

3. 在 `API Key` 输入框粘贴 NVIDIA API Key，点击 `保存 Key`。
4. 点击 `一键诊断`，插件会保存 Key、请求 `/models` 并把可用模型填到模型输入框的候选列表。
5. 选择或填写一个 NVIDIA 返回的模型 id，再点击 `开始计划` 或 `AI 提问式优化`。

常见问题：

- 不要把 Base URL 填成 `build.nvidia.com` 或网页地址。
- 不要继续用默认模型 `gpt-4o-mini` 调 NVIDIA。
- 如果某个旧模型 404，先点 `获取模型` 换成当前 API Key 可用的模型。
- 豆包/火山方舟不要把控制台展示名当成 API 模型 id；优先用 `获取模型` 返回的 id。
- Base URL 不要手动加 `/chat/completions`，插件会自动拼接。

`发送到 Trae` 按钮会复制优化结果，并尝试执行 `traePromptOptimizer.traeChatCommand` 配置的命令来打开聊天面板。默认值是 `workbench.action.chat.open`；如果 Trae 未来公开了专用命令 ID，可以在设置里替换。

## 兼容性说明

Trae 支持从 VS Code Marketplace 下载 `.vsix` 并拖入 Trae 安装。这个插件使用的是基础 VS Code Extension API，避免依赖较新的实验性能力，以降低 Trae 兼容风险。

当前仓库内置了离线 VSIX 打包脚本，不需要安装 `@vscode/vsce`。
