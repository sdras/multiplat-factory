import { existsSync, readFileSync, readdirSync, writeFileSync, type Dirent } from 'node:fs'
import { join } from 'pathe'
import type {
  AppSpec,
  BehaviorSpec,
  PortPlan,
  Stage,
  Target,
  TestResult,
  TestResultTarget,
  Verdict,
} from '@mpf/core'
import type { StageContext, StageOutcome, StageRunner } from '@mpf/harness'
import {
  getTargetAdapter,
  type TargetAdapter,
  type TargetContext,
  type TargetDocs,
} from '@mpf/adapters'

export interface ReportDeps {
  adapterFor?: (target: Target) => TargetAdapter | undefined
}

/** One line per target, shown on the run and written to report.json. */
export interface TargetReport {
  target: Target
  outcome: 'succeeded' | 'partial' | 'blocked' | 'skipped' | 'not run'
  headline: string
  readme?: string
  product?: string
  /** The identifier the shipped app carries (application id, bundle id, package name), read from the workspace. */
  appId?: string
  /** Project files in the workspace, build output excluded. */
  files?: number
  tests: { kind: string; status: string; passed: number; total: number; flaky: number }[]
  critic?: { decision: string; round: number; average: number; blocking: number; advisory: number }
}

/** The generation worker's structured result, as persisted by the generate stage (`generate-<target>.json`). */
interface WorkerSummary {
  filesWritten?: string[]
  deviations?: { what: string; why: string }[]
  notes?: string
  behaviorsCovered?: string[]
}

type ShippedLayout = NonNullable<TargetDocs['shipped']>

/** The project files a target workspace holds, grouped the way its adapter describes the project. */
interface ShippedFiles {
  total: number
  all: string[]
  groups: { title: string; files: string[] }[]
}

/** Entries no workspace listing should include: VCS metadata, Finder droppings, and the report itself. */
const ALWAYS_EXCLUDE = [/(^|\/)(\.git|\.DS_Store)(\/|$)/, /^PORT\.md$/]
/** Longer groups are rolled up by directory so a few hundred files stay readable. */
const FILE_LIST_CAP = 40
const NAMES_PER_DIR = 6

/**
 * Walk the workspace for the files that make up the project: everything except what the
 * adapter marks as build output or captured evidence. Grouping follows the adapter's layout
 * (sources, tests, flows); anything else lands in "Project files".
 */
function shippedFiles(workspace: string, layout: ShippedLayout | undefined): ShippedFiles {
  const exclude = [...ALWAYS_EXCLUDE, ...(layout?.exclude ?? [])]
  const all: string[] = []
  const walk = (rel: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(join(workspace, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (exclude.some((p) => p.test(path))) continue
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) all.push(path)
    }
  }
  walk('')
  all.sort()
  const patterns = layout?.groups ?? []
  const groups = [
    ...patterns.map((g) => ({ title: g.title, files: [] as string[] })),
    { title: 'Project files', files: [] as string[] },
  ]
  for (const f of all) {
    const i = patterns.findIndex((g) => g.pattern.test(f))
    groups[i >= 0 ? i : groups.length - 1]!.files.push(f)
  }
  return { total: all.length, all, groups: groups.filter((g) => g.files.length) }
}

/** One line per file, or one line per directory once a group outgrows the cap. */
function fileLines(files: string[]): string[] {
  if (files.length <= FILE_LIST_CAP) return files.map((f) => `- \`${f}\``)
  const byDir = new Map<string, string[]>()
  for (const f of files) {
    const cut = f.lastIndexOf('/')
    const dir = cut >= 0 ? f.slice(0, cut + 1) : './'
    byDir.set(dir, [...(byDir.get(dir) ?? []), f.slice(cut + 1)])
  }
  const dirs = [...byDir.entries()]
  const lines = dirs
    .slice(0, FILE_LIST_CAP)
    .map(
      ([dir, names]) =>
        `- \`${dir}\` (${names.length}): ${names.slice(0, NAMES_PER_DIR).join(', ')}${names.length > NAMES_PER_DIR ? `, … ${names.length - NAMES_PER_DIR} more` : ''}`,
    )
  if (dirs.length > FILE_LIST_CAP)
    lines.push(`- … and ${dirs.length - FILE_LIST_CAP} more directories`)
  return lines
}

