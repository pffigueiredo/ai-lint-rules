import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  type ArmId,
  type Capture,
  type CaseResult,
  type Kind,
  type Manifest,
  type Problem,
  parseManifest,
  EVALS_DIR,
  METRICS_PLUGIN,
  REPO_ROOT,
  capture,
  copySolution,
  findLeak,
  isRecord,
  listCheckpointTags,
  listProblemSlugs,
  readJson,
  writeJson,
} from './lib.ts'
import { getKind, loadProblem, materializeArm } from './kinds.ts'

const BIN = {
  oxlint: join(REPO_ROOT, 'node_modules/.bin/oxlint'),
  tsc: join(REPO_ROOT, 'node_modules/.bin/tsc'),
  git: 'git',
}

type AgentStatus = 'ok' | 'timeout' | 'stalled' | 'error' | 'missing'

type AgentStats = {
  durationMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  toolCalls: number
  ranCheck: boolean
  status: AgentStatus
}

type Quality = {
  loc: number
  commentLines: number
  statements: number
  functions: number
  ccHigh: number
  ccExtreme: number
  ccMax: number
  lintErrors: number
  lintByRule: Record<string, number>
  tscErrors: number
  suppressions: number
  ccErosion: number
  erosion: number
}

type Row = {
  id: string
  problem: string
  arm: ArmId
  rep: number
  model: string
  checkpoint: number
  solved: boolean
  isoSolved: boolean
  passRate: { core: number; error: number; functionality: number; regression: number }
  cases: CaseResult[]
  loc: number
  commentLines: number
  statements: number
  linesAdded: number
  linesRemoved: number
  churn: number
  deltaLocPct: number
  deltaStatementsPct: number
  functions: number
  ccHigh: number
  ccExtreme: number
  ccMax: number
  lintErrors: number
  lintByRule: Record<string, number>
  tscErrors: number
  suppressions: number
  ccErosion: number
  erosion: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  tokens: number
  toolCalls: number
  ranCheck: boolean
  agentStatus: AgentStatus
}

// ponytail: line heuristic, not a parser. Ceiling: miscounts block comments, JSDoc, and // inside strings. Upgrade to a tokenizer if that skews a run.
function countLines(src: string): { loc: number; comments: number } {
  let loc = 0
  let comments = 0
  for (const line of src.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')) comments += 1
    else loc += 1
  }
  return { loc, comments }
}

const SUPPRESSION_RE = /eslint-disable|oxlint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck/g
const CC_RE = /complexity of (\d+)/u
const METRICS_CODE = 'metrics(file)'
const METRICS_RE = /statements (\d+) moduleComplexity (\d+)/u
const METRICS_FIXTURE_STATEMENTS = 22
const METRICS_FIXTURE_MODULE_COMPLEXITY = 11

async function srcMetrics(
  ws: string,
  kind: Kind,
): Promise<{ loc: number; commentLines: number; suppressions: number; files: string[] }> {
  const files = await kind.sourceFiles(join(ws, 'src'))
  let loc = 0
  let commentLines = 0
  let suppressions = 0
  for (const file of files) {
    const src = await readFile(file, 'utf8')
    const c = countLines(src)
    loc += c.loc
    commentLines += c.comments
    const hits = src.match(SUPPRESSION_RE)
    if (hits !== null) suppressions += hits.length
  }
  return { loc, commentLines, suppressions, files }
}

type LintMetrics = {
  statements: number
  metricsFiles: number
  functions: number
  ccHigh: number
  ccExtreme: number
  ccMax: number
  lintErrors: number
  lintByRule: Record<string, number>
}

function emptyLintMetrics(): LintMetrics {
  return {
    statements: 0,
    metricsFiles: 0,
    functions: 0,
    ccHigh: 0,
    ccExtreme: 0,
    ccMax: 0,
    lintErrors: 0,
    lintByRule: {},
  }
}

function addFn(acc: LintMetrics, n: number): void {
  acc.functions += 1
  if (n > acc.ccMax) acc.ccMax = n
  if (n > 10) acc.ccHigh += 1
  if (n > 30) acc.ccExtreme += 1
}

