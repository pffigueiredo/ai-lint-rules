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

type AgentStats = {
  durationMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  toolCalls: number
  ranCheck: boolean
  isError: boolean
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
  erosion: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  tokens: number
  toolCalls: number
  ranCheck: boolean
  agentError: boolean
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
  return {
    durationMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    toolCalls,
    ranCheck,
    isError,
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
      erosion: q.erosion,
      durationMs: agent.durationMs,
      inputTokens: agent.inputTokens,
      outputTokens: agent.outputTokens,
      tokens: agent.inputTokens + agent.outputTokens,
      toolCalls: agent.toolCalls,
      ranCheck: agent.ranCheck,
      agentError: agent.isError,
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

function workspaceSummaries(rows: Row[]): {
  solvedPct: number
  isoPct: number
  core: number
  regression: number
  erosion: number
  lintPerLoc: number
  tscErrors: number
  suppressions: number
  finalLoc: number
  churn: number
  durationMs: number
  tokens: number
  lintByRule: Record<string, number>
}[] {
  const byId = new Map<string, Row[]>()
  for (const row of rows) {
    const list = byId.get(row.id) ?? []
    list.push(row)
    byId.set(row.id, list)
  }
  const out: ReturnType<typeof workspaceSummaries> = []
  for (const list of byId.values()) {
    list.sort((a, b) => a.checkpoint - b.checkpoint)
    const last = list[list.length - 1]
    if (last === undefined) continue
    const lintPerLoc = list.map(r => (r.loc === 0 ? 0 : r.lintErrors / r.loc))
    out.push({
      solvedPct: (100 * list.filter(r => r.solved).length) / list.length,
      isoPct: (100 * list.filter(r => r.isoSolved).length) / list.length,
      core: list.reduce((a, r) => a + r.passRate.core, 0) / list.length,
      regression: list.reduce((a, r) => a + r.passRate.regression, 0) / list.length,
      erosion: list.reduce((a, r) => a + r.erosion, 0) / list.length,
      lintPerLoc: lintPerLoc.reduce((a, n) => a + n, 0) / lintPerLoc.length,
      tscErrors: last.tscErrors,
      suppressions: last.suppressions,
      finalLoc: last.loc,
      churn: list.reduce((a, r) => a + r.churn, 0) / list.length,
      durationMs: list.reduce((a, r) => a + r.durationMs, 0),
      tokens: list.reduce((a, r) => a + r.tokens, 0),
      lintByRule: last.lintByRule,
    })
  }
  return out
}

function summaryMarkdown(rows: Row[]): string {
  const lines: string[] = ['# Summary', '']
  for (const arm of ['plain', 'lint'] as const) {
    const armRows = rows.filter(r => r.arm === arm)
    lines.push(`## ${arm}`, '')
    if (armRows.length === 0) {
      lines.push('_no workspaces_', '')
      continue
    }
    const sums = workspaceSummaries(armRows)
    const pick = (fn: (s: (typeof sums)[number]) => number) => stats(sums.map(fn))
    lines.push('| metric | mean (min-max) |')
    lines.push('| --- | --- |')
    lines.push(`| % checkpoints solved | ${fmt(pick(s => s.solvedPct))} |`)
    lines.push(`| % iso-solved | ${fmt(pick(s => s.isoPct))} |`)
    lines.push(`| core pass rate | ${fmt(pick(s => s.core))} |`)
    lines.push(`| regression pass rate | ${fmt(pick(s => s.regression))} |`)
    lines.push(`| erosion | ${fmt(pick(s => s.erosion), 3)} |`)
    lines.push(`| lint per LOC | ${fmt(pick(s => s.lintPerLoc), 3)} |`)
    lines.push(`| tsc strict errors | ${fmt(pick(s => s.tscErrors))} |`)
    lines.push(`| suppressions | ${fmt(pick(s => s.suppressions))} |`)
    lines.push(`| final LOC | ${fmt(pick(s => s.finalLoc))} |`)
    lines.push(`| churn | ${fmt(pick(s => s.churn), 3)} |`)
    lines.push(`| duration ms | ${fmt(pick(s => s.durationMs), 0)} |`)
    lines.push(`| tokens | ${fmt(pick(s => s.tokens), 0)} |`)
    lines.push('')
  }
  const ruleNames = new Set<string>()
  for (const row of rows) {
    if (row.checkpoint !== Math.max(...rows.filter(r => r.id === row.id).map(r => r.checkpoint))) continue
    for (const k of Object.keys(row.lintByRule)) ruleNames.add(k)
  }
  lines.push('## Lint counts by rule (final checkpoint, mean)', '')
  lines.push('| rule | plain | lint |')
  lines.push('| --- | --- | --- |')
  const names = [...ruleNames].sort()
  if (names.length === 0) lines.push('| _(none)_ | 0 | 0 |')
  for (const rule of names) {
    const meanArm = (arm: ArmId): string => {
      const sums = workspaceSummaries(rows.filter(r => r.arm === arm))
      const xs = sums.map(s => s.lintByRule[rule] ?? 0)
      return stats(xs).mean.toFixed(2)
    }
    lines.push(`| ${rule} | ${meanArm('plain')} | ${meanArm('lint')} |`)
  }
  lines.push('')
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
