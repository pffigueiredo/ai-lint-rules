import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import {
  type ArmId,
  type Capture,
  type CaseResult,
  type Kind,
  type Manifest,
  type Problem,
  ARMS,
  TYPE_AWARE_UNSAFE_RULES,
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
  selfCheckPool,
  writeJson,
} from './lib.ts'
import {
  hhHead,
  hhRow,
  otherArms,
  resolveBaseline,
  sectionTitle,
  selfCheckCompare,
  stats,
  uniqueArms,
} from './compare.ts'
import {
  COMPLEXITY_COGNITIVE_MAX,
  COMPLEXITY_CYCLOMATIC_MAX,
  COMPLEXITY_PLUGIN,
  getKind,
  loadProblem,
  materializeArm,
} from './kinds.ts'

const BIN = {
  oxlint: join(REPO_ROOT, 'node_modules/.bin/oxlint'),
  tsc: join(REPO_ROOT, 'node_modules/.bin/tsc'),
  knip: join(REPO_ROOT, 'node_modules/.bin/knip'),
  git: 'git',
}

const KNIP_IGNORE_DEPS = [
  'typescript',
  'oxlint',
  'oxlint-tsgolint',
  '@oxlint/plugins',
  'vite',
  '@vitejs/plugin-react',
  'babel-plugin-react-compiler',
  'vitest',
  'jsdom',
  '@testing-library/react',
  '@testing-library/user-event',
  '@testing-library/dom',
  'eslint-plugin-react-you-might-not-need-an-effect',
  'oxlint-plugin-complexity',
  '@total-typescript/ts-reset',
  '@types/.+',
] as const

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
  moduleComplexity: number
  lintErrors: number
  lintByRule: Record<string, number>
  tscErrors: number
  suppressions: number
  ccErosion: number
  erosion: number
}

type DeadCode = {
  unusedFiles: number
  unusedExports: number
  unusedDeps: number
  unusedFileNames: string[]
  unusedExportNames: string[]
  unusedDepNames: string[]
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
  moduleComplexity: number
  lintErrors: number
  lintByRule: Record<string, number>
  tscErrors: number
  suppressions: number
  ccErosion: number
  erosion: number
  unusedFiles: number
  unusedExports: number
  unusedDeps: number
  unusedFileNames: string[]
  unusedExportNames: string[]
  unusedDepNames: string[]
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
  moduleComplexity: number
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
    moduleComplexity: 0,
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
      const moduleComplexity = Number(m[2])
      addFn(acc, moduleComplexity)
      if (moduleComplexity > acc.moduleComplexity) acc.moduleComplexity = moduleComplexity
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

function knipNames(raw: unknown, at: string): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`${at}: expected array`)
  const out: string[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item['name'] !== 'string') throw new Error(`${at}: item.name missing`)
    out.push(item['name'])
  }
  return out
}

function parseKnip(stdout: string): DeadCode {
  const start = stdout.indexOf('{')
  if (start < 0) throw new Error(`knip json missing:\n${stdout}`)
  const parsed: unknown = JSON.parse(stdout.slice(start))
  if (!isRecord(parsed) || !Array.isArray(parsed['issues'])) {
    throw new Error('knip json: missing issues')
  }
  const unusedFileNames: string[] = []
  const unusedExportNames: string[] = []
  const unusedDepNames: string[] = []
  for (const issue of parsed['issues']) {
    if (!isRecord(issue) || typeof issue['file'] !== 'string') {
      throw new Error('knip json: issue.file missing')
    }
    const file = issue['file']
    unusedFileNames.push(...knipNames(issue['files'], 'knip files'))
    for (const name of knipNames(issue['exports'], 'knip exports')) {
      unusedExportNames.push(`${file}:${name}`)
    }
    for (const name of knipNames(issue['types'], 'knip types')) {
      unusedExportNames.push(`${file}:${name}`)
    }
    unusedDepNames.push(...knipNames(issue['dependencies'], 'knip dependencies'))
    unusedDepNames.push(...knipNames(issue['devDependencies'], 'knip devDependencies'))
  }
  unusedFileNames.sort()
  unusedExportNames.sort()
  unusedDepNames.sort()
  return {
    unusedFiles: unusedFileNames.length,
    unusedExports: unusedExportNames.length,
    unusedDeps: unusedDepNames.length,
    unusedFileNames,
    unusedExportNames,
    unusedDepNames,
  }
}

