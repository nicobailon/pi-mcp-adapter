import { complete, type AssistantMessage, type Message, type Model, type TextContent } from "@mariozechner/pi-ai";
import { truncateAtWord } from "./utils.js";
import type { ExtensionUIContext, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CreateMessageRequestSchema,
  type CreateMessageRequest,
  type CreateMessageResult,
  type SamplingMessage,
  type SamplingMessageContentBlock,
} from "@modelcontextprotocol/sdk/types.js";

export interface SamplingHandlerOptions {
  serverName: string;
  autoApprove: boolean;
  ui?: ExtensionUIContext;
  modelRegistry: ModelRegistry;
  getCurrentModel: () => Model<any> | undefined;
  getSignal: () => AbortSignal | undefined;
}

export type ServerSamplingConfig = Omit<SamplingHandlerOptions, "serverName">;

export function registerSamplingHandler(client: Client, options: SamplingHandlerOptions): void {
  client.setRequestHandler(CreateMessageRequestSchema, (request) => {
    return handleSamplingRequest(options, request as CreateMessageRequest);
  });
}

export async function handleSamplingRequest(
  options: SamplingHandlerOptions,
  request: CreateMessageRequest,
): Promise<CreateMessageResult> {
  const params = request.params;

  if ("task" in params && params.task) {
    throw new Error("MCP sampling tasks are not supported");
  }
  if (params.includeContext && params.includeContext !== "none") {
    throw new Error("MCP sampling context inclusion is not supported");
  }
  if (params.tools?.length) {
    throw new Error("MCP sampling tool use is not supported");
  }
  if (params.toolChoice) {
    throw new Error("MCP sampling tool choice is not supported");
  }
  if (params.stopSequences?.length) {
    throw new Error("MCP sampling stop sequences are not supported");
  }

  const messages = params.messages.map(convertSamplingMessage);
  const { model, apiKey, headers } = await resolveSamplingModel(options);
  await confirmSampling(
    options,
    "Approve MCP sampling request",
    formatRequestApproval(options.serverName, `${model.provider}/${model.id}`, params.systemPrompt, messages),
  );

  const result = await complete(
    model,
    {
      systemPrompt: params.systemPrompt,
      messages,
    },
    {
      apiKey,
      headers,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      metadata: params.metadata as Record<string, unknown> | undefined,
      signal: options.getSignal(),
    },
  );

  const converted = convertAssistantResult(result);
  await confirmSampling(
    options,
    "Return MCP sampling response",
    formatResponseApproval(options.serverName, converted),
  );
  return converted;
}

function formatRequestApproval(
  serverName: string,
  modelName: string,
  systemPrompt: string | undefined,
  messages: Message[],
): string {
  const lines = [`${serverName} wants to sample ${messages.length} message${messages.length === 1 ? "" : "s"} with ${modelName}.`];
  if (systemPrompt) {
    lines.push(`System: ${truncateAtWord(systemPrompt, 400)}`);
  }
  for (const [index, message] of messages.entries()) {
    lines.push(`${index + 1}. ${message.role}: ${truncateAtWord(messageText(message), 400)}`);
  }
  return lines.join("\n\n");
}

function formatResponseApproval(serverName: string, response: CreateMessageResult): string {
  const text = response.content.type === "text" ? response.content.text : `[${response.content.type} content]`;
  return `${serverName} will receive this response from ${response.model}:\n\n${truncateAtWord(text, 1000)}`;
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "image") return `[image: ${block.mimeType}]`;
    if (block.type === "thinking") return "[thinking]";
    if (block.type === "toolCall") return `[tool call: ${block.name}]`;
    return "[content]";
  }).join("\n");
}

async function resolveSamplingModel(options: SamplingHandlerOptions): Promise<{
  model: Model<any>;
  apiKey?: string;
  headers?: Record<string, string>;
}> {
  const candidates: Model<any>[] = [];
  const currentModel = options.getCurrentModel();
  if (currentModel) candidates.push(currentModel);

  for (const model of options.modelRegistry.getAvailable()) {
    if (!candidates.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
      candidates.push(model);
    }
  }

  const errors: string[] = [];
  for (const model of candidates) {
    const auth = await options.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok === true) {
      return { model, apiKey: auth.apiKey, headers: auth.headers };
    }
    errors.push(`${model.provider}/${model.id}: ${auth.error}`);
  }

  if (errors.length > 0) {
    throw new Error(`No configured auth for MCP sampling model. ${errors.join("; ")}`);
  }
  throw new Error("No Pi model is available for MCP sampling");
}

async function confirmSampling(options: SamplingHandlerOptions, title: string, message: string): Promise<void> {
  if (options.autoApprove) return;
  if (!options.ui) {
    throw new Error("MCP sampling requires interactive approval. Set settings.samplingAutoApprove to true to allow it without UI.");
  }
  const approved = await options.ui.confirm(title, message);
  if (!approved) {
    throw new Error("MCP sampling request was declined");
  }
}

function convertSamplingMessage(message: SamplingMessage): Message {
  const blocks = Array.isArray(message.content) ? message.content : [message.content];
  if (message.role === "user") {
    return {
      role: "user",
      content: blocks.map(convertUserContent),
      timestamp: Date.now(),
    };
  }

  return {
    role: "assistant",
    content: blocks.map(convertAssistantContent),
    api: "mcp-sampling",
    provider: "mcp",
    model: "sampling-request",
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function convertUserContent(block: SamplingMessageContentBlock): TextContent {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  throw new Error(`MCP sampling ${block.type} content is not supported`);
}

function convertAssistantContent(block: SamplingMessageContentBlock): TextContent {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  throw new Error(`MCP sampling assistant ${block.type} content is not supported`);
}

function convertAssistantResult(message: AssistantMessage): CreateMessageResult {
  if (message.stopReason === "error") {
    throw new Error(message.errorMessage ?? "MCP sampling model call failed");
  }
  if (message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? "MCP sampling model call was aborted");
  }

  const text = message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return undefined;
      throw new Error(`MCP sampling result ${block.type} content is not supported`);
    })
    .filter((value): value is string => value !== undefined)
    .join("\n\n")
    .trim();

  if (!text) {
    throw new Error("MCP sampling result did not contain text content");
  }

  return {
    role: "assistant",
    content: { type: "text", text },
    model: `${message.provider}/${message.model}`,
    stopReason: mapStopReason(message.stopReason),
  };
}

function mapStopReason(reason: AssistantMessage["stopReason"]): CreateMessageResult["stopReason"] {
  if (reason === "stop") return "endTurn";
  if (reason === "length") return "maxTokens";
  if (reason === "toolUse") return "toolUse";
  return reason;
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}
