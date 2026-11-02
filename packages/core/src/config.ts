import { existsSync, readFileSync } from 'node:fs'
import { join } from 'pathe'
import { loadConfig as c12Load } from 'c12'
import { defu } from 'defu'
import { MpfConfig } from './schemas/config.ts'
import { mpfHome } from './paths.ts'

/**
 * Layered config: defaults <- ~/.mpf/config.json <- ./mpf.config.{ts,js,json} <- env.
 * Env: MPF_MODEL_GENERATE, MPF_MODEL_CRITIC, MPF_MODEL_CHEAP, MPF_BUDGET_USD, MPF_PORT,
 *      MPF_LLM_PROVIDER, MPF_LLM_BASE_URL, MPF_LLM_API_KEY_ENV (the key itself stays in its own
 *      variable: OPENAI_API_KEY, GEMINI_API_KEY, … or MPF_LLM_API_KEY),
 *      ANDROID_HOME / ANDROID_SDK_ROOT, JAVA_HOME, DEVELOPER_DIR.
 */
export async function loadConfig(cwd = process.cwd(), env = process.env): Promise<MpfConfig> {
  const userFile = join(mpfHome(env), 'config.json')
  const user = existsSync(userFile) ? safeJson(readFileSync(userFile, 'utf8')) : {}

  const { config: project } = await c12Load<Record<string, unknown>>({
    name: 'mpf',
    cwd,
    rcFile: false,
    globalRc: false,
    dotenv: false,
    packageJson: false,
  })

  const fromEnv: Record<string, unknown> = {
    models: compact({
      generate: env.MPF_MODEL_GENERATE,
      critic: env.MPF_MODEL_CRITIC,
      cheap: env.MPF_MODEL_CHEAP,
    }),
    llm: compact({
      provider: env.MPF_LLM_PROVIDER,
      baseUrl: env.MPF_LLM_BASE_URL,
      apiKeyEnv: env.MPF_LLM_API_KEY_ENV,
    }),
    budget: compact({ defaultUsd: num(env.MPF_BUDGET_USD) }),
    server: compact({ port: num(env.MPF_PORT), host: env.MPF_HOST }),
    toolchain: compact({
      androidHome: env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT,
      javaHome: env.JAVA_HOME,
      developerDir: env.DEVELOPER_DIR,
    }),
    dataDir: env.MPF_HOME,
  }

  return MpfConfig.parse(defu(compact(fromEnv), project ?? {}, user))
}

function safeJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)
      continue
    out[k] = v
  }
  return out as Partial<T>
}
