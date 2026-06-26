#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const UNLIMITED_SURF_MESSAGES_URL = "https://unlimited.surf/v1/messages";
const FALLBACK_MODELS = ["opus4.8", "opus4.7", "opus4.6"] as const;

type AskArgs = {
  question: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
};

type AnthropicTextBlock = {
  type: "text";
  text: string;
};

type AnthropicResponse = {
  content?: Array<AnthropicTextBlock | { type: string; [key: string]: unknown }>;
};

const server = new McpServer({
  name: "ask-claude-mcp",
  version: "0.1.0",
});

const inputSchema = z.object({
  question: z.string().min(1).describe("The question to ask the selected model."),
  systemPrompt: z.string().optional().describe("Optional system prompt."),
  temperature: z.number().min(0).max(1).optional().describe("Sampling temperature from 0 to 1."),
  maxTokens: z.number().int().min(1).max(8192).optional().describe("Maximum output tokens."),
});

server.registerTool(
  "ask_claude",
  {
    title: "Ask Claude",
    description:
      "Ask a single question through the fixed Unlimited Surf Claude messages endpoint. This tool only forwards the prompt and returns text; it does not provide tools, run agent loops, access files, execute commands, or perform actions.",
    inputSchema,
  },
  async (args: AskArgs) => {
    const answer = await askUnlimitedSurf(args);

    return {
      content: [{ type: "text", text: answer }],
    };
  },
);

async function askUnlimitedSurf(args: AskArgs): Promise<string> {
  const apiKey = requireEnv("UNLIMITED_SURF_API_KEY", "Unlimited Surf provider requires UNLIMITED_SURF_API_KEY.");
  const errors: string[] = [];

  for (const model of FALLBACK_MODELS) {
    try {
      const response = await fetchWithTimeout(UNLIMITED_SURF_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: args.maxTokens ?? 1024,
          temperature: args.temperature ?? 0.2,
          ...(args.systemPrompt ? { system: args.systemPrompt } : {}),
          messages: [{ role: "user", content: args.question }],
        }),
      });

      const json = (await parseJsonResponse(response)) as AnthropicResponse;
      const text = extractAnthropicText(json);

      if (!text) {
        throw new Error("Response did not contain text content.");
      }

      return text;
    } catch (error) {
      errors.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`All Unlimited Surf fallback models failed. ${errors.join(" | ")}`);
}

function extractAnthropicText(json: AnthropicResponse): string | undefined {
  return json.content
    ?.filter((block): block is AnthropicTextBlock => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Model API request failed with HTTP ${response.status}: ${truncate(text, 1000)}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Model API returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const timeoutMs = Number.parseInt(process.env.ASK_CLAUDE_TIMEOUT_MS ?? "60000", 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 60000);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Model API request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function requireEnv(name: string, message: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
