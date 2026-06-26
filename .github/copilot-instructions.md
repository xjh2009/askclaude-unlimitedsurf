# Copilot Instructions

This workspace implements a TypeScript Model Context Protocol server.

References:

- MCP TypeScript SDK: `@modelcontextprotocol/sdk`
- Server implementation should follow the SDK `McpServer` + `StdioServerTransport` pattern.
- Register tools with Zod input schemas and return MCP `content` arrays.

Project-specific constraints:

- The package is named `askclaude-unlimitedsurf`; the MCP server name remains `ask-claude-mcp`.
- It must only expose ask-style model calls.
- It must use only the fixed Unlimited Surf messages endpoint `https://unlimited.surf/v1/messages`.
- It must default to `opus4.8` and automatically fall back through `opus4.7` to `opus4.6`.
- Do not add OpenAI support, agent loops, recursive tool calls, filesystem access, shell execution, browser automation, or arbitrary network access beyond the fixed model API endpoint.
