# askclaude-unlimitedsurf

一个标准 stdio MCP 服务器，只暴露一个 `ask_claude` 工具，用于把问题转发到固定 Unlimited Surf Messages 接口：

`https://unlimited.surf/v1/messages`

## 设计限制

- 支持单轮 `question` 和多轮 `messages` 对话。
- 默认模型固定为 `claude-opus-4-8-20260501`。
- 失败时自动降级：`claude-opus-4-8-20260501` → `claude-opus-4-7-20260101` → `claude-opus-4-6-20251201`。
- 请求上游时固定启用流式响应，降低长输出请求超时概率。
- 默认 `max_tokens` 为 `32000`，最多允许 `64000`。
- 除 API Key 和请求超时外，其它上游接口配置写死。
- 不支持 OpenAI。
- 不向下游模型暴露任何工具。
- 不执行代码、不读写文件、不访问除固定模型 API 以外的外部系统。
- 不实现 agent loop、计划执行、工具调用或自动操作能力。

## 安装

```bash
npm install
npm run build
```

## 配置

复制 `.env.example` 为 `.env`，或在 MCP 客户端环境变量中配置：

- `UNLIMITED_SURF_API_KEY`：Unlimited Surf API Key。
- `ASK_CLAUDE_TIMEOUT_MS`：请求超时，默认 `60000`，可选。

## VS Code MCP

项目已包含 `.vscode/mcp.json`。构建后即可在 VS Code 中启动/调试该 MCP 服务器。

## 工具

### `ask_claude`

参数：

- `question`：要询问的问题。
- `messages`：可选，多轮对话历史，元素格式为 `{ role: "user" | "assistant", content: string }`。提供 `messages` 时优先使用它。
- `systemPrompt`：可选，系统提示词。
- `temperature`：可选，0 到 1。
- `maxTokens`：可选，默认 32000，最大 64000。

返回：模型的纯文本回答。