/** Workers report paths as they please: absolute, `./`-prefixed, or workspace-relative. */
function normalizeWorkerPath(path: string, workspace: string): string {
  let p = path.trim().replace(/\\/g, '/')
  if (p.startsWith(`${workspace}/`)) p = p.slice(workspace.length + 1)
  return p.replace(/^\.\//, '').replace(/\/+$/, '')
}

/** Where a file the plan proposed ended up: the exact path, the same file name elsewhere, or nowhere. */
function shippedPath(
  planned: string,
  files: string[],
): { status: 'exact' | 'moved' | 'missing'; path?: string } {
  const norm = planned.trim().replace(/^\.\//, '')
  if (files.includes(norm)) return { status: 'exact', path: norm }
  const base = norm.slice(norm.lastIndexOf('/') + 1)
  const match = base ? files.find((f) => f === base || f.endsWith(`/${base}`)) : undefined
  return match ? { status: 'moved', path: match } : { status: 'missing' }
}

const STAGE_ORDER = ['generate', 'build', 'test', 'critique', 'fix'] as const

function stagesFor(
  ctx: StageContext,
  target: Target,
): Map<(typeof STAGE_ORDER)[number], Stage | undefined> {
  return new Map(STAGE_ORDER.map((k) => [k, ctx.store.getStage(ctx.run.id, `${k}:${target}`)]))
}

function latestTests(ctx: StageContext, target: TestResultTarget): TestResult[] {
  const byKind = new Map<string, TestResult>()
  for (const e of ctx.store.listAllEvents(ctx.run.id))
    if (e.type === 'test.result' && e.result.target === target) byKind.set(e.result.kind, e.result)
  return [...byKind.values()]
}

function latestVerdict(ctx: StageContext, target: Target): Verdict | undefined {
  return ctx.store
    .listArtifacts(ctx.run.id)
    .filter((a) => a.kind === 'verdict' && a.meta.target === target)
    .map((a) => JSON.parse(readFileSync(join(ctx.run.runDir, a.relPath), 'utf8')) as Verdict)
    .sort((a, b) => a.round - b.round)
    .at(-1)
}

/** Finding ids a human accepted: one by one through a control payload, or all remaining ones when a critic escalation was accepted. */
function acceptedFindings(ctx: StageContext): Set<string> {
  const accepted = new Set<string>()
  for (const e of ctx.store.listAllEvents(ctx.run.id)) {
    if (
      e.type === 'control' &&
      e.action === 'approve' &&
      typeof e.payload.acceptFinding === 'string'
    )
      accepted.add(e.payload.acceptFinding)
  }
  for (const stage of ctx.store.listStages(ctx.run.id)) {
    if (stage.kind !== 'critique') continue
    const list = stage.result?.acceptedDeviations
    if (!Array.isArray(list)) continue
    for (const item of list as { id?: unknown }[])
      if (typeof item?.id === 'string') accepted.add(item.id)
  }
  return accepted
}

interface CoreSummary {
  bytes: number
  functions: string[]
  parity: { host: string; passed: number; total: number; failed: number }[]
}

/** The built core and its parity results from the core stages, if this run has one. */
function coreSummary(ctx: StageContext): CoreSummary | undefined {
  const wasm = ctx.store.listArtifacts(ctx.run.id).find((a) => a.kind === 'wasm-module')
  if (!wasm) return undefined
  const parity: CoreSummary['parity'] = []
  for (const e of ctx.store.listAllEvents(ctx.run.id)) {
    if (
      e.type === 'test.result' &&
      e.result.kind === 'parity' &&
      e.result.stageId === 'core.build'
    ) {
      const host =
        e.result.target === 'core' ? 'rust (cargo test)' : `${e.result.target} host (node)`
      const idx = parity.findIndex((p) => p.host === host)
      const row = {
        host,
        passed: e.result.summary.passed,
        total: e.result.summary.total,
        failed: e.result.summary.failed,
      }
      if (idx >= 0) parity[idx] = row
      else parity.push(row)
    }
  }
  return {
    bytes: Number(wasm.meta.bytes ?? 0),
    functions: Array.isArray(wasm.meta.functions) ? (wasm.meta.functions as string[]) : [],
    parity,
  }
}

function outcomeFor(
  stages: Map<string, Stage | undefined>,
  verdict: Verdict | undefined,
): TargetReport['outcome'] {
  const generate = stages.get('generate')
  if (!generate || generate.status === 'pending') return 'not run'
  if (generate.status === 'skipped') return 'skipped'
  for (const k of ['generate', 'build', 'test'] as const) {
    const st = stages.get(k)?.status
    if (st === 'blocked' || st === 'failed' || st === 'cancelled') return 'blocked'
  }
  if (stages.get('test')?.status !== 'succeeded') return 'partial'
  const critique = stages.get('critique')?.status
  if (critique === 'blocked' || critique === 'failed' || critique === 'waiting_human')
    return 'partial'
  if (verdict && verdict.decision !== 'pass' && critique !== 'succeeded') return 'partial'
  return 'succeeded'
}

function average(v: Verdict): number {
  const s = v.scores
  return (
    Math.round(
      ((s.fidelity + s.idiomatic + s.testAdequacy + s.parityDocs + s.buildHealth) / 5) * 10,
    ) / 10
  )
}

function headlineFor(
  outcome: TargetReport['outcome'],
  stages: Map<string, Stage | undefined>,
  tests: TestResult[],
  verdict: Verdict | undefined,
): string {
  if (outcome === 'not run') return 'not run'
  if (outcome === 'skipped')
    return `skipped (${stages.get('generate')?.skipReason ?? 'no reason recorded'})`
  if (outcome === 'blocked') {
    const failed = (['generate', 'build', 'test'] as const)
      .map((k) => stages.get(k))
      .find((s) => s && ['blocked', 'failed', 'cancelled'].includes(s.status))
    return `blocked at ${failed?.kind ?? '?'}${failed?.error ? `: ${failed.error.message.split('\n')[0]}` : ''}`
  }
  const parts: string[] = []
  const e2e = tests.find((t) => t.kind === 'e2e')
  const unit = tests.find((t) => t.kind === 'unit')
  if (e2e && e2e.summary.total) parts.push(`${e2e.summary.passed}/${e2e.summary.total} flows`)
  if (unit && unit.summary.total) parts.push(`${unit.summary.passed}/${unit.summary.total} unit`)
  if (verdict) parts.push(`critic ${verdict.decision} ${average(verdict)}/5`)
  else if (stages.get('critique')?.status === 'skipped') parts.push('no critic')
  if (outcome === 'partial') parts.unshift('partial')
  return parts.join(', ') || 'succeeded'
}

function testTable(tests: TestResult[]): string[] {
  if (!tests.length) return ['- no tests ran']
  return tests.map(
    (r) =>
      `- ${r.kind}: ${r.status} ${r.summary.passed}/${r.summary.total}${r.summary.flaky ? `, ${r.summary.flaky} flaky` : ''}${r.skipReason ? ` (${r.skipReason})` : ''}`,
  )
}

function commandBlock(docs: TargetDocs | undefined): string[] {
  if (!docs) return ['_See the project README._']
  const lines = [`# build\n${docs.build}`, `# unit tests\n${docs.unitTest}`]
  if (docs.e2e) lines.push(`# end-to-end flows compiled from the BehaviorSpec\n${docs.e2e}`)
  return ['```bash', lines.join('\n\n'), '```']
}

function portMarkdown(input: {
  spec: AppSpec
  behaviors: BehaviorSpec
  plan: PortPlan
  target: Target
  stages: Map<string, Stage | undefined>
  tests: TestResult[]
  /** The source app's own suite, run by the observe stage. */
  sourceTests?: TestResult
  verdict?: Verdict
  accepted: Set<string>
  docs?: TargetDocs
  worker?: WorkerSummary
  product?: string
  screenshots: { screenId: string; rel: string }[]
  core?: CoreSummary
  /** Absolute path of the target workspace. */
  workspace: string
  files: ShippedFiles
}): string {
  const {
    spec,
    behaviors,
    plan,
    target,
    stages,
    tests,
    sourceTests,
    verdict,
    accepted,
    docs,
    worker,
    product,
    screenshots,
    core,
    workspace,
    files,
  } = input
  const tp = plan.targets.find((t) => t.target === target)!
  const appId = docs?.shipped?.appId
  const appIdPhrase = appId
    ? `${appId.label} \`${appId.value}\`${appId.file ? ` (read from \`${appId.file}\`)` : ' (the scaffold default; no project file declares one)'}`
    : undefined
  const reported = [
    ...new Set((worker?.filesWritten ?? []).map((p) => normalizeWorkerPath(p, workspace))),
  ]
  const present = new Set(files.all)
  const reportedMissing = reported.filter((p) => !present.has(p))
  const shippedColumn = (planned: string) => {
    const hit = shippedPath(planned, files.all)
    if (hit.status === 'exact') return 'yes'
    if (hit.status === 'moved') return `yes, as \`${hit.path}\``
    return 'no'
  }
  const caseStatus = new Map<string, string>()
  for (const r of tests)
    for (const c of r.cases) if (c.behaviorId) caseStatus.set(c.behaviorId, c.status)
  const covered = new Set(worker?.behaviorsCovered ?? [])
  const deviations = [
    ...tp.deviations.map((d) => ({ what: d.what, why: d.why, accepted: d.accepted })),
    ...(worker?.deviations ?? []).map((d) => ({ what: d.what, why: d.why, accepted: false })),
  ]
  const blocking = verdict?.findings.filter((f) => f.severity === 'blocking') ?? []
  const advisory = verdict?.findings.filter((f) => f.severity !== 'blocking') ?? []
  const findingLine = (f: Verdict['findings'][number]) =>
    `- ${accepted.has(f.id) ? '(accepted) ' : ''}**${f.category}**${f.behaviorId ? ` ${f.behaviorId}` : ''}${f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''}: ${f.description}${f.suggestedFix ? ` _Suggested: ${f.suggestedFix}_` : ''}`
  return [
    `# ${spec.name} — ${target} port`,
    '',
    `Generated by multiplat-factory from the ${spec.source.platform} app (${spec.source.framework}, ${spec.source.language}). UI: ${tp.uiFramework}.${appIdPhrase ? ` ${appIdPhrase}.` : ''} ${files.total} project file${files.total === 1 ? '' : 's'} in the workspace (build output excluded).`,
    '',
    '## Status',
    '',
    ...STAGE_ORDER.map((k) => {
      const s = stages.get(k)
      return `- ${k}: ${s?.status ?? 'not run'}${s?.error ? ` (${s.error.message.split('\n')[0]})` : ''}${s?.skipReason ? ` (${s.skipReason})` : ''}`
    }),
    ...testTable(tests),
    ...(product ? ['', `Product: \`${product}\``] : []),
    '',
    '## Build and test',
    '',
    ...commandBlock(docs),
    '',
    ...(docs?.notes.length ? ['### Conventions', '', ...docs.notes.map((n) => `- ${n}`), ''] : []),
    '## What shipped',
    '',
    `${appIdPhrase ? `${appIdPhrase}. ` : ''}${files.total} project file${files.total === 1 ? '' : 's'} under the workspace, listed from the tree itself (build output, caches, and captured evidence left out).${
      worker?.filesWritten
        ? ` The generation worker reported writing ${reported.length} file${reported.length === 1 ? '' : 's'}${
            reportedMissing.length
              ? `; ${reportedMissing.length} of them ${reportedMissing.length === 1 ? 'is' : 'are'} not in the workspace: ${reportedMissing
                  .slice(0, 10)
                  .map((p) => `\`${p}\``)
                  .join(
                    ', ',
                  )}${reportedMissing.length > 10 ? `, … ${reportedMissing.length - 10} more` : ''}.`
              : ', all present.'
          }`
        : ''
    }`,
    '',
    ...files.groups.flatMap((g) => [
      `### ${g.title} (${g.files.length})`,
      '',
      ...fileLines(g.files),
      '',
    ]),
    ...(files.total ? [] : ['_The workspace holds no project files._', '']),
    '## Architecture map',
    '',
    `Planned layout (from the PortPlan, before generation): ${tp.layout}`,
    '',
    '### Screen map as planned',
    '',
    'Target files are what the plan proposed; the last column says whether that file exists in the shipped workspace (see What shipped for the real tree).',
    '',
    '| Source screen | Planned target file | Shipped | Notes |',
    '|---|---|---|---|',
    ...tp.screenMap.map(
      (m) => `| \`${m.screen}\` | \`${m.file}\` | ${shippedColumn(m.file)} | ${m.notes ?? ''} |`,
    ),
    '',
    `State (as planned): ${tp.stateStrategy}`,
    '',
    '## Persistence and wire-format pins',
    '',
    ...(tp.persistenceMap.length
      ? tp.persistenceMap.map(
          (p) =>
            `- \`${p.sourceKey}\` → ${p.mechanism}${p.sameWireFormat ? ' (same wire format)' : ' (format changes)'}`,
        )
      : ['- none']),
    ...spec.state.persistence.flatMap((p) =>
      p.keys
        .filter((k) => k.wireFormatPins.length)
        .map((k) => `- pin \`${k.key}\`: ${k.wireFormatPins.join('; ')}`),
    ),
    '',
    '## Behaviors',
    '',
    '| Id | Behavior | Priority | Verified on source | On target |',
    '|---|---|---|---|---|',
    ...behaviors.behaviors.map(
      (b) =>
        `| ${b.id} | ${b.title} | ${b.priority} | ${b.verifiedOnSource ? 'yes' : 'no'} | ${caseStatus.get(b.id) ?? (covered.has(b.id) ? 'implemented, not run' : 'not run')} |`,
    ),
    '',
    ...(sourceTests
      ? [
          `Source's own test suite before porting: ${sourceTests.status} ${sourceTests.summary.passed}/${sourceTests.summary.total}${sourceTests.skipReason ? ` (${sourceTests.skipReason})` : ''}.`,
          '',
        ]
      : []),
    '## Intentional parity quirks and invariants',
    '',
    ...(behaviors.invariants.length
      ? behaviors.invariants.map((i) => `- ${i}`)
      : ['- none recorded']),
    '',
    '## Deviations',
    '',
    ...(deviations.length
      ? deviations.map((d) => `- ${d.accepted ? '(accepted) ' : ''}**${d.what}** — ${d.why}`)
      : ['- none']),
    '',
    '## Critic',
    '',
    ...(verdict
      ? [
          `Round ${verdict.round}: **${verdict.decision}** (confidence ${verdict.confidence.toFixed(2)}). Fidelity ${verdict.scores.fidelity}, idiomatic ${verdict.scores.idiomatic}, test adequacy ${verdict.scores.testAdequacy}, parity docs ${verdict.scores.parityDocs}, build health ${verdict.scores.buildHealth} (of 5).`,
          '',
          verdict.summary,
          '',
          ...(blocking.length
            ? ['### Unresolved blocking findings', '', ...blocking.map(findingLine), '']
            : []),
          ...(advisory.length
            ? ['### Advisory findings', '', ...advisory.map(findingLine), '']
            : []),
        ]
      : [`- ${stages.get('critique')?.skipReason ?? 'no verdict recorded'}`, '']),
    '## Shared core',
    '',
    ...(core
      ? [
          `One WebAssembly module (\`mpf_core.wasm\`, ${(core.bytes / 1024).toFixed(1)} KiB) implements ${core.functions.map((f) => `\`${f}\``).join(', ')}; this target calls it through a generated host binding instead of reimplementing the logic (see docs/ABI.md in the factory).`,
          '',
          '| Host | Vectors |',
          '|---|---|',
          ...core.parity.map(
            (p) =>
              `| ${p.host} | ${p.passed}/${p.total}${p.failed ? ` (${p.failed} failing)` : ''} |`,
          ),
          ...tests
            .filter((t) => t.kind === 'parity')
            .map(
              (t) =>
                `| ${target} | ${t.summary.passed}/${t.summary.total}${t.summary.failed ? ` (${t.summary.failed} failing)` : ''} |`,
            ),
        ]
      : [`- none (${plan.core.rationale})`]),
    '',
    '## Screens',
    '',
    ...(screenshots.length
      ? screenshots.map((s) => `- \`${s.screenId}\`: ![${s.screenId}](${s.rel})`)
      : ['- no screenshots captured']),
    '',
    '## Integrations',
    '',
    ...(tp.integrationMap.length
      ? tp.integrationMap.map((i) => `- ${i.kind}: ${i.decision} — ${i.rationale}`)
      : ['- none']),
    '',
    '## Open questions from the plan',
    '',
    ...(plan.questionsForHuman.length ? plan.questionsForHuman.map((q) => `- ${q}`) : ['- none']),
    ...(worker?.notes ? ['', '## Notes from the generation worker', '', worker.notes] : []),
    '',
  ].join('\n')
}

