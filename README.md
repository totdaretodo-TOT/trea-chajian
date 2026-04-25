# Trae Prompt Optimizer

一个面向 Trae 的提示词优化插件。它把粗略的编程需求整理成结构化、可执行、可复制的工程提示词，适合 Go 后端、React/TypeScript 前端、DevOps 平台、CI/CD、代码托管、Artifact Registry 等项目。

## 功能

- 在命令面板打开 `Trae Prompt Optimizer: Open`。
- 在编辑器里选中文本后右键运行 `Trae Prompt Optimizer: Optimize Selection`。
- 根据项目类型、执行强度和关注领域自动生成工程化提示词。
- 一键复制、插入编辑器、导出 Markdown。
- 一键复制并尝试打开 Trae Chat，方便粘贴发送。
- 可选接入 OpenAI-compatible API，进行 AI 二次优化。
- 一键保存到工作区 `.trae/rules/harness-blueprint-prompt.md`，方便作为 Trae 规则或项目提示词继续使用。
- 默认本地运行，不调用外部 API；只有点击 `AI 二次优化` 并配置 API Key 后才会把提示词发送到你设置的模型服务。

## 安装到 Trae

1. 在本目录运行：

   ```bash
   npm run package
   ```

2. 得到 `trae-prompt-optimizer-0.2.0.vsix`。
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
- 当前任务
- 目标
- 执行规则
- 验收标准
- 建议验证
- 最终回复格式

## AI 二次优化

插件不会直接调用 Trae 内置 AI，因为 Trae 目前没有公开稳定的第三方插件调用接口。

如果你想让模型自动润色提示词，可以配置 OpenAI-compatible API：

1. 运行命令 `Trae Prompt Optimizer: Set AI API Key`，API Key 会保存在 SecretStorage。
2. 在设置里调整：
   - `traePromptOptimizer.ai.baseUrl`
   - `traePromptOptimizer.ai.model`
   - `traePromptOptimizer.ai.systemPrompt`
3. 在插件面板点击 `AI 二次优化`。

`发送到 Trae` 按钮会复制优化结果，并尝试执行 `traePromptOptimizer.traeChatCommand` 配置的命令来打开聊天面板。默认值是 `workbench.action.chat.open`；如果 Trae 未来公开了专用命令 ID，可以在设置里替换。

## 兼容性说明

Trae 支持从 VS Code Marketplace 下载 `.vsix` 并拖入 Trae 安装。这个插件使用的是基础 VS Code Extension API，避免依赖较新的实验性能力，以降低 Trae 兼容风险。

当前仓库内置了离线 VSIX 打包脚本，不需要安装 `@vscode/vsce`。
