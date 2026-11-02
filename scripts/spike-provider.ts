/**
 * Prove a model provider works with the factory before spending a run on it.
 *
 *   pnpm tsx scripts/spike-provider.ts [--provider <name>] [--model <id>] [--base-url <url>] [--budget <usd>]
 *
 * Resolves the provider the way a run would (config, then these flags), then runs the same probe
 * a run uses before its first worker (`probeModel` in `@mpf/llm`): one worker in a scratch
 * workspace that must read a file, write another, run a shell command, and submit a structured
 * result, then one structured call, timed. Prints every event and the verdict, and exits non-zero
 * when the model would be refused.
 */
import { LlmSettings, defaultModelsFor, loadConfig, resolveLlm } from '@mpf/core'
import { describeProbe, probeModel, runAgent, type AgentRunOptions } from '@mpf/llm'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const config = await loadConfig()
const llmSettings = LlmSettings.parse({
  ...config.llm,
  ...(flag('--provider') ? { provider: flag('--provider') } : {}),
  ...(flag('--base-url') ? { baseUrl: flag('--base-url') } : {}),
})
const llm = resolveLlm(llmSettings)
const models = { ...defaultModelsFor(llm), ...definedEntries(config.models) }
const model = flag('--model') ?? models.generate
if (!model) {
  console.error(`${llm.label} has no default model; pass --model <id> or set models in the config`)
  process.exit(1)
}

console.log(`provider: ${llm.label}`)
if (llm.backend === 'openai-compatible')
  console.log(
    `key: ${llm.apiKey ? `set (${llm.apiKeyEnv})` : llm.local ? 'none needed' : `MISSING (${llm.apiKeyEnv})`}; reasoning parameter: ${llm.reasoning ? 'on' : 'off'}`,
  )
console.log(`model: ${model}\n`)

const probe = await probeModel({
  llm: llmSettings,
  model,
  maxBudgetUsd: Number(flag('--budget') ?? 1),
  agent: (opts: AgentRunOptions) =>
    runAgent({
      ...opts,
      onEvent: (e) => {
        switch (e.type) {
          case 'session':
            console.log(`session ${e.sessionId}`)
            break
          case 'message':
            console.log(`assistant: ${e.text.slice(0, 200)}`)
            break
          case 'tool_use':
            console.log(`tool_use ${e.tool} ${JSON.stringify(e.input).slice(0, 160)}`)
            break
          case 'tool_result':
            console.log(
              `tool_result ${e.tool} ${e.ok ? 'ok' : 'ERROR'}: ${e.summary.slice(0, 160).replace(/\n/g, ' | ')}`,
            )
            break
          case 'denied':
            console.log(`denied ${e.tool}: ${e.reason}`)
            break
        }
      },
    }),
})
console.log(`\n${describeProbe(probe)}`)
console.log(
  `\n${probe.level === 'error' ? 'REFUSED' : probe.level === 'warn' ? 'PASSED WITH WARNINGS' : 'PASSED'}: ${llm.label} with ${model}`,
)
process.exit(probe.level === 'error' ? 1 : 0)

function definedEntries<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}
