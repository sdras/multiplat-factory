/**
 * The OpenAI-compatible backend: the factory's own agent loop and structured call over the
 * chat-completions protocol, for every provider that is not Claude through the Agent SDK.
 */
export { runApiAgent } from './loop.ts'
export { apiStructuredCall } from './structured.ts'
export {
  ApiAbortError,
  ApiAuthError,
  ApiRequestError,
  chatCompletion,
  REQUEST_TIMEOUT_MS,
} from './client.ts'
export { TOOL_DEFINITIONS, TOOL_NAMES, executeTool, type ToolName } from './tools.ts'
export { loadSession, saveSession, sessionFile, type StoredSession } from './sessions.ts'
export type { ChatMessage, ChatRequest, ChatResponse, ToolCall, ToolDefinition } from './types.ts'
