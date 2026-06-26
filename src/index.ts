#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const UNLIMITED_SURF_MESSAGES_URL = "https://unlimited.surf/v1/messages";
const FALLBACK_MODELS = [
  "claude-opus-4-8-20260501",
  "claude-opus-4-7-20260101",
  "claude-opus-4-6-20251201",
] as const;
const DEFAULT_MAX_TOKENS = 32000;
const MAX_ALLOWED_TOKENS = 64000;

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]).describe("Conversation message role."),
  content: z.string().min(1).describe("Conversation message content."),
});

type ConversationMessage = z.infer<typeof messageSchema>;

type AskArgs = {
  question?: string;
  messages?: ConversationMessage[];
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

type AnthropicStreamEvent = {
  type?: string;
  delta?: {
    type?: string;
    text?: string;
  };
  content_block?: {
    type?: string;
    text?: string;
  };
  error?: {
    type?: string;
    message?: string;
  };
};

const server = new McpServer({
  name: "ask-claude-mcp",
  version: "0.1.0",
});

const inputSchema = z
  .object({
    question: z.string().min(1).optional().describe("Single-turn user question. Use messages for multi-turn chat."),
    messages: z
      .array(messageSchema)
      .min(1)
      .optional()
      .describe("Multi-turn conversation history. The final message should usually be a user message."),
    systemPrompt: z.string().optional().describe("Optional system prompt."),
    temperature: z.number().min(0).max(1).optional().describe("Sampling temperature from 0 to 1."),
    maxTokens: z
      .number()
      .int()
      .min(1)
      .max(MAX_ALLOWED_TOKENS)
      .optional()
      .describe(`Maximum output tokens. Defaults to ${DEFAULT_MAX_TOKENS}.`),
  })
  .refine((value) => Boolean(value.question) || Boolean(value.messages?.length), {
    message: "Either question or messages must be provided.",
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
          accept: "text/event-stream",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: Math.min(args.maxTokens ?? DEFAULT_MAX_TOKENS, MAX_ALLOWED_TOKENS),
          temperature: args.temperature ?? 0.2,
          stream: true,
          ...(args.systemPrompt ? { system: args.systemPrompt } : {}),
          messages: toAnthropicMessages(args),
        }),
      });

      const text = await parseMessageResponse(response);

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

function toAnthropicMessages(args: AskArgs): ConversationMessage[] {
  if (args.messages?.length) {
    return args.messages;
  }

  if (args.question) {
    return [{ role: "user", content: args.question }];
  }

  throw new Error("Either question or messages must be provided.");
}

async function parseMessageResponse(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    return parseSseResponse(response);
  }

  const json = (await parseJsonResponse(response)) as AnthropicResponse;
  const text = extractAnthropicText(json);

  if (!text) {
    throw new Error("Response did not contain text content.");
  }

  return text;
}

async function parseSseResponse(response: Response): Promise<string> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Model API request failed with HTTP ${response.status}: ${truncate(errorText, 1000)}`);
  }

  if (!response.body) {
    throw new Error("Streaming response did not contain a body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      output += parseSseFrame(frame);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    output += parseSseFrame(buffer);
  }

  const text = output.trim();
  if (!text) {
    throw new Error("Streaming response did not contain text content.");
  }

  return text;
}

function parseSseFrame(frame: string): string {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");

  if (!data || data === "[DONE]") {
    return "";
  }

  const event = JSON.parse(data) as AnthropicStreamEvent;

  if (event.type === "error") {
    throw new Error(event.error?.message ?? event.error?.type ?? "Unknown streaming error.");
  }

  if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
    return event.delta.text ?? "";
  }

  if (event.type === "content_block_start" && event.content_block?.type === "text") {
    return event.content_block.text ?? "";
  }

  return "";
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
