import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mpfHome } from '@mpf/core'
import { join } from 'pathe'
import type { ChatMessage } from './types.ts'

/**
 * A worker session of the OpenAI-compatible backend: the transcript a later call can resume, with
 * the cumulative cost and turn count the way the Agent SDK reports them for a resumed session.
 */
export interface StoredSession {
  id: string
  model: string
  messages: ChatMessage[]
  costUsd: number
  turns: number
  updatedAt: string
}

/** Image data URLs above this size are replaced by a placeholder in the stored file. */
export const STORED_IMAGE_MAX_BYTES = 2 * 1024 * 1024
const IMAGE_PLACEHOLDER = '[image omitted from the stored session]'

export function sessionsDir(env: NodeJS.ProcessEnv): string {
  return join(mpfHome(env), 'sessions')
}

export function sessionFile(env: NodeJS.ProcessEnv, id: string): string {
  return join(sessionsDir(env), `${id}.json`)
}

export function saveSession(env: NodeJS.ProcessEnv, session: StoredSession): void {
  const dir = sessionsDir(env)
  mkdirSync(dir, { recursive: true })
  const file = sessionFile(env, session.id)
  const stored: StoredSession = {
    ...session,
    messages: session.messages.map(withoutLargeImages),
    updatedAt: new Date().toISOString(),
  }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(stored)}\n`)
  renameSync(tmp, file)
}

export function loadSession(env: NodeJS.ProcessEnv, id: string): StoredSession {
  const file = sessionFile(env, id)
  if (!existsSync(file))
    throw new Error(
      `session ${id} not found at ${file}: it may belong to another backend or another MPF_HOME`,
    )
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`session ${id} at ${file} is not readable: ${(err as Error).message}`, {
      cause: err,
    })
  }
  const s = parsed as Partial<StoredSession> | null
  if (!s || typeof s !== 'object' || !Array.isArray(s.messages) || typeof s.id !== 'string')
    throw new Error(`session ${id} at ${file} has an unexpected shape`)
  return {
    id: s.id,
    model: typeof s.model === 'string' ? s.model : '',
    messages: s.messages,
    costUsd: typeof s.costUsd === 'number' ? s.costUsd : 0,
    turns: typeof s.turns === 'number' ? s.turns : 0,
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : '',
  }
}

function withoutLargeImages(message: ChatMessage): ChatMessage {
  if (message.role !== 'user' || typeof message.content === 'string') return message
  if (
    !message.content.some(
      (p) => p.type === 'image_url' && p.image_url.url.length > STORED_IMAGE_MAX_BYTES,
    )
  )
    return message
  return {
    role: 'user',
    content: message.content.map((p) =>
      p.type === 'image_url' && p.image_url.url.length > STORED_IMAGE_MAX_BYTES
        ? { type: 'text', text: IMAGE_PLACEHOLDER }
        : p,
    ),
  }
}
