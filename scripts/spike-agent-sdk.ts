/**
 * M1 spike: can a plain Node process drive a Claude Agent SDK worker with the
 * user's Claude Code login, a sandbox policy, a budget, and structured output?
 *
 *   MPF_SPIKE_DIR=/tmp/spike pnpm tsx scripts/spike-agent-sdk.ts
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { z } from 'zod'
import { runAgent } from '@mpf/llm'

const dir = process.env.MPF_SPIKE_DIR ?? join(tmpdir(), `mpf-spike-${Date.now()}`)
mkdirSync(dir, { recursive: true })

const Output = z.object({ created: z.string(), lineCount: z.number().int() })

const result = await runAgent({
  cwd: dir,
  model: process.env.MPF_MODEL_CHEAP ?? 'claude-sonnet-5',
  effort: 'low',
  maxTurns: 6,
  maxBudgetUsd: 0.25,
  bashAllow: [/^wc\b/, /^ls\b/, /^cat\b/],
  outputSchema: Output,
  systemPrompt:
    'You are a build worker inside a sandboxed workspace. Do exactly what is asked and nothing else.',
  prompt:
    'Create a file named hello.txt in the current directory containing three lines: "one", "two", "three". ' +
    'Then run `wc -l hello.txt`. Also try to read /etc/hosts once (it should be denied; move on). ' +
    'Finish by reporting the created file name and its line count.',
  onEvent: (e) => console.log('[event]', JSON.stringify(e).slice(0, 200)),
})

console.log('\n[result]', JSON.stringify(result, null, 2))
console.log('[workspace]', dir)
process.exit(result.ok ? 0 : 1)
