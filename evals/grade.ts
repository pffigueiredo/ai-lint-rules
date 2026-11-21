import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  type ArmId,
  type Case,
  type Capture,
  type Group,
  type Manifest,
  type Problem,
  parseManifest,
  type Step,
  REPO_ROOT,
  capture,
  findLeak,
  isRecord,
  listProblemSlugs,
  loadProblem,
  materializeArm,
  mergedStrictTsconfig,
  readJson,
  writeJson,
} from './lib.ts'

const STEP_TIMEOUT_MS = 8_000
const BIN = {
  oxlint: join(REPO_ROOT, 'node_modules/.bin/oxlint'),
  tsc: join(REPO_ROOT, 'node_modules/.bin/tsc'),
  git: 'git',
}

type CaseResult = { name: string; group: Group; pass: boolean; detail: string }

type AgentStatus = 'ok' | 'timeout' | 'error' | 'missing'

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
  linesAdded: number
  linesRemoved: number
  churn: number
  deltaLocPct: number
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

function trimLines(s: string): string {
  return s
    .split('\n')
    .map(l => l.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n+$/u, '')
}

function fail(detail: string): { ok: false; detail: string } {
  return { ok: false, detail }
}

async function compareFiles(cwd: string, expected: Record<string, unknown>): Promise<{ ok: true } | { ok: false; detail: string }> {
  for (const [rel, want] of Object.entries(expected)) {
    const path = join(cwd, rel)
    let body: string
    try {
      body = await readFile(path, 'utf8')
    } catch {
      return fail(`${rel}: missing`)
    }
    if (rel.endsWith('.json')) {
      let got: unknown
      try {
        got = JSON.parse(body)
      } catch {
        return fail(`${rel}: not JSON`)
      }
      if (!isDeepStrictEqual(got, want)) return fail(`${rel}: JSON mismatch`)
      continue
    }
    if (trimLines(body) !== trimLines(String(want))) return fail(`${rel}: mismatch`)
  }
  return { ok: true }
}