function parseOxlint(stdout: string): LintMetrics {
  const start = stdout.indexOf('{')
  if (start < 0) return emptyLintMetrics()
  const parsed: unknown = JSON.parse(stdout.slice(start))
  if (!isRecord(parsed) || !Array.isArray(parsed['diagnostics'])) {
    throw new Error('oxlint json: missing diagnostics')
  }
  const acc = emptyLintMetrics()
  for (const d of parsed['diagnostics']) {
    if (!isRecord(d)) continue
    const code = d['code']
    const severity = d['severity']
    const message = d['message']
    if (typeof code !== 'string' || typeof message !== 'string') continue
    if (code === 'eslint(complexity)') {
      const m = CC_RE.exec(message)
      addFn(acc, m === null ? 0 : Number(m[1]))
      continue
    }
    if (code === METRICS_CODE) {
      const m = METRICS_RE.exec(message)
      if (m === null) throw new Error(`metrics diagnostic: ${message}`)
      acc.statements += Number(m[1])
      addFn(acc, Number(m[2]))
      acc.metricsFiles += 1
      continue
    }
    if (severity !== 'error') continue
    acc.lintErrors += 1
    acc.lintByRule[code] = (acc.lintByRule[code] ?? 0) + 1
  }
  return acc
}

async function lintMetrics(ws: string, kind: Kind): Promise<LintMetrics> {
  const srcDir = join(ws, 'src')
  const files = await kind.sourceFiles(srcDir)
  if (files.length === 0) return emptyLintMetrics()
  const example = await kind.yardstickOxlint()
  const cfgPath = join(ws, '.metrics-oxlintrc.json')
  await writeJson(cfgPath, example)
  const ran = await capture(BIN.oxlint, ['--format', 'json', '-c', cfgPath, srcDir], {
    cwd: ws,
    timeoutMs: 60_000,
  })
  await rm(cfgPath, { force: true })
  const lint = parseOxlint(ran.stdout)
  if (lint.metricsFiles === 0) throw new Error('metrics plugin produced no diagnostics')
  return lint
}

async function tscErrorCount(ws: string, kind: Kind): Promise<number> {
  const files = await kind.sourceFiles(join(ws, 'src'))
  if (files.length === 0) return 0
  const cfg = await kind.yardstickTsconfig()
  const cfgPath = join(ws, '.yardstick-tsconfig.json')
  await writeJson(cfgPath, cfg)
  const ran = await capture(BIN.tsc, ['-p', cfgPath, '--pretty', 'false'], { cwd: ws, timeoutMs: 60_000 })
  await rm(cfgPath, { force: true })
  const text = `${ran.stdout}\n${ran.stderr}`
  let n = 0
  for (const line of text.split('\n')) {
    if (/error TS\d+/.test(line)) n += 1
  }
  return n
}

async function qualityOf(ws: string, kind: Kind): Promise<Quality> {
  const { loc, commentLines, suppressions } = await srcMetrics(ws, kind)
  const lint = await lintMetrics(ws, kind)
  const tscErrors = await tscErrorCount(ws, kind)
  const fnTerm = lint.functions === 0 ? 0 : (lint.ccHigh + lint.ccExtreme) / lint.functions
  const locTerm = loc === 0 ? 0 : lint.lintErrors / loc
  return {
    loc,
    commentLines,
    statements: lint.statements,
    functions: lint.functions,
    ccHigh: lint.ccHigh,
    ccExtreme: lint.ccExtreme,
    ccMax: lint.ccMax,
    lintErrors: lint.lintErrors,
    lintByRule: lint.lintByRule,
    tscErrors,
    suppressions,
    ccErosion: fnTerm,
    erosion: fnTerm + locTerm,
  }
}

