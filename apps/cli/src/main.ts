#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'
import {
  answerCommand,
  instructCommand,
  rerunCommand,
  resumeCommand,
  statusCommand,
} from './commands/control.ts'
import { doctorCommand } from './commands/doctor.ts'
import { portCommand } from './commands/port.ts'
import { runsCommand } from './commands/runs.ts'
import { serveCommand } from './commands/serve.ts'
import { setupCommand } from './commands/setup.ts'

const main = defineCommand({
  meta: {
    name: 'mpf',
    version: '0.1.0',
    description: 'multiplat-factory: port an app from web, iOS, or Android to the other platforms',
  },
  subCommands: {
    doctor: doctorCommand,
    setup: setupCommand,
    serve: serveCommand,
    port: portCommand,
    runs: runsCommand,
    status: statusCommand,
    resume: resumeCommand,
    answer: answerCommand,
    rerun: rerunCommand,
    instruct: instructCommand,
  },
})

runMain(main)