async function runStep(
  cliDir: string,
  cwd: string,
  step: Step,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const cli = join(cliDir, 'src/cli.ts')
  let ran: Capture
  try {
    const opts: { cwd: string; timeoutMs: number; stdin?: string } = {
      cwd,
      timeoutMs: STEP_TIMEOUT_MS,
    }
    if (step.stdin !== undefined) opts.stdin = step.stdin
    ran = await capture('node', [cli, ...step.args], opts)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
  if (ran.code !== step.exitCode) {
    return fail(`exit ${ran.code}, want ${step.exitCode}`)
  }
  if (step.stdout !== undefined && trimLines(ran.stdout) !== trimLines(step.stdout)) {
    return fail(`stdout mismatch`)
  }
  if (step.json !== undefined) {
    let got: unknown
    try {
      got = JSON.parse(ran.stdout)
    } catch {
      return fail('stdout is not JSON')
    }
    if (!isDeepStrictEqual(got, step.json)) return fail('json mismatch')
  }
  if (step.files !== undefined) return compareFiles(cwd, step.files)
  return { ok: true }
}

export async function runCase(cliDir: string, cas: Case): Promise<CaseResult> {
  const cwd = await mkdtemp(join(tmpdir(), 'case-'))
  try {
    if (cas.files !== undefined) {
      for (const [rel, body] of Object.entries(cas.files)) {
        const path = join(cwd, rel)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, body)
      }
    }
    for (const [i, step] of cas.steps.entries()) {
      const result = await runStep(cliDir, cwd, step)
      if (!result.ok) {
        return { name: cas.name, group: cas.group, pass: false, detail: `step ${i}: ${result.detail}` }
      }
    }
    return { name: cas.name, group: cas.group, pass: true, detail: '' }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function rate(results: CaseResult[], group: Group): number {
  const xs = results.filter(r => r.group === group)
  if (xs.length === 0) return 1
  return xs.filter(r => r.pass).length / xs.length
}

async function runCheckpointCases(
  cliDir: string,
  problem: Problem,
  checkpoint: number,
): Promise<{ results: CaseResult[]; solved: boolean; isoSolved: boolean; passRate: Row['passRate'] }> {
  const current = problem.cases[checkpoint - 1]
  if (current === undefined) throw new Error(`missing cases for checkpoint ${checkpoint}`)
  const iso: CaseResult[] = []
  for (const cas of current) iso.push(await runCase(cliDir, cas))
  const regression: CaseResult[] = []
  for (let n = 1; n < checkpoint; n += 1) {
    const prev = problem.cases[n - 1]
    if (prev === undefined) continue
    for (const cas of prev) regression.push(await runCase(cliDir, cas))
  }
  const all = [...iso, ...regression]
  return {
    results: all,
    solved: all.every(r => r.pass),
    isoSolved: iso.every(r => r.pass),
    passRate: {
      core: rate(iso, 'core'),
      error: rate(iso, 'error'),
      functionality: rate(iso, 'functionality'),
      regression: regression.length === 0 ? 1 : regression.filter(r => r.pass).length / regression.length,
    },
  }
}

async function linkModules(ws: string): Promise<void> {
  const dest = join(ws, 'node_modules')
  await rm(dest, { recursive: true, force: true })
  await symlink(join(REPO_ROOT, 'node_modules'), dest)
}

async function walkTs(dir: string): Promise<string[]> {
  let ents
  try {
    ents = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walkTs(p)))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
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

async function srcMetrics(ws: string): Promise<{ loc: number; commentLines: number; suppressions: number; files: string[] }> {
  const files = await walkTs(join(ws, 'src'))
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

function parseOxlint(stdout: string): { functions: number; ccHigh: number; ccExtreme: number; ccMax: number; lintErrors: number; lintByRule: Record<string, number> } {
  const start = stdout.indexOf('{')
  if (start < 0) {
    return { functions: 0, ccHigh: 0, ccExtreme: 0, ccMax: 0, lintErrors: 0, lintByRule: {} }
  }
  const parsed: unknown = JSON.parse(stdout.slice(start))
  if (!isRecord(parsed) || !Array.isArray(parsed['diagnostics'])) {
    throw new Error('oxlint json: missing diagnostics')
  }
  let functions = 0
  let ccHigh = 0
  let ccExtreme = 0
  let ccMax = 0
  let lintErrors = 0
  const lintByRule: Record<string, number> = {}
  for (const d of parsed['diagnostics']) {
    if (!isRecord(d)) continue
    const code = d['code']
    const severity = d['severity']
    const message = d['message']
    if (typeof code !== 'string' || typeof message !== 'string') continue
    if (code === 'eslint(complexity)') {
      functions += 1
      const m = CC_RE.exec(message)
      const n = m === null ? 0 : Number(m[1])
      if (n > ccMax) ccMax = n
      if (n > 10) ccHigh += 1
      if (n > 30) ccExtreme += 1
      continue
    }
    if (severity !== 'error') continue
    lintErrors += 1
    lintByRule[code] = (lintByRule[code] ?? 0) + 1
  }
  return { functions, ccHigh, ccExtreme, ccMax, lintErrors, lintByRule }
}

async function lintMetrics(ws: string): Promise<ReturnType<typeof parseOxlint>> {
  const srcDir = join(ws, 'src')
  const files = await walkTs(srcDir)
  if (files.length === 0) {
    return { functions: 0, ccHigh: 0, ccExtreme: 0, ccMax: 0, lintErrors: 0, lintByRule: {} }
  }
  const example = await readJson(join(REPO_ROOT, 'oxlint/typescript/oxlintrc.example.json'))
  if (!isRecord(example)) throw new Error('oxlintrc.example.json must be an object')
  const pluginsRaw = example['plugins']
  const plugins = Array.isArray(pluginsRaw) ? pluginsRaw.filter(p => typeof p === 'string') : []
  if (!plugins.includes('eslint')) plugins.push('eslint')
  example['plugins'] = plugins
  const rules = example['rules']
  if (!isRecord(rules)) throw new Error('oxlintrc rules missing')
  rules['eslint/complexity'] = ['error', { max: 0 }]
  example['$schema'] = join(REPO_ROOT, 'node_modules/oxlint/configuration_schema.json')
  const cfgPath = join(ws, '.metrics-oxlintrc.json')
  await writeJson(cfgPath, example)
  const ran = await capture(BIN.oxlint, ['--format', 'json', '-c', cfgPath, srcDir], {
    cwd: ws,
    timeoutMs: 60_000,
  })
  await rm(cfgPath, { force: true })
  return parseOxlint(ran.stdout)
}

async function tscErrorCount(ws: string): Promise<number> {
  const files = await walkTs(join(ws, 'src'))
  if (files.length === 0) return 0
  const cfg = await mergedStrictTsconfig()
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

async function qualityOf(ws: string): Promise<Quality> {
  const { loc, commentLines, suppressions } = await srcMetrics(ws)
  const lint = await lintMetrics(ws)
  const tscErrors = await tscErrorCount(ws)
  const fnTerm = lint.functions === 0 ? 0 : (lint.ccHigh + lint.ccExtreme) / lint.functions
  const locTerm = loc === 0 ? 0 : lint.lintErrors / loc
  return {
    loc,
    commentLines,
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
  const status: AgentStatus = timedOut ? 'timeout' : !hasResult ? 'missing' : isError ? 'error' : 'ok'
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

async function listCheckpointTags(ws: string): Promise<number[]> {
  const ran = await git(ws, ['tag', '-l', 'v*'])
  const ns: number[] = []
  for (const line of ran.stdout.split('\n')) {
    const m = /^v(\d+)$/.exec(line.trim())
    if (m === null) continue
    const n = Number(m[1])
    if (n >= 1) ns.push(n)
  }
  ns.sort((a, b) => a - b)
  return ns
}

async function copySolution(dest: string, solutionDir: string): Promise<void> {
  await mkdir(join(dest, 'src'), { recursive: true })
  await cp(join(solutionDir, 'src'), join(dest, 'src'), { recursive: true })
}

async function assertNoLeak(label: string, text: string): Promise<void> {
  const hit = findLeak(text)
  if (hit !== undefined) throw new Error(`${label} leaks ${JSON.stringify(hit)}`)
}

async function selfCheckProblem(problem: Problem): Promise<void> {
  const sol = await mkdtemp(join(tmpdir(), `${problem.slug}-sol-`))
  try {
    await copySolution(sol, problem.solutionDir)
    for (let n = 1; n <= problem.cases.length; n += 1) {
      const { solved, results } = await runCheckpointCases(sol, problem, n)
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
    await materializeArm(lintWs, 'lint')
    await copySolution(lintWs, problem.solutionDir)
    await linkModules(lintWs)
    await assertNoLeak('lint overlay path', lintWs)
    const pkg = await readFile(join(lintWs, 'package.json'), 'utf8')
    const rc = await readFile(join(lintWs, '.oxlintrc.json'), 'utf8')
    const ts = await readFile(join(lintWs, 'tsconfig.json'), 'utf8')
    const agents = await readFile(join(lintWs, 'AGENTS.md'), 'utf8')
    for (const [label, text] of [
      ['package.json', pkg],
      ['.oxlintrc.json', rc],
      ['tsconfig.json', ts],
      ['AGENTS.md', agents],
    ] as const) {
      await assertNoLeak(label, text)
    }
    const check = await capture('pnpm', ['check'], { cwd: lintWs, timeoutMs: 60_000 })
    if (check.code !== 0) {
      throw new Error(`${problem.slug} solution failed lint-arm pnpm check:\n${check.stdout}\n${check.stderr}`)
    }
  } finally {
    await rm(lintWs, { recursive: true, force: true })
  }

  const empty = await mkdtemp(join(tmpdir(), `${problem.slug}-empty-`))
  try {
    await mkdir(join(empty, 'src'), { recursive: true })
    await writeFile(join(empty, 'src/cli.ts'), 'export {}\n')
    const failed: string[] = []
    const passed: string[] = []
    for (let n = 1; n <= problem.cases.length; n += 1) {
      const bundle = problem.cases[n - 1]
      if (bundle === undefined) continue
      for (const cas of bundle) {
        const r = await runCase(empty, cas)
        if (r.pass) passed.push(`cp${n}/${cas.name}`)
        else failed.push(cas.name)
      }
    }
    if (passed.length > 0) {
      throw new Error(`${problem.slug} empty program passed vacuous cases: ${passed.join(', ')}`)
    }
    if (failed.length === 0) throw new Error(`${problem.slug} has no cases`)
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
}

async function selfCheck(): Promise<void> {
  const slugs = await listProblemSlugs()
  if (slugs.length === 0) throw new Error('no problems under evals/problems')
  for (const slug of slugs) {
    const problem = await loadProblem(slug)
    process.stderr.write(`self-check ${slug} (${problem.cases.length} checkpoints)\n`)
    await selfCheckProblem(problem)
  }
  process.stdout.write(`self-check ok: ${slugs.join(', ')}\n`)
}

async function loadManifest(runDir: string): Promise<Manifest> {
  return parseManifest(await readJson(join(runDir, 'manifest.json')))
}

async function gradeWorkspace(runDir: string, ws: Manifest['workspaces'][number]): Promise<Row[]> {
  const problem = await loadProblem(ws.problem)
  const clone = await mkdtemp(join(tmpdir(), `${ws.problem}-g-`))
  const bundlePath = join(runDir, ws.bundle)
  const cloned = await git(process.cwd(), ['clone', bundlePath, clone])
  if (cloned.code !== 0) throw new Error(`git clone ${bundlePath}: ${cloned.stderr}`)
  await linkModules(clone)
  const tags = await listCheckpointTags(clone)
  const rows: Row[] = []
  let prevLoc = 0
  for (const n of tags) {
    const co = await git(clone, ['checkout', '-f', `v${n}`])
    if (co.code !== 0) throw new Error(`checkout v${n}: ${co.stderr}`)
    const cases = await runCheckpointCases(clone, problem, n)
    const q = await qualityOf(clone)
    const prevRef = n === 1 ? 'v0' : `v${n - 1}`
    const diff = await numstat(clone, prevRef, `v${n}`)
    const churn = prevLoc === 0 ? 0 : (diff.added + diff.removed) / prevLoc
    const deltaLocPct = prevLoc === 0 ? (q.loc > 0 ? 100 : 0) : (100 * (q.loc - prevLoc)) / prevLoc
    prevLoc = q.loc
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
      linesAdded: diff.added,
      linesRemoved: diff.removed,
      churn,
      deltaLocPct,
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
  deltaLocPct: number
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
      deltaLocPct: list.reduce((a, r) => a + r.deltaLocPct, 0) / list.length,
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
    hhRow('LOC', p(s => s.loc), l(s => s.loc), 1),
    hhRow('delta LOC %', p(s => s.deltaLocPct), l(s => s.deltaLocPct), 1),
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
    deltaLocPct: row.deltaLocPct,
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
    `Failed or timed-out agent calls: ${bad.length}/${rows.length}. These rows stay in the rates.`,
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
    'Question: do the TypeScript rules help, plain vs lint, in iterative runs?',
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