function parseAgentLog(text: string): AgentStats {
  let toolCalls = 0
  let ranCheck = false
  let durationMs = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let hasResult = false
  let timedOut = false
  let stalled = false
  let isError = false
  for (const line of text.split('\n')) {
    if (line.includes('pnpm check') || line.includes('pnpm run check')) ranCheck = true
    if (!line.startsWith('{')) continue
    let ev: unknown
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(ev)) continue
    if (ev['type'] === 'tool_call' && ev['subtype'] === 'started') toolCalls += 1
    if (ev['type'] !== 'result') continue
    hasResult = true
    timedOut = ev['timed_out'] === true
    stalled = ev['stalled'] === true
    isError = ev['is_error'] === true || ev['subtype'] === 'error'
    if (typeof ev['duration_ms'] === 'number') durationMs = ev['duration_ms']
    const usage = ev['usage']
    if (!isRecord(usage)) continue
    if (typeof usage['inputTokens'] === 'number') inputTokens = usage['inputTokens']
    if (typeof usage['outputTokens'] === 'number') outputTokens = usage['outputTokens']
    if (typeof usage['cacheReadTokens'] === 'number') cacheReadTokens = usage['cacheReadTokens']
    if (typeof usage['cacheWriteTokens'] === 'number') cacheWriteTokens = usage['cacheWriteTokens']
    if (typeof usage['reasoningTokens'] === 'number') reasoningTokens = usage['reasoningTokens']
  }
  const status: AgentStatus = timedOut
    ? 'timeout'
    : stalled
      ? 'stalled'
      : !hasResult
        ? 'missing'
        : isError
          ? 'error'
          : 'ok'
  return {
    durationMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    toolCalls,
    ranCheck,
    status,
  }
}

async function git(cwd: string, args: string[]): Promise<Capture> {
  return capture(BIN.git, args, { cwd, timeoutMs: 30_000 })
}

async function numstat(ws: string, fromRef: string, toRef: string): Promise<{ added: number; removed: number }> {
  const ran = await git(ws, ['diff', '--numstat', fromRef, toRef, '--', 'src'])
  let added = 0
  let removed = 0
  for (const line of ran.stdout.split('\n')) {
    if (line === '') continue
    const parts = line.split('\t')
    const a = Number(parts[0])
    const r = Number(parts[1])
    if (Number.isFinite(a)) added += a
    if (Number.isFinite(r)) removed += r
  }
  return { added, removed }
}

async function assertNoLeak(label: string, text: string): Promise<void> {
  const hit = findLeak(text)
  if (hit !== undefined) throw new Error(`${label} leaks ${JSON.stringify(hit)}`)
}

async function assertPlantedBlind(ws: string, kind: Kind): Promise<void> {
  await assertNoLeak('lint overlay path', ws)
  for (const rel of kind.planted) {
    let body: string
    try {
      body = await readFile(join(ws, rel), 'utf8')
    } catch {
      continue
    }
    await assertNoLeak(rel, body)
  }
}