async function knipMetrics(ws: string, kind: Kind): Promise<DeadCode> {
  const cfgDir = await mkdtemp(join(tmpdir(), 'knip-cfg-'))
  try {
    const cfgPath = join(cfgDir, 'knip.json')
    await writeJson(cfgPath, {
      entry: [...kind.knipEntry],
      project: ['src/**/*.{ts,tsx}'],
      ignoreDependencies: [...KNIP_IGNORE_DEPS],
      ignoreFiles: ['**/*.d.ts'],
      vite: false,
    })
    const ran = await capture(
      BIN.knip,
      [
        '--config',
        cfgPath,
        '--reporter',
        'json',
        '--no-progress',
        '--no-config-hints',
        '--include',
        'files,exports,types,dependencies',
        '--no-exit-code',
      ],
      { cwd: ws, timeoutMs: 60_000 },
    )
    if (ran.code !== 0) {
      throw new Error(`knip failed (exit ${ran.code})\n${ran.stderr}\n${ran.stdout}`)
    }
    return parseKnip(ran.stdout)
  } finally {
    await rm(cfgDir, { recursive: true, force: true })
  }
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
    moduleComplexity: lint.moduleComplexity,
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

  for (const spec of ARMS) {
    if (!spec.overlay || spec.complexity) continue
    const overlayWs = await mkdtemp(join(tmpdir(), `${problem.slug}-ov-`))
    try {
      await materializeArm(overlayWs, spec.id, problem.kind)
      await copySolution(overlayWs, problem.solutionDir)
      await assertPlantedBlind(overlayWs, kind)
      await kind.prepareTools(overlayWs)
      const check = await capture('pnpm', ['check'], { cwd: overlayWs, timeoutMs: 60_000 })
      if (check.code !== 0) {
        throw new Error(`${problem.slug} solution failed ${spec.id} pnpm check:\n${check.stdout}\n${check.stderr}`)
      }
    } finally {
      await rm(overlayWs, { recursive: true, force: true })
    }
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

async function selfCheckLintV2(): Promise<void> {
  for (const kindId of ['cli', 'react'] as const) {
    const dest = await mkdtemp(join(tmpdir(), `${kindId}-v2-`))
    try {
      if (dest.includes('lint-v2')) throw new Error('lint-v2 self-check: tmp path contains arm name')
      await materializeArm(dest, 'lint-v2', kindId)
      const kind = getKind(kindId)
      await assertPlantedBlind(dest, kind)
      for (const rel of kind.planted) {
        let body: string
        try {
          body = await readFile(join(dest, rel), 'utf8')
        } catch {
          continue
        }
        if (rel.includes('lint-v2') || body.includes('lint-v2')) {
          throw new Error(`${rel} contains the arm name`)
        }
      }
      const cfg = await readJson(join(dest, '.oxlintrc.json'))
      if (!isRecord(cfg) || !isRecord(cfg['rules'])) throw new Error('lint-v2 oxlintrc missing rules')
      const rules = cfg['rules']
      for (const id of Object.keys(TYPE_AWARE_UNSAFE_RULES)) {
        if (rules[id] !== 'error') throw new Error(`lint-v2 missing ${id}`)
      }
      const reset = await readFile(join(dest, 'src/reset.d.ts'), 'utf8')
      if (!reset.includes('@total-typescript/ts-reset')) throw new Error('lint-v2 missing src/reset.d.ts')
      const pkg = await readJson(join(dest, 'package.json'))
      if (!isRecord(pkg) || !isRecord(pkg['devDependencies'])) throw new Error('lint-v2 package.json')
      if (typeof pkg['devDependencies']['@total-typescript/ts-reset'] !== 'string') {
        throw new Error('lint-v2 missing ts-reset in workspace devDependencies')
      }
      if (kindId === 'cli') {
        if (rules['no-console'] !== undefined) throw new Error('lint-v2 cli still has no-console')
        if (rules['typescript/no-non-null-assertion'] !== undefined) {
          throw new Error('lint-v2 cli still has no-non-null-assertion')
        }
      } else {
        if (rules['ai/no-use-state'] !== undefined) throw new Error('lint-v2 react still has no-use-state')
        if (rules['ai/no-async-state'] !== undefined) throw new Error('lint-v2 react still has no-async-state')
        if (rules['ai/no-boolean-state'] !== undefined) throw new Error('lint-v2 react still has no-boolean-state')
        if (rules['ai/url-state-in-lib'] !== 'error') throw new Error('lint-v2 react missing url-state-in-lib')
        if (rules['ai/no-use-effect'] !== 'error') throw new Error('lint-v2 react dropped no-use-effect')
        if (rules['no-console'] !== 'error') throw new Error('lint-v2 react dropped no-console')
        if (rules['typescript/no-non-null-assertion'] !== 'error') {
          throw new Error('lint-v2 react dropped no-non-null-assertion')
        }
      }
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  }
}

async function selfCheckLintCc(): Promise<void> {
  for (const kindId of ['cli', 'react'] as const) {
    const dest = await mkdtemp(join(tmpdir(), `${kindId}-cc-`))
    try {
      if (dest.includes('lint-cc')) throw new Error('lint-cc self-check: tmp path contains arm name')
      await materializeArm(dest, 'lint-cc', kindId)
      const kind = getKind(kindId)
      await assertPlantedBlind(dest, kind)
      for (const rel of kind.planted) {
        let body: string
        try {
          body = await readFile(join(dest, rel), 'utf8')
        } catch {
          continue
        }
        if (rel.includes('lint-cc') || body.includes('lint-cc')) {
          throw new Error(`${rel} contains the arm name`)
        }
      }
      const cfg = await readJson(join(dest, '.oxlintrc.json'))
      if (!isRecord(cfg) || !isRecord(cfg['rules'])) throw new Error('lint-cc oxlintrc missing rules')
      const cyclomatic = cfg['rules']['eslint/complexity']
      if (
        !Array.isArray(cyclomatic) ||
        !isRecord(cyclomatic[1]) ||
        cyclomatic[1]['max'] !== COMPLEXITY_CYCLOMATIC_MAX
      ) {
        throw new Error('lint-cc missing eslint/complexity max 20')
      }
      const cognitive = cfg['rules']['complexity/complexity']
      if (
        !Array.isArray(cognitive) ||
        !isRecord(cognitive[1]) ||
        cognitive[1]['cognitive'] !== COMPLEXITY_COGNITIVE_MAX
      ) {
        throw new Error('lint-cc missing cognitive max 15')
      }
      const jsPlugins = cfg['jsPlugins']
      if (!Array.isArray(jsPlugins) || !jsPlugins.includes(COMPLEXITY_PLUGIN)) {
        throw new Error('lint-cc missing oxlint-plugin-complexity jsPlugin')
      }
      const pkg = await readJson(join(dest, 'package.json'))
      if (!isRecord(pkg) || !isRecord(pkg['devDependencies'])) throw new Error('lint-cc package.json')
      if (typeof pkg['devDependencies'][COMPLEXITY_PLUGIN] !== 'string') {
        throw new Error('lint-cc missing plugin in workspace devDependencies')
      }
      if (kindId !== 'cli') continue
      await kind.prepareTools(dest)
      await mkdir(join(dest, 'src'), { recursive: true })
      const lines = ['export function heavy(n: number): number {', '  let x = n']
      for (let i = 0; i <= 20; i += 1) lines.push(`  if (x === ${i}) x += 1`)
      lines.push('  return x', '}', '')
      await writeFile(join(dest, 'src/cli.ts'), lines.join('\n'))
      const ran = await capture(BIN.oxlint, ['-c', join(dest, '.oxlintrc.json'), 'src'], {
        cwd: dest,
        timeoutMs: 30_000,
      })
      if (ran.code === 0) throw new Error('lint-cc: heavy function should fail oxlint')
      const out = `${ran.stdout}\n${ran.stderr}`
      if (!out.includes('complexity')) throw new Error(`lint-cc: oxlint missed complexity\n${out.slice(-1000)}`)
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  }
}

async function selfCheckKnip(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'knip-fix-'))
  try {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeJson(join(dir, 'package.json'), {
      name: 'knip-fixture',
      private: true,
      type: 'module',
      dependencies: { 'left-pad': '1.3.0' },
    })
    await writeFile(join(dir, 'src/cli.ts'), "import { used } from './used.ts'\nused()\n")
    await writeFile(join(dir, 'src/used.ts'), 'export function used() {}\nexport function leftover() {}\n')
    await writeFile(join(dir, 'src/dead.ts'), 'export const ghost = 1\n')
    const dead = await knipMetrics(dir, getKind('cli'))
    if (dead.unusedFiles !== 1 || dead.unusedExports !== 1 || dead.unusedDeps !== 1) {
      throw new Error(
        `knip fixture: files ${dead.unusedFiles} exports ${dead.unusedExports} deps ${dead.unusedDeps}, want 1 1 1`,
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function selfCheck(): Promise<void> {
  const slugs = await listProblemSlugs()
  if (slugs.length === 0) throw new Error('no problems under evals/problems')
  process.stderr.write('self-check pool\n')
  await selfCheckPool()
  selfCheckCompare()
  process.stderr.write('self-check metrics fixture\n')
  await selfCheckMetrics()
  process.stderr.write('self-check knip fixture\n')
  await selfCheckKnip()
  process.stderr.write('self-check lint-cc overlay\n')
  await selfCheckLintCc()
  process.stderr.write('self-check lint-v2 overlay\n')
  await selfCheckLintV2()
  for (const slug of slugs) {
    const problem = await loadProblem(slug)
    process.stderr.write(`self-check ${slug} (${problem.specs.length} checkpoints)\n`)
    await selfCheckProblem(problem)
  }
  process.stdout.write(`self-check ok: ${slugs.join(', ')}, metrics-fixture, knip-fixture, lint-cc, lint-v2, pool\n`)
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
    const dead = await knipMetrics(clone, kind)
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
      moduleComplexity: q.moduleComplexity,
      lintErrors: q.lintErrors,
      lintByRule: q.lintByRule,
      tscErrors: q.tscErrors,
      suppressions: q.suppressions,
      ccErosion: q.ccErosion,
      erosion: q.erosion,
      unusedFiles: dead.unusedFiles,
      unusedExports: dead.unusedExports,
      unusedDeps: dead.unusedDeps,
      unusedFileNames: dead.unusedFileNames,
      unusedExportNames: dead.unusedExportNames,
      unusedDepNames: dead.unusedDepNames,
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
  unusedFiles: number
  unusedExports: number
  unusedDeps: number
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
      unusedFiles: last.unusedFiles,
      unusedExports: last.unusedExports,
      unusedDeps: last.unusedDeps,
    })
  }
  return out
}

function pickStats<T>(xs: T[], fn: (x: T) => number) {
  return stats(xs.map(fn))
}

function outcomeTable(a: WsSummary[], b: WsSummary[], baseline: ArmId, other: ArmId): string[] {
  const left = (fn: (s: WsSummary) => number) => pickStats(a, fn)
  const right = (fn: (s: WsSummary) => number) => pickStats(b, fn)
  return [
    ...hhHead(baseline, other),
    hhRow('% checkpoints solved', left(s => s.solvedPct), right(s => s.solvedPct), 1),
    hhRow('% iso-solved', left(s => s.isoPct), right(s => s.isoPct), 1),
    hhRow('core pass rate', left(s => s.core), right(s => s.core), 2),
    hhRow('regression pass rate', left(s => s.regression), right(s => s.regression), 2),
    hhRow('complexity erosion', left(s => s.ccErosion), right(s => s.ccErosion), 3),
    hhRow('statements', left(s => s.statements), right(s => s.statements), 1),
    hhRow('delta statements %', left(s => s.deltaStatementsPct), right(s => s.deltaStatementsPct), 1),
    hhRow('churn ratio', left(s => s.churn), right(s => s.churn), 3),
    hhRow('unused files', left(s => s.unusedFiles), right(s => s.unusedFiles), 1),
    hhRow('unused exports', left(s => s.unusedExports), right(s => s.unusedExports), 1),
    hhRow('unused deps', left(s => s.unusedDeps), right(s => s.unusedDeps), 1),
    hhRow('tokens', left(s => s.tokens), right(s => s.tokens), 0),
    hhRow('duration ms', left(s => s.durationMs), right(s => s.durationMs), 0),
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
    unusedFiles: row.unusedFiles,
    unusedExports: row.unusedExports,
    unusedDeps: row.unusedDeps,
  }
}

function complianceTable(a: WsSummary[], b: WsSummary[], baseline: ArmId, other: ArmId): string[] {
  const left = (fn: (s: WsSummary) => number) => pickStats(a, fn)
  const right = (fn: (s: WsSummary) => number) => pickStats(b, fn)
  return [
    ...hhHead(baseline, other),
    hhRow('lint violations per LOC', left(s => s.lintPerLoc), right(s => s.lintPerLoc), 3),
    hhRow('tsc strict errors', left(s => s.tscErrors), right(s => s.tscErrors), 1),
    hhRow('suppressions', left(s => s.suppressions), right(s => s.suppressions), 1),
    hhRow('% ran pnpm check', left(s => s.ranCheckPct), right(s => s.ranCheckPct), 1),
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

function perRuleTable(a: WsSummary[], b: WsSummary[], baseline: ArmId, other: ArmId): string[] {
  const names = new Set<string>()
  for (const s of [...a, ...b]) {
    for (const k of Object.keys(s.lintPerLocByRule)) names.add(k)
  }
  const lines = [
    `| rule | ${baseline} per LOC | ${other} per LOC | ${baseline} count | ${other} count |`,
    '| --- | --- | --- | --- | --- |',
  ]
  const sorted = [...names].sort()
  if (sorted.length === 0) {
    lines.push('| _(none)_ | 0 | 0 | 0 | 0 |')
    return lines
  }
  for (const rule of sorted) {
    const aLoc = stats(a.map(s => s.lintPerLocByRule[rule] ?? 0))
    const bLoc = stats(b.map(s => s.lintPerLocByRule[rule] ?? 0))
    const aN = stats(a.map(s => s.lintByRule[rule] ?? 0))
    const bN = stats(b.map(s => s.lintByRule[rule] ?? 0))
    lines.push(
      `| ${rule} | ${aLoc.mean.toFixed(4)} | ${bLoc.mean.toFixed(4)} | ${aN.mean.toFixed(2)} | ${bN.mean.toFixed(2)} |`,
    )
  }
  return lines
}

function comparisonBlocks(rows: Row[], baseline: ArmId, other: ArmId, only: boolean): string[] {
  const overallA = workspaceSummaries(rows.filter(r => r.arm === baseline))
  const overallB = workspaceSummaries(rows.filter(r => r.arm === other))
  const lines: string[] = [
    `## ${sectionTitle('Outcome', other, only)}`,
    '',
    ...outcomeTable(overallA, overallB, baseline, other),
    '',
  ]
  const checkpoints = [...new Set(rows.map(r => r.checkpoint))].sort((a, b) => a - b)
  for (const n of checkpoints) {
    const at = rows.filter(r => r.checkpoint === n)
    lines.push(`## ${sectionTitle(`Outcome, checkpoint ${n}`, other, only)}`, '')
    lines.push(
      ...outcomeTable(
        at.filter(r => r.arm === baseline).map(rowAsSummary),
        at.filter(r => r.arm === other).map(rowAsSummary),
        baseline,
        other,
      ),
      '',
    )
  }
  lines.push(`## ${sectionTitle('Compliance', other, only)}`, '')
  lines.push(...complianceTable(overallA, overallB, baseline, other), '')
  lines.push(`## ${sectionTitle('Lint violations by rule (final checkpoint, per LOC)', other, only)}`, '')
  lines.push(...perRuleTable(overallA, overallB, baseline, other), '')
  return lines
}

function complexityTables(rows: Row[]): string[] {
  const checkpoints = [...new Set(rows.map(r => r.checkpoint))].sort((a, b) => a - b)
  const lines: string[] = [
    '## Complexity caps',
    '',
    'ccMax includes the metrics plugin `(module)` pseudo-function. moduleComplexity is that value alone. A rise there is logic moved out of functions.',
    '',
  ]
  for (const n of checkpoints) {
    const at = rows.filter(r => r.checkpoint === n).slice().sort((a, b) => a.id.localeCompare(b.id))
    lines.push(`### Checkpoint ${n}`, '')
    lines.push('| workspace | arm | ccMax | (module) | statements |', '| --- | --- | --- | --- | --- |')
    for (const r of at) {
      lines.push(`| \`${r.id}\` | ${r.arm} | ${r.ccMax} | ${r.moduleComplexity} | ${r.statements} |`)
    }
    lines.push('')
  }
  return lines
}

export function summaryMarkdown(rows: Row[], baseline: ArmId): string {
  const present = uniqueArms(rows)
  const others = otherArms(present, baseline)
  const only = others.length === 1
  const other = others[0]
  const question =
    other !== undefined && only
      ? `Question: do the lint rules help, ${baseline} vs ${other}, in iterative runs?`
      : `Question: do the lint rules help, ${baseline} vs each other arm, in iterative runs?`
  const complianceNote =
    other !== undefined && only
      ? `Compliance metrics only show whether the ${other} arm followed or gamed the rules.`
      : 'Compliance metrics only show whether each other arm followed or gamed the rules.'
  const lines: string[] = [
    '# Summary',
    '',
    question,
    '',
    `Outcome metrics can show help or harm. ${complianceNote} Full SlopCodeBench erosion (complexity + lint/LOC) stays in \`results.jsonl\` and is not an outcome.`,
    '',
    ...failedCalls(rows),
  ]
  if (others.length === 0) lines.push('No other arms to compare.', '')
  else {
    for (const o of others) lines.push(...comparisonBlocks(rows, baseline, o, only))
  }
  if (present.includes('lint-cc')) lines.push(...complexityTables(rows))
  return `${lines.join('\n')}`
}

async function gradeRunDir(runDir: string, requestedBaseline: string | undefined): Promise<void> {
  const manifest = await loadManifest(runDir)
  const rows: Row[] = []
  for (const ws of manifest.workspaces) {
    process.stderr.write(`grade ${ws.id}\n`)
    rows.push(...(await gradeWorkspace(runDir, ws)))
  }
  const jsonl = rows.map(r => JSON.stringify(r)).join('\n')
  await writeFile(join(runDir, 'results.jsonl'), jsonl === '' ? '' : `${jsonl}\n`)
  const baseline = resolveBaseline(uniqueArms(rows.length > 0 ? rows : manifest.workspaces), requestedBaseline)
  const md = summaryMarkdown(rows, baseline)
  await writeFile(join(runDir, 'summary.md'), md)
  process.stdout.write(md)
}

function usage(): never {
  process.stderr.write(
    'usage: node evals/grade.ts --self-check | node evals/grade.ts evals/runs/<ts> [--baseline plain]\n',
  )
  process.exit(2)
}

function parseGradeArgs(argv: string[]): { selfCheck: boolean; runDir?: string | undefined; baseline?: string | undefined } {
  if (argv[0] === '--self-check') {
    if (argv.length !== 1) usage()
    return { selfCheck: true }
  }
  let runDir: string | undefined
  let baseline: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === undefined) break
    if (a === '--baseline') {
      i += 1
      const v = argv[i]
      if (v === undefined) throw new Error('missing value for --baseline')
      baseline = v
      continue
    }
    if (a.startsWith('--') || runDir !== undefined) usage()
    runDir = a
  }
  if (runDir === undefined) usage()
  return { selfCheck: false, runDir, baseline }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseGradeArgs(process.argv.slice(2))
  if (opts.selfCheck) {
    await selfCheck()
  } else {
    if (opts.runDir === undefined) usage()
    await gradeRunDir(opts.runDir, opts.baseline)
  }
}