/**
 * Deterministic report: one PORT.md per target workspace (status, how to build, the
 * architecture map, behavior coverage, deviations, the critic's verdict), a
 * report.json for the dashboard, and a one-line run summary. No LLM involved.
 */
export function reportStage(deps: ReportDeps = {}): StageRunner {
  const adapterFor = deps.adapterFor ?? getTargetAdapter
  return {
    async run(ctx: StageContext): Promise<StageOutcome> {
      const spec = ctx.readJsonArtifact<AppSpec>('appspec')
      const behaviors = ctx.readJsonArtifact<BehaviorSpec>('behaviorspec')
      const plan = ctx.readJsonArtifact<PortPlan>('portplan')
      if (!spec || !behaviors || !plan) {
        return {
          status: 'failed',
          retryable: false,
          error: {
            class: 'internal',
            message: 'appspec, behaviorspec, or portplan missing',
            diagnostics: [],
          },
        }
      }
      const accepted = acceptedFindings(ctx)
      const sourceTests = latestTests(ctx, 'source').find((t) => t.kind === 'unit')
      const core = coreSummary(ctx)
      const reports: TargetReport[] = []
      for (const target of ctx.run.targets) {
        const stages = stagesFor(ctx, target)
        const tests = latestTests(ctx, target)
        const verdict = latestVerdict(ctx, target)
        const outcome = outcomeFor(stages, verdict)
        const report: TargetReport = {
          target,
          outcome,
          headline: headlineFor(outcome, stages, tests, verdict),
          tests: tests.map((t) => ({
            kind: t.kind,
            status: t.status,
            passed: t.summary.passed,
            total: t.summary.total,
            flaky: t.summary.flaky,
          })),
          critic: verdict
            ? {
                decision: verdict.decision,
                round: verdict.round,
                average: average(verdict),
                blocking: verdict.findings.filter(
                  (f) => f.severity === 'blocking' && !accepted.has(f.id),
                ).length,
                advisory: verdict.findings.filter((f) => f.severity !== 'blocking').length,
              }
            : undefined,
        }
        const workspace = join(ctx.run.runDir, 'workspace', target)
        const tp = plan.targets.find((t) => t.target === target)
        if (tp && existsSync(workspace)) {
          const adapter = adapterFor(target)
          const tctx: TargetContext = {
            run: ctx.run,
            spec,
            behaviors,
            plan: tp,
            workspace,
            config: ctx.config,
            env: process.env,
            signal: ctx.signal,
            log: (m) => ctx.log('debug', m),
          }
          const docs = adapter?.docs?.(tctx)
          const files = shippedFiles(workspace, docs?.shipped)
          const buildResult = stages.get('build')?.result as { product?: string } | undefined
          const product = buildResult?.product ?? docs?.product
          const summaryPath = join(ctx.run.runDir, `generate-${target}.json`)
          const worker = existsSync(summaryPath)
            ? (JSON.parse(readFileSync(summaryPath, 'utf8')) as WorkerSummary)
            : undefined
          const prefix = `workspace/${target}/`
          const screenshots = ctx.store
            .listArtifacts(ctx.run.id)
            .filter(
              (a) =>
                a.kind === 'target-screenshot' &&
                a.meta.target === target &&
                typeof a.meta.screenId === 'string',
            )
            .map((a) => ({
              screenId: String(a.meta.screenId),
              rel: a.relPath.startsWith(prefix) ? a.relPath.slice(prefix.length) : a.relPath,
            }))
          const md = portMarkdown({
            spec,
            behaviors,
            sourceTests,
            plan,
            target,
            stages,
            tests,
            verdict,
            accepted,
            docs,
            worker,
            product,
            screenshots,
            core,
            workspace,
            files,
          })
          writeFileSync(join(workspace, 'PORT.md'), md)
          const rel = `${prefix}PORT.md`
          ctx.addArtifact({
            kind: 'port-readme',
            relPath: rel,
            mime: 'text/markdown',
            meta: { target, appId: docs?.shipped?.appId?.value, files: files.total },
          })
          report.readme = rel
          report.product = product ? `${prefix}${product}` : undefined
          report.appId = docs?.shipped?.appId?.value
          report.files = files.total
        }
        reports.push(report)
      }
      const summary = reports.map((r) => `${r.target}: ${r.headline}`).join('; ')
      const json = {
        runId: ctx.run.id,
        source: ctx.run.source,
        costUsd: ctx.run.costUsd,
        targets: reports,
        summary,
      }
      writeFileSync(join(ctx.run.runDir, 'report.json'), JSON.stringify(json, null, 2))
      ctx.addArtifact({ kind: 'run-report', relPath: 'report.json', mime: 'application/json' })
      ctx.updateRun({ summary })
      ctx.log(
        'info',
        reports.some((r) => r.readme)
          ? `wrote ${reports
              .filter((r) => r.readme)
              .map((r) => r.readme)
              .join(', ')}`
          : 'no target workspaces to report on',
      )
      return {
        status: 'succeeded',
        result: {
          summary,
          targets: reports.map((r) => ({ target: r.target, outcome: r.outcome })),
        },
      }
    },
  }
}