async function selfCheckProblem(problem: Problem): Promise<void> {
  const kind = getKind(problem.kind)
  const sol = await mkdtemp(join(tmpdir(), `${problem.slug}-sol-`))
  try {
    await kind.hydrateForChecks(sol, problem.solutionDir)
    for (let n = 1; n <= problem.specs.length; n += 1) {
      const { solved, results } = await kind.runCheckpoint(sol, problem, n)
      if (!solved) {
        const failed = results.filter(r => !r.pass).map(r => `${r.name}: ${r.detail}`)
        throw new Error(`${problem.slug} solution failed checkpoint ${n}:\n${failed.join('\n')}`)
      }
    }
  } finally {
    await rm(sol, { recursive: true, force: true })
  }

  const lintWs = await mkdtemp(join(tmpdir(), `${problem.slug}-lint-`))
  try {
    await materializeArm(lintWs, 'lint', problem.kind)
    await copySolution(lintWs, problem.solutionDir)
    await assertPlantedBlind(lintWs, kind)
    await kind.prepareTools(lintWs)
    const check = await capture('pnpm', ['check'], { cwd: lintWs, timeoutMs: 60_000 })
    if (check.code !== 0) {
      throw new Error(`${problem.slug} solution failed lint-arm pnpm check:\n${check.stdout}\n${check.stderr}`)
    }
  } finally {
    await rm(lintWs, { recursive: true, force: true })
  }

  const empty = await mkdtemp(join(tmpdir(), `${problem.slug}-empty-`))
  try {
    await kind.hydrateEmpty(empty)
    const { results } = await kind.runCheckpoint(empty, problem, problem.specs.length)
    const passed = results.filter(r => r.pass).map(r => r.name)
    if (passed.length > 0) {
      throw new Error(`${problem.slug} empty program passed vacuous cases: ${passed.join(', ')}`)
    }
    if (results.length === 0) throw new Error(`${problem.slug} has no cases`)
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
}

async function selfCheckMetrics(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'metrics-'))
  try {
    const cfgPath = join(dir, '.oxlintrc.json')
    await writeJson(cfgPath, {
      jsPlugins: [METRICS_PLUGIN],
      rules: { 'metrics/file': 'error' },
    })
    const ran = await capture(BIN.oxlint, ['--format', 'json', '-c', cfgPath, join(EVALS_DIR, 'metrics-fixture.js')], {
      cwd: dir,
      timeoutMs: 30_000,
    })
    const start = ran.stdout.indexOf('{')
    if (start < 0) throw new Error(`metrics plugin produced no json:\n${ran.stdout}\n${ran.stderr}`)
    const parsed: unknown = JSON.parse(ran.stdout.slice(start))
    if (!isRecord(parsed) || !Array.isArray(parsed['diagnostics'])) {
      throw new Error('metrics plugin json: missing diagnostics')
    }
    let message: string | undefined
    for (const d of parsed['diagnostics']) {
      if (!isRecord(d) || d['code'] !== METRICS_CODE || typeof d['message'] !== 'string') continue
      message = d['message']
      break
    }
    if (message === undefined) throw new Error(`metrics plugin missing ${METRICS_CODE} diagnostic`)
    const m = METRICS_RE.exec(message)
    if (m === null) throw new Error(`metrics diagnostic: ${message}`)
    const statements = Number(m[1])
    const moduleComplexity = Number(m[2])
    if (statements !== METRICS_FIXTURE_STATEMENTS || moduleComplexity !== METRICS_FIXTURE_MODULE_COMPLEXITY) {
      throw new Error(
        `metrics fixture: statements ${statements} moduleComplexity ${moduleComplexity}, want ${METRICS_FIXTURE_STATEMENTS} ${METRICS_FIXTURE_MODULE_COMPLEXITY}`,
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function selfCheck(): Promise<void> {
  const slugs = await listProblemSlugs()
  if (slugs.length === 0) throw new Error('no problems under evals/problems')
  process.stderr.write('self-check metrics fixture\n')
  await selfCheckMetrics()
  for (const slug of slugs) {
    const problem = await loadProblem(slug)
    process.stderr.write(`self-check ${slug} (${problem.specs.length} checkpoints)\n`)
    await selfCheckProblem(problem)
  }
  process.stdout.write(`self-check ok: ${slugs.join(', ')}, metrics-fixture\n`)
}

async function loadManifest(runDir: string): Promise<Manifest> {
  return parseManifest(await readJson(join(runDir, 'manifest.json')))
}

async function gradeWorkspace(runDir: string, ws: Manifest['workspaces'][number]): Promise<Row[]> {
  const problem = await loadProblem(ws.problem)
  const kind = getKind(problem.kind)
  const clone = await mkdtemp(join(tmpdir(), `${ws.problem}-g-`))
  const bundlePath = join(runDir, ws.bundle)
  const cloned = await git(process.cwd(), ['clone', bundlePath, clone])
  if (cloned.code !== 0) throw new Error(`git clone ${bundlePath}: ${cloned.stderr}`)
  await kind.prepareGrade(clone)
  const tags = await listCheckpointTags(clone)
  const rows: Row[] = []
  let prevLoc = 0
  let prevStatements = 0
  for (const n of tags) {
    const co = await git(clone, ['checkout', '-f', `v${n}`])
    if (co.code !== 0) throw new Error(`checkout v${n}: ${co.stderr}`)
    await kind.prepareGrade(clone)
    const cases = await kind.runCheckpoint(clone, problem, n)
    const q = await qualityOf(clone, kind)
    const prevRef = n === 1 ? 'v0' : `v${n - 1}`
    const diff = await numstat(clone, prevRef, `v${n}`)
    const churn = prevLoc === 0 ? 0 : (diff.added + diff.removed) / prevLoc
    const deltaLocPct = prevLoc === 0 ? (q.loc > 0 ? 100 : 0) : (100 * (q.loc - prevLoc)) / prevLoc
    const deltaStatementsPct =
      prevStatements === 0 ? (q.statements > 0 ? 100 : 0) : (100 * (q.statements - prevStatements)) / prevStatements
    prevLoc = q.loc
    prevStatements = q.statements
    let agentText = ''
    try {
      agentText = await readFile(join(runDir, ws.id, `agent-${n}.jsonl`), 'utf8')
    } catch {
      agentText = ''
    }
    const agent = parseAgentLog(agentText)
    rows.push({
      id: ws.id,
      problem: ws.problem,
      arm: ws.arm,
      rep: ws.rep,
      model: ws.model,
      checkpoint: n,
      solved: cases.solved,
      isoSolved: cases.isoSolved,
      passRate: cases.passRate,
      cases: cases.results,
      loc: q.loc,
      commentLines: q.commentLines,
      statements: q.statements,
      linesAdded: diff.added,
      linesRemoved: diff.removed,
      churn,
      deltaLocPct,
      deltaStatementsPct,
      functions: q.functions,
      ccHigh: q.ccHigh,
      ccExtreme: q.ccExtreme,
      ccMax: q.ccMax,
      lintErrors: q.lintErrors,
      lintByRule: q.lintByRule,
      tscErrors: q.tscErrors,
      suppressions: q.suppressions,
      ccErosion: q.ccErosion,
      erosion: q.erosion,
      durationMs: agent.durationMs,
      inputTokens: agent.inputTokens,
      outputTokens: agent.outputTokens,
      tokens: agent.inputTokens + agent.outputTokens,
      toolCalls: agent.toolCalls,
      ranCheck: agent.ranCheck,
      agentStatus: agent.status,
    })
  }
  await rm(clone, { recursive: true, force: true })
  return rows
}

function stats(xs: number[]): { mean: number; min: number; max: number } {
  if (xs.length === 0) return { mean: 0, min: 0, max: 0 }
  let min = xs[0]
  let max = xs[0]
  if (min === undefined || max === undefined) return { mean: 0, min: 0, max: 0 }
  let sum = 0
  for (const x of xs) {
    sum += x
    if (x < min) min = x
    if (x > max) max = x
  }
  return { mean: sum / xs.length, min, max }
}

function fmt(s: { mean: number; min: number; max: number }, digits = 2): string {
  return `${s.mean.toFixed(digits)} (${s.min.toFixed(digits)}-${s.max.toFixed(digits)})`
}

type Series = { mean: number; min: number; max: number }

type WsSummary = {
  solvedPct: number
  isoPct: number
  core: number
  regression: number
  ccErosion: number
  loc: number
  statements: number
  deltaLocPct: number
  deltaStatementsPct: number
  churn: number
  durationMs: number
  tokens: number
  lintPerLoc: number
  tscErrors: number
  suppressions: number
  ranCheckPct: number
  lintByRule: Record<string, number>
  lintPerLocByRule: Record<string, number>
}

function workspaceSummaries(rows: Row[]): WsSummary[] {
  const byId = new Map<string, Row[]>()
  for (const row of rows) {
    const list = byId.get(row.id) ?? []
    list.push(row)
    byId.set(row.id, list)
  }
  const out: WsSummary[] = []
  for (const list of byId.values()) {
    list.sort((a, b) => a.checkpoint - b.checkpoint)
    const last = list[list.length - 1]
    if (last === undefined) continue
    const loc = last.loc
    const lintPerLocByRule: Record<string, number> = {}
    for (const [rule, n] of Object.entries(last.lintByRule)) {
      lintPerLocByRule[rule] = loc === 0 ? 0 : n / loc
    }
    out.push({
      solvedPct: (100 * list.filter(r => r.solved).length) / list.length,
      isoPct: (100 * list.filter(r => r.isoSolved).length) / list.length,
      core: list.reduce((a, r) => a + r.passRate.core, 0) / list.length,
      regression: list.reduce((a, r) => a + r.passRate.regression, 0) / list.length,
      ccErosion: list.reduce((a, r) => a + r.ccErosion, 0) / list.length,
      loc,
      statements: last.statements,
      deltaLocPct: list.reduce((a, r) => a + r.deltaLocPct, 0) / list.length,
      deltaStatementsPct: list.reduce((a, r) => a + r.deltaStatementsPct, 0) / list.length,
      churn: list.reduce((a, r) => a + r.churn, 0) / list.length,
      durationMs: list.reduce((a, r) => a + r.durationMs, 0),
      tokens: list.reduce((a, r) => a + r.tokens, 0),
      lintPerLoc: loc === 0 ? 0 : last.lintErrors / loc,
      tscErrors: last.tscErrors,
      suppressions: last.suppressions,
      ranCheckPct: (100 * list.filter(r => r.ranCheck).length) / list.length,
      lintByRule: last.lintByRule,
      lintPerLocByRule,
    })
  }
  return out
}

function rangesOverlap(a: Series, b: Series): boolean {
  return a.min <= b.max && b.min <= a.max
}

function pickStats<T>(xs: T[], fn: (x: T) => number): Series {
  return stats(xs.map(fn))
}

function hhRow(name: string, plain: Series, lint: Series, digits: number): string {
  const delta = lint.mean - plain.mean
  const sign = delta > 0 ? '+' : ''
  const ov = rangesOverlap(plain, lint) ? 'yes' : 'no'
  return `| ${name} | ${fmt(plain, digits)} | ${fmt(lint, digits)} | ${sign}${delta.toFixed(digits)} | ${ov} |`
}

const HH_HEAD = [
  '| metric | plain mean (min-max) | lint mean (min-max) | delta (lint - plain) | overlap |',
  '| --- | --- | --- | --- | --- |',
]

function outcomeTable(plain: WsSummary[], lint: WsSummary[]): string[] {
  const p = (fn: (s: WsSummary) => number) => pickStats(plain, fn)
  const l = (fn: (s: WsSummary) => number) => pickStats(lint, fn)
  return [
    ...HH_HEAD,
    hhRow('% checkpoints solved', p(s => s.solvedPct), l(s => s.solvedPct), 1),
    hhRow('% iso-solved', p(s => s.isoPct), l(s => s.isoPct), 1),
    hhRow('core pass rate', p(s => s.core), l(s => s.core), 2),
    hhRow('regression pass rate', p(s => s.regression), l(s => s.regression), 2),
    hhRow('complexity erosion', p(s => s.ccErosion), l(s => s.ccErosion), 3),
    hhRow('statements', p(s => s.statements), l(s => s.statements), 1),
    hhRow('delta statements %', p(s => s.deltaStatementsPct), l(s => s.deltaStatementsPct), 1),
    hhRow('churn ratio', p(s => s.churn), l(s => s.churn), 3),
    hhRow('tokens', p(s => s.tokens), l(s => s.tokens), 0),
    hhRow('duration ms', p(s => s.durationMs), l(s => s.durationMs), 0),
  ]
}

function rowAsSummary(row: Row): WsSummary {
  const loc = row.loc
  const lintPerLocByRule: Record<string, number> = {}
  for (const [rule, n] of Object.entries(row.lintByRule)) {
    lintPerLocByRule[rule] = loc === 0 ? 0 : n / loc
  }
  return {
    solvedPct: row.solved ? 100 : 0,
    isoPct: row.isoSolved ? 100 : 0,
    core: row.passRate.core,
    regression: row.passRate.regression,
    ccErosion: row.ccErosion,
    loc,
    statements: row.statements,
    deltaLocPct: row.deltaLocPct,
    deltaStatementsPct: row.deltaStatementsPct,
    churn: row.churn,
    durationMs: row.durationMs,
    tokens: row.tokens,
    lintPerLoc: loc === 0 ? 0 : row.lintErrors / loc,
    tscErrors: row.tscErrors,
    suppressions: row.suppressions,
    ranCheckPct: row.ranCheck ? 100 : 0,
    lintByRule: row.lintByRule,
    lintPerLocByRule,
  }
}

function complianceTable(plain: WsSummary[], lint: WsSummary[]): string[] {
  const p = (fn: (s: WsSummary) => number) => pickStats(plain, fn)
  const l = (fn: (s: WsSummary) => number) => pickStats(lint, fn)
  return [
    ...HH_HEAD,
    hhRow('lint violations per LOC', p(s => s.lintPerLoc), l(s => s.lintPerLoc), 3),
    hhRow('tsc strict errors', p(s => s.tscErrors), l(s => s.tscErrors), 1),
    hhRow('suppressions', p(s => s.suppressions), l(s => s.suppressions), 1),
    hhRow('% ran pnpm check', p(s => s.ranCheckPct), l(s => s.ranCheckPct), 1),
  ]
}

function failedCalls(rows: Row[]): string[] {
  const bad = rows.filter(r => r.agentStatus !== 'ok')
  const lines = [
    `Failed, timed-out, or stalled agent calls: ${bad.length}/${rows.length}. These rows stay in the rates.`,
    '',
  ]
  if (bad.length === 0) {
    lines.push('None.', '')
    return lines
  }
  for (const r of bad) {
    lines.push(`- \`${r.id}\` checkpoint ${r.checkpoint}: ${r.agentStatus}`)
  }
  lines.push('')
  return lines
}

function perRuleTable(plain: WsSummary[], lint: WsSummary[]): string[] {
  const names = new Set<string>()
  for (const s of [...plain, ...lint]) {
    for (const k of Object.keys(s.lintPerLocByRule)) names.add(k)
  }
  const lines = [
    '| rule | plain per LOC | lint per LOC | plain count | lint count |',
    '| --- | --- | --- | --- | --- |',
  ]
  const sorted = [...names].sort()
  if (sorted.length === 0) {
    lines.push('| _(none)_ | 0 | 0 | 0 | 0 |')
    return lines
  }
  for (const rule of sorted) {
    const pLoc = stats(plain.map(s => s.lintPerLocByRule[rule] ?? 0))
    const lLoc = stats(lint.map(s => s.lintPerLocByRule[rule] ?? 0))
    const pN = stats(plain.map(s => s.lintByRule[rule] ?? 0))
    const lN = stats(lint.map(s => s.lintByRule[rule] ?? 0))
    lines.push(
      `| ${rule} | ${pLoc.mean.toFixed(4)} | ${lLoc.mean.toFixed(4)} | ${pN.mean.toFixed(2)} | ${lN.mean.toFixed(2)} |`,
    )
  }
  return lines
}

function summaryMarkdown(rows: Row[]): string {
  const lines: string[] = [
    '# Summary',
    '',
    'Question: do the lint rules help, plain vs lint, in iterative runs?',
    '',
    'Outcome metrics can show help or harm. Compliance metrics only show whether the lint arm followed or gamed the rules. Full SlopCodeBench erosion (complexity + lint/LOC) stays in `results.jsonl` and is not an outcome.',
    '',
    ...failedCalls(rows),
  ]
  const overallPlain = workspaceSummaries(rows.filter(r => r.arm === 'plain'))
  const overallLint = workspaceSummaries(rows.filter(r => r.arm === 'lint'))
  lines.push('## Outcome', '')
  lines.push(...outcomeTable(overallPlain, overallLint), '')
  const checkpoints = [...new Set(rows.map(r => r.checkpoint))].sort((a, b) => a - b)
  for (const n of checkpoints) {
    const at = rows.filter(r => r.checkpoint === n)
    lines.push(`## Outcome, checkpoint ${n}`, '')
    lines.push(
      ...outcomeTable(
        at.filter(r => r.arm === 'plain').map(rowAsSummary),
        at.filter(r => r.arm === 'lint').map(rowAsSummary),
      ),
      '',
    )
  }
  lines.push('## Compliance', '')
  lines.push(...complianceTable(overallPlain, overallLint), '')
  lines.push('## Lint violations by rule (final checkpoint, per LOC)', '')
  lines.push(...perRuleTable(overallPlain, overallLint), '')
  return `${lines.join('\n')}`
}

async function gradeRunDir(runDir: string): Promise<void> {
  const manifest = await loadManifest(runDir)
  const rows: Row[] = []
  for (const ws of manifest.workspaces) {
    process.stderr.write(`grade ${ws.id}\n`)
    rows.push(...(await gradeWorkspace(runDir, ws)))
  }
  const jsonl = rows.map(r => JSON.stringify(r)).join('\n')
  await writeFile(join(runDir, 'results.jsonl'), jsonl === '' ? '' : `${jsonl}\n`)
  const md = summaryMarkdown(rows)
  await writeFile(join(runDir, 'summary.md'), md)
  process.stdout.write(md)
}

function usage(): never {
  process.stderr.write('usage: node evals/grade.ts --self-check | node evals/grade.ts evals/runs/<ts>\n')
  process.exit(2)
}

const argv = process.argv.slice(2)
if (argv[0] === '--self-check') {
  await selfCheck()
} else if (argv[0] !== undefined && argv.length === 1) {
  await gradeRunDir(argv[0])
} else {
  usage()
}
