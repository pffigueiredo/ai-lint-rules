import { access, appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import {
  type ArmId,
  type Kind,
  type Manifest,
  type WorkspaceRow,
  METRICS_PLUGIN,
  REPO_ROOT,
  capture,
  isRecord,
  listCheckpointTags,
  parseManifest,
  pool,
  readJson,
  writeJson,
} from './lib.ts'
import { getKind, loadProblem } from './kinds.ts'

const OXLINT = join(REPO_ROOT, 'node_modules/.bin/oxlint')
const METRICS_CODE = 'metrics(file)'
const METRICS_RE = /statements (\d+) moduleComplexity (\d+)/u
const AGENT_CHECK_RE = /(check|test|spec|verify|smoke|e2e)/i
const MODULE_CC_MAX = 20
const DEFAULT_CONCURRENCY = 4
const TSGOLINT_RULES = [
  'typescript/no-unsafe-assignment',
  'typescript/no-unsafe-member-access',
  'typescript/no-unsafe-return',
  'typescript/no-unsafe-call',
  'typescript/no-unsafe-argument',
  'typescript/no-misused-promises',
  'typescript/switch-exhaustiveness-check',
  'typescript/no-unnecessary-condition',
  'typescript/strict-boolean-expressions',
  'typescript/no-unnecessary-type-assertion',
] as const
const REACT_COMPILER_RULES = [
  'react/immutability',
  'react/purity',
  'react/set-state-in-render',
  'react/refs',
  'react/globals',
  'react/static-components',
  'react/use-memo',
  'react/no-deriving-state-in-effects',
] as const

export type HitCode = 'product' | 'agent-check'

export type Hit = {
  check: string
  rule: string
  file: string
  line: number
  endLine: number
  message: string
  code: HitCode
}

export type SweepMetrics = {
  duplicationPct?: number
  typeCoveragePct?: number
}

export type RawHit = {
  rule: string
  file: string
  line: number
  endLine: number
  message: string
}

export type CheckResult = {
  hits: RawHit[]
  metrics?: SweepMetrics
}

export type CheckCtx = {
  clone: string
  kind: Kind
  kindId: string
  files: Map<string, string>
  fromRef: string
  toRef: string
}

export type CheckScope = 'final' | 'transitions'

export type CheckDef = {
  id: string
  scope: CheckScope
  kinds?: readonly string[]
  run: (ctx: CheckCtx) => Promise<CheckResult>
  fixture: () => Promise<void>
}

export type SweepRow = {
  id: string
  problem: string
  arm: ArmId
  rep: number
  checkpoint: number
  check: string
  statements: number
  hits: Hit[]
  metrics?: SweepMetrics
}

type SweepOpts = {
  selfCheck: boolean
  runDir: string | undefined
  concurrency: number
  fresh: boolean
  checkpoint: number | undefined
}

function posixRel(from: string, to: string): string {
  return relative(from, to).split('\\').join('/')
}

export function classifyCode(file: string): HitCode {
  return AGENT_CHECK_RE.test(file) ? 'agent-check' : 'product'
}

function lineAt(src: string, offset: number): number {
  if (src.length === 0) return 1
  const clamped = Math.max(0, Math.min(offset, src.length - 1))
  let line = 1
  for (let i = 0; i < clamped; i += 1) {
    if (src.charCodeAt(i) === 10) line += 1
  }
  return line
}

function lineCount(src: string): number {
  if (src === '') return 0
  return src.split('\n').length
}

function hitSpan(d: Record<string, unknown>, src: string | undefined): { start: number; end: number } {
  const labels = d['labels']
  let start = Number.POSITIVE_INFINITY
  let end = 0
  if (Array.isArray(labels)) {
    for (const lab of labels) {
      if (!isRecord(lab)) continue
      const span = lab['span']
      if (!isRecord(span)) continue
      const line = span['line']
      const offset = span['offset']
      const length = span['length']
      if (typeof line === 'number' && Number.isInteger(line) && line >= 1) {
        start = Math.min(start, line)
        end = Math.max(end, line)
      }
      if (src !== undefined && typeof offset === 'number' && typeof length === 'number' && length >= 0) {
        end = Math.max(end, lineAt(src, offset + Math.max(length, 1) - 1))
      }
    }
  }
  if (!Number.isFinite(start) || start < 1) return { start: 1, end: 1 }
  if (src !== undefined) {
    const n = lineCount(src)
    if (end < start) end = start
    if (end > n) end = n
  }
  if (end < start) end = start
  return { start, end }
}

function parseOxlintHits(stdout: string, ws: string, files: Map<string, string>): RawHit[] {
  const start = stdout.indexOf('{')
  if (start < 0) return []
  const parsed: unknown = JSON.parse(stdout.slice(start))
  if (!isRecord(parsed) || !Array.isArray(parsed['diagnostics'])) {
    throw new Error('oxlint json: missing diagnostics')
  }
  const hits: RawHit[] = []
  for (const d of parsed['diagnostics']) {
    if (!isRecord(d)) continue
    const code = d['code']
    const severity = d['severity']
    const message = d['message']
    const filename = d['filename']
    if (typeof code !== 'string' || typeof message !== 'string' || typeof filename !== 'string') continue
    if (severity !== 'error') continue
    const stripped = filename.replace(/^file:\/\//, '')
    const file = stripped.startsWith(ws) ? posixRel(ws, stripped) : stripped.split('\\').join('/').replace(/^\.\//, '')
    const src = files.get(file)
    const span = hitSpan(d, src)
    hits.push({ rule: code, file, line: span.start, endLine: span.end, message })
  }
  return hits
}

async function runOxlint(ws: string, cfg: Record<string, unknown>, files: Map<string, string>): Promise<RawHit[]> {
  const cfgPath = join(ws, '.grader-oxlintrc.json')
  await writeJson(cfgPath, cfg)
  try {
    const ran = await capture(OXLINT, ['--format', 'json', '-c', cfgPath, 'src'], {
      cwd: ws,
      timeoutMs: 60_000,
    })
    if (ran.stdout.indexOf('{') < 0) {
      throw new Error(`oxlint produced no json (exit ${ran.code})\n${ran.stderr}\n${ran.stdout}`)
    }
    return parseOxlintHits(ran.stdout, ws, files)
  } finally {
    await rm(cfgPath, { force: true })
  }
}

async function linkNodeModules(ws: string): Promise<void> {
  const dest = join(ws, 'node_modules')
  await rm(dest, { recursive: true, force: true })
  await symlink(join(REPO_ROOT, 'node_modules'), dest)
}

async function collectFiles(ws: string, kind: Kind): Promise<Map<string, string>> {
  const abs = await kind.sourceFiles(join(ws, 'src'))
  abs.sort()
  const files = new Map<string, string>()
  for (const p of abs) files.set(posixRel(ws, p), await readFile(p, 'utf8'))
  return files
}

async function writeTsconfig(dir: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeJson(join(dir, 'tsconfig.json'), {
    compilerOptions: {
      strict: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      skipLibCheck: true,
      lib: ['ES2023', 'DOM'],
      types: ['node'],
      ...extra,
    },
    include: ['src'],
  })
}

function tsgolintConfig(): Record<string, unknown> {
  const rules: Record<string, 'error'> = {}
  for (const id of TSGOLINT_RULES) rules[id] = 'error'
  return { options: { typeAware: true }, plugins: ['typescript'], rules }
}

function reactCompilerConfig(): Record<string, unknown> {
  const rules: Record<string, 'error'> = {}
  for (const id of REACT_COMPILER_RULES) rules[id] = 'error'
  return { plugins: ['react'], rules }
}

function complexityConfig(): Record<string, unknown> {
  return {
    plugins: ['eslint'],
    jsPlugins: [METRICS_PLUGIN, 'oxlint-plugin-complexity'],
    rules: {
      'eslint/complexity': ['error', { max: 20 }],
      'complexity/complexity': ['error', { cyclomatic: 10_000, cognitive: 15, minLines: 0 }],
      'metrics/file': 'error',
    },
  }
}

function moduleHits(raw: RawHit[]): RawHit[] {
  const out: RawHit[] = []
  for (const h of raw) {
    if (h.rule !== METRICS_CODE) {
      out.push(h)
      continue
    }
    const m = METRICS_RE.exec(h.message)
    if (m === null) throw new Error(`metrics diagnostic: ${h.message}`)
    const moduleComplexity = Number(m[2])
    if (moduleComplexity > MODULE_CC_MAX) {
      out.push({
        rule: 'metrics(module)',
        file: h.file,
        line: h.line,
        endLine: h.endLine,
        message: `module complexity ${moduleComplexity} (max ${MODULE_CC_MAX})`,
      })
    }
  }
  return out
}

async function runTsgolintExtras(ctx: CheckCtx): Promise<CheckResult> {
  const hits = await runOxlint(ctx.clone, tsgolintConfig(), ctx.files)
  return { hits }
}

async function runReactCompiler(ctx: CheckCtx): Promise<CheckResult> {
  const hits = await runOxlint(ctx.clone, reactCompilerConfig(), ctx.files)
  return { hits }
}

async function runComplexity(ctx: CheckCtx): Promise<CheckResult> {
  const raw = await runOxlint(ctx.clone, complexityConfig(), ctx.files)
  return { hits: moduleHits(raw) }
}

function heavyFunctionSrc(): string {
  const lines = ['export function heavy(n: number): number {', '  let x = n']
  for (let i = 0; i <= 20; i += 1) lines.push(`  if (x === ${i}) x += 1`)
  lines.push('  return x', '}', '')
  return lines.join('\n')
}

function moduleBranchSrc(): string {
  const lines = ['const n = 1']
  for (let i = 0; i <= 20; i += 1) lines.push(`if (n === ${i}) { void n }`)
  lines.push('')
  return lines.join('\n')
}

async function withFixture(
  kindId: string,
  setup: (dir: string) => Promise<void>,
  run: (ctx: CheckCtx) => Promise<CheckResult>,
): Promise<CheckResult> {
  const dir = await mkdtemp(join(tmpdir(), 'sweep-fix-'))
  try {
    await mkdir(join(dir, 'src'), { recursive: true })
    await linkNodeModules(dir)
    await setup(dir)
    const kind = getKind(kindId)
    const files = await collectFiles(dir, kind)
    return await run({ clone: dir, kind, kindId, files, fromRef: 'v0', toRef: 'v1' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function mustHit(result: CheckResult, needle: string, label: string): RawHit {
  const hit = result.hits.find(h => h.rule.includes(needle) || h.message.includes(needle))
  if (hit === undefined) {
    const seen = result.hits.map(h => `${h.rule}: ${h.message}`).join('; ')
    throw new Error(`${label}: no hit matching ${JSON.stringify(needle)}; got ${seen || '(none)'}`)
  }
  return hit
}

async function fixtureTsgolintExtras(): Promise<void> {
  const src =
    'export async function load(): Promise<{ id: string }> {\n' +
    "  const res = await fetch('https://example.com')\n" +
    '  const x: { id: string } = await res.json()\n' +
    '  return x\n' +
    '}\n'
  const result = await withFixture(
    'cli',
    async dir => {
      await writeTsconfig(dir)
      await writeFile(join(dir, 'src/a.ts'), src)
    },
    runTsgolintExtras,
  )
  mustHit(result, 'no-unsafe-assignment', 'tsgolint-extras')
}

async function fixtureReactCompiler(): Promise<void> {
  const src =
    "import { useState } from 'react'\n" +
    'export default function App() {\n' +
    '  const [n, setN] = useState(0)\n' +
    '  setN(1)\n' +
    '  return n\n' +
    '}\n'
  const result = await withFixture(
    'react',
    async dir => {
      await writeJson(join(dir, 'tsconfig.json'), {
        compilerOptions: {
          strict: true,
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx',
          noEmit: true,
          skipLibCheck: true,
          lib: ['ES2023', 'DOM'],
        },
        include: ['src'],
      })
      await writeFile(join(dir, 'src/App.tsx'), src)
    },
    runReactCompiler,
  )
  mustHit(result, 'set-state-in-render', 'react-compiler')
}

async function fixtureComplexity(): Promise<void> {
  const result = await withFixture(
    'cli',
    async dir => {
      await writeTsconfig(dir)
      await writeFile(join(dir, 'src/heavy.ts'), heavyFunctionSrc())
      await writeFile(join(dir, 'src/mod.ts'), moduleBranchSrc())
    },
    runComplexity,
  )
  mustHit(result, 'eslint(complexity)', 'complexity cyclomatic')
  mustHit(result, 'complexity', 'complexity cognitive or cyclomatic')
  mustHit(result, 'metrics(module)', 'complexity module')
}

export const CHECKS: readonly CheckDef[] = [
  { id: 'tsgolint-extras', scope: 'final', run: runTsgolintExtras, fixture: fixtureTsgolintExtras },
  { id: 'react-compiler', scope: 'final', kinds: ['react'], run: runReactCompiler, fixture: fixtureReactCompiler },
  { id: 'complexity', scope: 'final', run: runComplexity, fixture: fixtureComplexity },
]

function flagOnce(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== name) continue
    const v = argv[i + 1]
    if (v === undefined) throw new Error(`missing value for ${name}`)
    return v
  }
  return undefined
}

function parseArgs(argv: string[]): SweepOpts {
  const selfCheck = argv.includes('--self-check')
  const fresh = argv.includes('--fresh')
  const concurrencyRaw = flagOnce(argv, '--concurrency')
  const concurrency = Number(concurrencyRaw ?? String(DEFAULT_CONCURRENCY))
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer')
  const checkpointRaw = flagOnce(argv, '--checkpoint')
  let checkpoint: number | undefined
  if (checkpointRaw !== undefined) {
    checkpoint = Number(checkpointRaw)
    if (!Number.isInteger(checkpoint) || checkpoint < 1) throw new Error('--checkpoint must be a positive integer')
  }
  const valueFlags = new Set(['--concurrency', '--checkpoint'])
  const positional: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === undefined) continue
    if (a === '--self-check' || a === '--fresh') continue
    if (valueFlags.has(a)) {
      i += 1
      continue
    }
    positional.push(a)
  }
  if (selfCheck) {
    if (fresh) throw new Error('--fresh does not apply to --self-check')
    if (checkpoint !== undefined) throw new Error('--checkpoint does not apply to --self-check')
    if (positional.length !== 0) throw new Error('--self-check takes no run dir')
    return { selfCheck: true, runDir: undefined, concurrency, fresh: false, checkpoint: undefined }
  }
  const runDir = positional[0]
  if (runDir === undefined || positional.length !== 1) {
    throw new Error('usage: node evals/sweep.ts --self-check | node evals/sweep.ts <runDir> [--checkpoint N] [--concurrency 4] [--fresh]')
  }
  return { selfCheck: false, runDir, concurrency, fresh, checkpoint }
}

function sweepKey(row: Pick<SweepRow, 'id' | 'checkpoint' | 'check'>): string {
  return `${row.id}\t${row.checkpoint}\t${row.check}`
}

function parseSweepRow(raw: unknown): SweepRow {
  if (!isRecord(raw)) throw new Error('sweep.jsonl row must be an object')
  const { id, problem, arm, rep, checkpoint, check, statements, hits } = raw
  if (typeof id !== 'string' || typeof problem !== 'string' || typeof check !== 'string') {
    throw new Error('sweep.jsonl row missing strings')
  }
  if (arm !== 'plain' && arm !== 'lint') throw new Error(`sweep.jsonl bad arm ${String(arm)}`)
  if (typeof rep !== 'number' || typeof checkpoint !== 'number' || typeof statements !== 'number') {
    throw new Error('sweep.jsonl row missing numbers')
  }
  if (!Array.isArray(hits)) throw new Error('sweep.jsonl row missing hits')
  const parsedHits: Hit[] = []
  for (const h of hits) {
    if (!isRecord(h)) throw new Error('sweep.jsonl hit must be an object')
    const { rule, file, line, endLine, message, code } = h
    if (typeof rule !== 'string' || typeof file !== 'string' || typeof message !== 'string') {
      throw new Error('sweep.jsonl hit missing strings')
    }
    if (typeof line !== 'number' || typeof endLine !== 'number') throw new Error('sweep.jsonl hit missing lines')
    if (code !== 'product' && code !== 'agent-check') throw new Error(`sweep.jsonl hit bad code ${String(code)}`)
    if (typeof h['check'] !== 'string') throw new Error('sweep.jsonl hit missing check')
    parsedHits.push({ check: h['check'], rule, file, line, endLine, message, code })
  }
  const metricsRaw = raw['metrics']
  const row: SweepRow = { id, problem, arm, rep, checkpoint, check, statements, hits: parsedHits }
  if (metricsRaw !== undefined) {
    if (!isRecord(metricsRaw)) throw new Error('sweep.jsonl metrics must be an object')
    const metrics: SweepMetrics = {}
    if (typeof metricsRaw['duplicationPct'] === 'number') metrics.duplicationPct = metricsRaw['duplicationPct']
    if (typeof metricsRaw['typeCoveragePct'] === 'number') metrics.typeCoveragePct = metricsRaw['typeCoveragePct']
    row.metrics = metrics
  }
  return row
}

async function readJsonl<T>(path: string, parse: (raw: unknown) => T): Promise<T[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    out.push(parse(JSON.parse(line)))
  }
  return out
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function archiveIfPresent(from: string, to: string): Promise<void> {
  if (!(await exists(from))) return
  if (await exists(to)) await rm(from)
  else await rename(from, to)
}

function mutex(): (fn: () => Promise<void>) => Promise<void> {
  let tail = Promise.resolve()
  return fn => {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

async function cloneBundle(bundlePath: string, dest: string): Promise<void> {
  const cloned = await capture('git', ['clone', bundlePath, dest], { cwd: process.cwd(), timeoutMs: 60_000 })
  if (cloned.code !== 0) throw new Error(`git clone ${bundlePath}: ${cloned.stderr}`)
}

async function checkoutTag(ws: string, n: number): Promise<void> {
  const co = await capture('git', ['checkout', '-f', `v${n}`], { cwd: ws, timeoutMs: 30_000 })
  if (co.code !== 0) throw new Error(`checkout v${n}: ${co.stderr}`)
}

function toHits(check: string, raw: RawHit[]): Hit[] {
  return raw.map(h => ({
    check,
    rule: h.rule,
    file: h.file,
    line: h.line,
    endLine: h.endLine,
    message: h.message,
    code: classifyCode(h.file),
  }))
}

async function statementsOf(ctx: CheckCtx): Promise<number> {
  const raw = await runOxlint(
    ctx.clone,
    { jsPlugins: [METRICS_PLUGIN], rules: { 'metrics/file': 'error' } },
    ctx.files,
  )
  let n = 0
  let files = 0
  for (const h of raw) {
    if (h.rule !== METRICS_CODE) continue
    const m = METRICS_RE.exec(h.message)
    if (m === null) throw new Error(`metrics diagnostic: ${h.message}`)
    n += Number(m[1])
    files += 1
  }
  if (ctx.files.size > 0 && files === 0) throw new Error('metrics plugin produced no diagnostics')
  return n
}

function applies(def: CheckDef, kindId: string): boolean {
  return def.kinds === undefined || def.kinds.includes(kindId)
}

export async function selfCheckSweep(): Promise<void> {
  if (classifyCode('src/cli.ts') !== 'product') throw new Error('classifyCode: src/cli.ts')
  if (classifyCode('src/check.ts') !== 'agent-check') throw new Error('classifyCode: src/check.ts')
  if (classifyCode('src/lib/verify.ts') !== 'agent-check') throw new Error('classifyCode: verify')
  const ids = new Set<string>()
  for (const def of CHECKS) {
    if (ids.has(def.id)) throw new Error(`duplicate check id ${def.id}`)
    ids.add(def.id)
    process.stderr.write(`self-check ${def.id}\n`)
    await def.fixture()
  }
  const args = parseArgs(['evals/runs/x'])
  if (args.runDir !== 'evals/runs/x' || args.selfCheck) throw new Error('parseArgs: run dir')
  const sc = parseArgs(['--self-check'])
  if (!sc.selfCheck) throw new Error('parseArgs: --self-check')
  process.stderr.write(`self-check sweep ok: ${[...ids].join(', ')}\n`)
}

async function sweepWorkspace(
  runDir: string,
  ws: WorkspaceRow,
  requested: number | undefined,
  done: Set<string>,
  append: (fn: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const problem = await loadProblem(ws.problem)
  const kind = getKind(problem.kind)
  const clone = await mkdtemp(join(tmpdir(), 'sweep-'))
  try {
    await cloneBundle(join(runDir, ws.bundle), clone)
    await kind.prepareGrade(clone)
    const tags = await listCheckpointTags(clone)
    const final = requested ?? tags[tags.length - 1]
    if (final === undefined || !tags.includes(final)) return
    const jobs: { def: CheckDef; checkpoint: number; fromRef: string; toRef: string }[] = []
    for (const def of CHECKS) {
      if (!applies(def, problem.kind)) continue
      if (def.scope === 'final') {
        jobs.push({ def, checkpoint: final, fromRef: final === 1 ? 'v0' : `v${final - 1}`, toRef: `v${final}` })
        continue
      }
      for (const n of tags) {
        jobs.push({ def, checkpoint: n, fromRef: n === 1 ? 'v0' : `v${n - 1}`, toRef: `v${n}` })
      }
    }
    let loaded: number | undefined
    let files = new Map<string, string>()
    let statements = 0
    const ctxOf = async (checkpoint: number, fromRef: string, toRef: string): Promise<CheckCtx> => {
      if (loaded !== checkpoint) {
        await checkoutTag(clone, checkpoint)
        await kind.prepareGrade(clone)
        files = await collectFiles(clone, kind)
        loaded = checkpoint
        const ctx = { clone, kind, kindId: problem.kind, files, fromRef, toRef }
        statements = await statementsOf(ctx)
      }
      return { clone, kind, kindId: problem.kind, files, fromRef, toRef }
    }
    for (const job of jobs) {
      const key = sweepKey({ id: ws.id, checkpoint: job.checkpoint, check: job.def.id })
      if (done.has(key)) continue
      process.stderr.write(`sweep ${ws.id} ${job.def.id} v${job.checkpoint}\n`)
      const ctx = await ctxOf(job.checkpoint, job.fromRef, job.toRef)
      const result = await job.def.run(ctx)
      const row: SweepRow = {
        id: ws.id,
        problem: ws.problem,
        arm: ws.arm,
        rep: ws.rep,
        checkpoint: job.checkpoint,
        check: job.def.id,
        statements,
        hits: toHits(job.def.id, result.hits),
      }
      if (result.metrics !== undefined) row.metrics = result.metrics
      await append(async () => {
        await appendFile(join(runDir, 'sweep.jsonl'), `${JSON.stringify(row)}\n`)
      })
      done.add(key)
    }
  } finally {
    await rm(clone, { recursive: true, force: true })
  }
}

async function runSweep(opts: SweepOpts): Promise<void> {
  if (opts.runDir === undefined) throw new Error('run dir required')
  const runDir = opts.runDir
  const manifest: Manifest = parseManifest(await readJson(join(runDir, 'manifest.json')))
  if (opts.fresh) {
    await archiveIfPresent(join(runDir, 'sweep.jsonl'), join(runDir, 'sweep.v1.jsonl'))
  }
  const existing = await readJsonl(join(runDir, 'sweep.jsonl'), parseSweepRow)
  const done = new Set(existing.map(sweepKey))
  const append = mutex()
  const kinds = new Map<string, string>()
  for (const ws of manifest.workspaces) {
    const problem = await loadProblem(ws.problem)
    kinds.set(ws.id, problem.kind)
  }
  await pool({
    items: manifest.workspaces,
    concurrency: opts.concurrency,
    kindOf: ws => kinds.get(ws.id) ?? 'cli',
    kindLimit: kind => getKind(kind).concurrency,
    run: ws => sweepWorkspace(runDir, ws, opts.checkpoint, done, append),
  })
  process.stderr.write('sweep jsonl done\n')
}

process.chdir(REPO_ROOT)
const argv = process.argv.slice(2)
const opts = parseArgs(argv)
if (opts.selfCheck) {
  await selfCheckSweep()
} else {
  await runSweep(opts)
}
