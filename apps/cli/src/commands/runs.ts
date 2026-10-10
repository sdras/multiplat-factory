import { defineCommand } from 'citty'
import type { Run } from '@mpf/core'
import { api, config, describeRun, ensureDaemon } from './shared.ts'

export const runsCommand = defineCommand({
  meta: { name: 'runs', description: 'List runs' },
  async run() {
    const cfg = await config()
    const { url, embedded } = await ensureDaemon(cfg)
    try {
      const runs = await api<Run[]>(url, '/runs')
      if (!runs.length) console.log('no runs yet')
      for (const r of runs) console.log(describeRun(r))
    } finally {
      await embedded?.close()
    }
  },
})
