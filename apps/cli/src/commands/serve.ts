import { defineCommand } from 'citty'
import { startDaemon, defaultDashboardDir } from '@mpf/server'
import { config, log } from './shared.ts'
import { cliVersion } from '../version.ts'

export const serveCommand = defineCommand({
  meta: { name: 'serve', description: 'Run the factory daemon (API + dashboard) until stopped' },
  args: {
    port: { type: 'string', description: 'Port (default from config, 4310)' },
    host: { type: 'string', description: 'Host (default 127.0.0.1)' },
  },
  async run({ args }) {
    const cfg = await config()
    if (args.port) cfg.server.port = Number(args.port)
    if (args.host) cfg.server.host = args.host
    const daemon = await startDaemon({ config: cfg, version: cliVersion() })
    const dash = defaultDashboardDir()
    log.success(`daemon listening at ${daemon.url}`)
    if (dash) log.info(`dashboard: ${daemon.url}`)
    else
      log.info(
        'dashboard not built here; `pnpm dev` serves it with hot reload on http://127.0.0.1:4311',
      )
    const stop = async () => {
      log.info('stopping…')
      await daemon.close()
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    await new Promise(() => {})
  },
})
