import { access, appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import {
  type ArmId,
  type Kind,
  type Manifest,
  type WorkspaceRow,
  EVALS_DIR,
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
import {
  type BenefitVerdict,
  askReviewer,
  assertBlind,
  benefitPrompt,
  parseBenefitAnswer,
} from './review.ts'

const OXLINT = join(REPO_ROOT, 'node_modules/.bin/oxlint')
const TSC = join(REPO_ROOT, 'node_modules/.bin/tsc')
const JSCPD = join(REPO_ROOT, 'node_modules/.bin/jscpd')
const CHEATGUARD = join(REPO_ROOT, 'node_modules/.bin/cheatguard')
const ANTI_SLOP_PLUGIN = join(EVALS_DIR, 'vendor/anti-slop/index.ts')
const METRICS_CODE = 'metrics(file)'
const METRICS_RE = /statements (\d+) moduleComplexity (\d+)/u
const AGENT_CHECK_RE = /(check|test|spec|verify|smoke|e2e)/i
const MODULE_CC_MAX = 20
const DEFAULT_CONCURRENCY = 4
const DEFAULT_MODEL = 'gpt-5.6-sol-high'
const SAMPLE_CAP = 10
const CLI_STEP_TIMEOUT_MS = 8_000
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
const ANTI_SLOP_RULES = [
  'anti-slop/no-array-filter-map',
  'anti-slop/no-reduce-accumulator-copy',
  'anti-slop/no-chained-type-assertions',
  'anti-slop/no-conditional-empty-object-spread',
  'anti-slop/no-known-value-widening',
  'anti-slop/no-module-mocking',
  'anti-slop/no-object-parameters',
  'anti-slop/no-reflect-apply',
  'anti-slop/no-reflect-get',
  'anti-slop/no-runtime-typeof',
  'anti-slop/no-unsafe-dictionary-type',
  'anti-slop/no-shape-in-symbol-names',
  'anti-slop/no-unknown-parameters',
  'anti-slop/no-unknown-returns',
  'anti-slop/no-unknown-type-aliases',
  'anti-slop/no-widen-then-assert',
  'anti-slop/require-safety-comment-for-type-assertion',
] as const
const TSC_RE = /^(.*)\((\d+),(\d+)\): error (TS\d+): (.*)$/
const NKZW_CONFIG = `import nkzw from '@nkzw/oxlint-config'
import { defineConfig } from 'oxlint'
export default defineConfig({ extends: [nkzw] })
`

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
  model: string
  review: boolean
}

export type SweepReviewRow = {
  check: string
  id: string
  problem: string
  arm: ArmId
  rep: number
  checkpoint: number
  rule: string
  file: string
  line: number
  endLine: number
  message: string
  excerpt: string
  verdict: BenefitVerdict
  why: string
  input: string | null
}

export type BugReplay = {
  check: string
  id: string
  problem: string
  arm: ArmId
  checkpoint: number
  rule: string
  file: string
  line: number
  input: string
  exit: number
  stdout: string
  stderr: string
}

export const DROPPED: { id: string; why: string }[] = [
  {
    id: 'type-coverage',
    why: 'type-coverage 2.31.2 needs TypeScript 7.1 createProgram or a TypeScript 6 override; this repo is on 7.0.2 and the override would rewire the project compiler.',
  },
]

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

function parseTscLines(text: string): Map<string, RawHit> {
  const out = new Map<string, RawHit>()
  for (const line of text.split('\n')) {
    const m = TSC_RE.exec(line.trim())
    if (m === null) continue
    const fileRaw = m[1]
    const lineNo = Number(m[2])
    const code = m[4]
    const message = m[5]
    if (fileRaw === undefined || code === undefined || message === undefined || !Number.isInteger(lineNo)) continue
    const file = fileRaw.split('\\').join('/').replace(/^\.\//, '')
    const key = `${file}:${lineNo}:${code}:${message}`
    out.set(key, { rule: `ts-reset(${code})`, file, line: lineNo, endLine: lineNo, message })
  }
  return out
}

async function tscAt(ws: string, cfgPath: string): Promise<Map<string, RawHit>> {
  const ran = await capture(TSC, ['-p', cfgPath, '--pretty', 'false'], { cwd: ws, timeoutMs: 60_000 })
  return parseTscLines(`${ran.stdout}\n${ran.stderr}`)
}

async function runTsReset(ctx: CheckCtx): Promise<CheckResult> {
  const base = await ctx.kind.yardstickTsconfig()
  const withoutPath = join(ctx.clone, '.grader-tsconfig.json')
  const withPath = join(ctx.clone, '.grader-tsconfig-reset.json')
  const resetPath = join(ctx.clone, '.grader-reset.d.ts')
  await writeJson(withoutPath, base)
  await writeFile(resetPath, "import '@total-typescript/ts-reset'\n")
  const includeRaw = base['include']
  const include = Array.isArray(includeRaw) ? includeRaw.filter(x => typeof x === 'string') : ['src']
  await writeJson(withPath, { ...base, include: [...include, '.grader-reset.d.ts'] })
  try {
    const without = await tscAt(ctx.clone, withoutPath)
    const withReset = await tscAt(ctx.clone, withPath)
    const hits: RawHit[] = []
    for (const [key, hit] of withReset) {
      if (!without.has(key)) hits.push(hit)
    }
    return { hits }
  } finally {
    await rm(withoutPath, { force: true })
    await rm(withPath, { force: true })
    await rm(resetPath, { force: true })
  }
}

function jscpdPath(name: string): string {
  const n = name.split('\\').join('/').replace(/^\.\//, '')
  if (n.startsWith('src/')) return n
  return `src/${n}`
}

async function runJscpd(ctx: CheckCtx): Promise<CheckResult> {
  const outDir = await mkdtemp(join(tmpdir(), 'jscpd-'))
  try {
    const ran = await capture(
      JSCPD,
      ['--silent', '--reporters', 'json', '--output', outDir, '--min-lines', '5', '--min-tokens', '30', '--ignore', '**/node_modules/**', 'src'],
      { cwd: ctx.clone, timeoutMs: 60_000 },
    )
    const reportPath = join(outDir, 'jscpd-report.json')
    let raw: unknown
    try {
      raw = await readJson(reportPath)
    } catch {
      throw new Error(`jscpd produced no report (exit ${ran.code})\n${ran.stderr}\n${ran.stdout}`)
    }
    if (!isRecord(raw) || !Array.isArray(raw['duplicates'])) throw new Error('jscpd json: missing duplicates')
    const hits: RawHit[] = []
    for (const d of raw['duplicates']) {
      if (!isRecord(d)) continue
      const first = d['firstFile']
      const second = d['secondFile']
      if (!isRecord(first) || !isRecord(second)) continue
      const fName = first['name']
      const sName = second['name']
      const fStart = first['start']
      const fEnd = first['end']
      const sStart = second['start']
      const sEnd = second['end']
      if (typeof fName !== 'string' || typeof sName !== 'string') continue
      if (typeof fStart !== 'number' || typeof fEnd !== 'number' || typeof sStart !== 'number' || typeof sEnd !== 'number') {
        continue
      }
      const msg = typeof d['fragment'] === 'string' ? d['fragment'].slice(0, 120) : 'duplicated block'
      hits.push({ rule: 'jscpd(clone)', file: jscpdPath(fName), line: fStart, endLine: fEnd, message: msg })
      hits.push({ rule: 'jscpd(clone)', file: jscpdPath(sName), line: sStart, endLine: sEnd, message: msg })
    }
    let duplicationPct = 0
    const stats = raw['statistics']
    if (isRecord(stats) && isRecord(stats['total']) && typeof stats['total']['percentage'] === 'number') {
      duplicationPct = stats['total']['percentage']
    }
    return { hits, metrics: { duplicationPct } }
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}

function antiSlopConfig(): Record<string, unknown> {
  const rules: Record<string, 'error'> = {}
  for (const id of ANTI_SLOP_RULES) rules[id] = 'error'
  return {
    jsPlugins: [{ name: 'anti-slop', specifier: ANTI_SLOP_PLUGIN }],
    rules,
  }
}

async function runAntiSlop(ctx: CheckCtx): Promise<CheckResult> {
  const hits = await runOxlint(ctx.clone, antiSlopConfig(), ctx.files)
  return { hits }
}

async function runNkzw(ctx: CheckCtx): Promise<CheckResult> {
  const cfgPath = join(ctx.clone, '.grader-oxlint.config.ts')
  await writeFile(cfgPath, NKZW_CONFIG)
  try {
    const ran = await capture(OXLINT, ['--format', 'json', '-c', cfgPath, 'src'], {
      cwd: ctx.clone,
      timeoutMs: 60_000,
    })
    if (ran.stdout.indexOf('{') < 0) {
      throw new Error(`nkzw oxlint produced no json (exit ${ran.code})\n${ran.stderr}\n${ran.stdout}`)
    }
    return { hits: parseOxlintHits(ran.stdout, ctx.clone, ctx.files) }
  } finally {
    await rm(cfgPath, { force: true })
  }
}

function parseCheatguardHits(stdout: string): RawHit[] {
  const start = stdout.indexOf('{')
  if (start < 0) throw new Error(`cheatguard produced no json\n${stdout.slice(-1000)}`)
  const parsed: unknown = JSON.parse(stdout.slice(start))
  if (!isRecord(parsed) || !Array.isArray(parsed['violations'])) throw new Error('cheatguard json: missing violations')
  const hits: RawHit[] = []
  for (const v of parsed['violations']) {
    if (!isRecord(v)) continue
    const rule = v['rule']
    const file = v['file']
    const line = v['line']
    const detail = v['detail']
    if (typeof rule !== 'string' || typeof file !== 'string' || typeof detail !== 'string') continue
    const n = typeof line === 'number' && Number.isInteger(line) && line >= 1 ? line : 1
    hits.push({
      rule: `cheatguard(${rule})`,
      file: file.split('\\').join('/'),
      line: n,
      endLine: n,
      message: detail,
    })
  }
  return hits
}

async function runCheatguard(ctx: CheckCtx): Promise<CheckResult> {
  const state = await mkdtemp(join(tmpdir(), 'cg-state-'))
  try {
    const ran = await capture(CHEATGUARD, ['check', '--base', ctx.fromRef, '--format', 'json', '--no-lint'], {
      cwd: ctx.clone,
      timeoutMs: 60_000,
      env: { ...process.env, CHEATGUARD_STATE_HOME: state },
    })
    if (ran.code === 3) {
      throw new Error(`cheatguard tool error\n${ran.stderr}\n${ran.stdout}`)
    }
    return { hits: parseCheatguardHits(ran.stdout) }
  } finally {
    await rm(state, { recursive: true, force: true })
  }
}

async function gitCommit(dir: string, message: string): Promise<void> {
  const ran = await capture(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=sweep', '-c', 'user.email=sweep@example.test', 'commit', '-m', message],
    { cwd: dir, timeoutMs: 15_000 },
  )
  if (ran.code !== 0) throw new Error(`git commit: ${ran.stderr}`)
}

async function fixtureTsReset(): Promise<void> {
  const src = "const x: { id: string } = JSON.parse('{}')\nexport { x }\n"
  const result = await withFixture(
    'cli',
    async dir => {
      await writeTsconfig(dir)
      await writeFile(join(dir, 'src/a.ts'), src)
    },
    runTsReset,
  )
  mustHit(result, 'TS2322', 'ts-reset')
}

async function fixtureJscpd(): Promise<void> {
  const block = [
    'export function one(n: number): number {',
    '  const a = n + 1',
    '  const b = a * 2',
    '  const c = b - 3',
    '  const d = c / 4',
    '  return d + a + b + c',
    '}',
    'export function two(n: number): number {',
    '  const a = n + 1',
    '  const b = a * 2',
    '  const c = b - 3',
    '  const d = c / 4',
    '  return d + a + b + c',
    '}',
    '',
  ].join('\n')
  const result = await withFixture(
    'cli',
    async dir => {
      await writeTsconfig(dir)
      await writeFile(join(dir, 'src/dup.ts'), block)
    },
    runJscpd,
  )
  mustHit(result, 'jscpd(clone)', 'jscpd')
  if (result.metrics?.duplicationPct === undefined || result.metrics.duplicationPct <= 0) {
    throw new Error('jscpd: missing duplicationPct')
  }
}

async function fixtureNkzw(): Promise<void> {
  const result = await withFixture(
    'cli',
    async dir => {
      await writeTsconfig(dir)
      await writeFile(join(dir, 'src/a.ts'), 'export function f(x: any): any {\n  return x\n}\n')
    },
    runNkzw,
  )
  mustHit(result, 'no-explicit-any', 'nkzw-preset')
}

async function fixtureAntiSlop(): Promise<void> {
  const result = await withFixture(
    'cli',
    async dir => {
      await writeTsconfig(dir)
      await writeFile(join(dir, 'src/a.ts'), 'const users: string[] = []\nusers.filter(Boolean).map(String)\n')
    },
    runAntiSlop,
  )
  mustHit(result, 'no-array-filter-map', 'anti-slop')
}

async function fixtureCheatguard(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sweep-cg-'))
  try {
    await mkdir(join(dir, 'src'), { recursive: true })
    const init = await capture('git', ['-c', 'core.hooksPath=/dev/null', 'init'], { cwd: dir, timeoutMs: 15_000 })
    if (init.code !== 0) throw new Error(`git init: ${init.stderr}`)
    await writeFile(
      join(dir, 'src/a.test.ts'),
      "import { expect, test } from 'vitest'\ntest('ok', () => { expect(1 + 1).toBe(2) })\n",
    )
    const add = await capture('git', ['-c', 'core.hooksPath=/dev/null', 'add', 'src/a.test.ts'], {
      cwd: dir,
      timeoutMs: 15_000,
    })
    if (add.code !== 0) throw new Error(`git add: ${add.stderr}`)
    await gitCommit(dir, 'v0')
    await writeFile(
      join(dir, 'src/a.test.ts'),
      "import { expect, test } from 'vitest'\ntest.skip('ok', () => { expect(true).toBe(true) })\n",
    )
    const kind = getKind('cli')
    const files = await collectFiles(dir, kind)
    const result = await runCheatguard({ clone: dir, kind, kindId: 'cli', files, fromRef: 'HEAD', toRef: 'WORKING' })
    mustHit(result, 'test-weakened', 'cheatguard')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export const CHECKS: readonly CheckDef[] = [
  { id: 'tsgolint-extras', scope: 'final', run: runTsgolintExtras, fixture: fixtureTsgolintExtras },
  { id: 'react-compiler', scope: 'final', kinds: ['react'], run: runReactCompiler, fixture: fixtureReactCompiler },
  { id: 'complexity', scope: 'final', run: runComplexity, fixture: fixtureComplexity },
  { id: 'ts-reset', scope: 'final', run: runTsReset, fixture: fixtureTsReset },
  { id: 'jscpd', scope: 'final', run: runJscpd, fixture: fixtureJscpd },
  { id: 'nkzw-preset', scope: 'final', run: runNkzw, fixture: fixtureNkzw },
  { id: 'anti-slop', scope: 'final', run: runAntiSlop, fixture: fixtureAntiSlop },
  { id: 'cheatguard', scope: 'transitions', run: runCheatguard, fixture: fixtureCheatguard },
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
  const review = !argv.includes('--no-review')
  const model = flagOnce(argv, '--model') ?? DEFAULT_MODEL
  if (/grok/i.test(model)) throw new Error('sweep reviewer model must not be grok')
  const concurrencyRaw = flagOnce(argv, '--concurrency')
  const concurrency = Number(concurrencyRaw ?? String(DEFAULT_CONCURRENCY))
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer')
  const checkpointRaw = flagOnce(argv, '--checkpoint')
  let checkpoint: number | undefined
  if (checkpointRaw !== undefined) {
    checkpoint = Number(checkpointRaw)
    if (!Number.isInteger(checkpoint) || checkpoint < 1) throw new Error('--checkpoint must be a positive integer')
  }
  const valueFlags = new Set(['--concurrency', '--checkpoint', '--model'])
  const positional: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === undefined) continue
    if (a === '--self-check' || a === '--fresh' || a === '--no-review') continue
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
    return {
      selfCheck: true,
      runDir: undefined,
      concurrency,
      fresh: false,
      checkpoint: undefined,
      model,
      review: false,
    }
  }
  const runDir = positional[0]
  if (runDir === undefined || positional.length !== 1) {
    throw new Error(
      'usage: node evals/sweep.ts --self-check | node evals/sweep.ts <runDir> [--checkpoint N] [--concurrency 4] [--model gpt-5.6-sol-high] [--no-review] [--fresh]',
    )
  }
  return { selfCheck: false, runDir, concurrency, fresh, checkpoint, model, review }
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

function hitStub(file: string, rule: string): Hit {
  return {
    check: 'x',
    rule,
    file,
    line: 1,
    endLine: 1,
    message: 'm',
    code: 'product',
  }
}

function stratify<T>(items: T[], key: (item: T) => string, n: number): T[] {
  const buckets = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = buckets.get(k) ?? []
    list.push(item)
    buckets.set(k, list)
  }
  const keys = [...buckets.keys()].sort()
  const out: T[] = []
  while (out.length < n) {
    let added = false
    for (const k of keys) {
      const list = buckets.get(k)
      if (list === undefined || list.length === 0) continue
      const item = list.shift()
      if (item === undefined) continue
      out.push(item)
      added = true
      if (out.length >= n) break
    }
    if (!added) break
  }
  return out
}

function productHits(row: SweepRow): Hit[] {
  return row.hits.filter(h => h.code === 'product')
}

function agentHits(row: SweepRow): Hit[] {
  return row.hits.filter(h => h.code === 'agent-check')
}

function per1k(n: number, statements: number): number {
  if (statements <= 0) return 0
  return (1000 * n) / statements
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

function rangesOverlap(a: { min: number; max: number }, b: { min: number; max: number }): boolean {
  return a.min <= b.max && b.min <= a.max
}

function excerptOf(src: string, start: number, end: number): string {
  return src.split('\n').slice(start - 1, end).join('\n')
}

function reviewKey(row: Pick<SweepReviewRow, 'check' | 'id' | 'checkpoint' | 'file' | 'line' | 'endLine' | 'rule'>): string {
  return `${row.check}\t${row.id}\t${row.checkpoint}\t${row.file}\t${row.line}\t${row.endLine}\t${row.rule}`
}

function parseSweepReviewRow(raw: unknown): SweepReviewRow {
  if (!isRecord(raw)) throw new Error('sweep-review.jsonl row must be an object')
  const { check, id, problem, arm, rep, checkpoint, rule, file, line, endLine, message, excerpt, verdict, why } = raw
  if (
    typeof check !== 'string' ||
    typeof id !== 'string' ||
    typeof problem !== 'string' ||
    typeof rule !== 'string' ||
    typeof file !== 'string' ||
    typeof message !== 'string' ||
    typeof excerpt !== 'string' ||
    typeof why !== 'string'
  ) {
    throw new Error('sweep-review.jsonl missing strings')
  }
  if (arm !== 'plain' && arm !== 'lint') throw new Error('sweep-review.jsonl bad arm')
  if (typeof rep !== 'number' || typeof checkpoint !== 'number' || typeof line !== 'number' || typeof endLine !== 'number') {
    throw new Error('sweep-review.jsonl missing numbers')
  }
  if (verdict !== 'bug' && verdict !== 'fragile' && verdict !== 'style' && verdict !== 'noise') {
    throw new Error(`sweep-review.jsonl bad verdict ${String(verdict)}`)
  }
  const inputRaw = raw['input']
  const input = typeof inputRaw === 'string' ? inputRaw : null
  return { check, id, problem, arm, rep, checkpoint, rule, file, line, endLine, message, excerpt, verdict, why, input }
}

function parseBugReplay(raw: unknown): BugReplay {
  if (!isRecord(raw)) throw new Error('sweep-bugs.jsonl row must be an object')
  const { check, id, problem, arm, checkpoint, rule, file, line, input, exit, stdout, stderr } = raw
  if (
    typeof check !== 'string' ||
    typeof id !== 'string' ||
    typeof problem !== 'string' ||
    typeof rule !== 'string' ||
    typeof file !== 'string' ||
    typeof input !== 'string' ||
    typeof stdout !== 'string' ||
    typeof stderr !== 'string'
  ) {
    throw new Error('sweep-bugs.jsonl missing strings')
  }
  if (arm !== 'plain' && arm !== 'lint') throw new Error('sweep-bugs.jsonl bad arm')
  if (typeof checkpoint !== 'number' || typeof line !== 'number' || typeof exit !== 'number') {
    throw new Error('sweep-bugs.jsonl missing numbers')
  }
  return { check, id, problem, arm, checkpoint, rule, file, line, input, exit, stdout, stderr }
}

function sampleHits(rows: SweepRow[]): { row: SweepRow; hit: Hit }[] {
  const out: { row: SweepRow; hit: Hit }[] = []
  const checks = [...new Set(rows.map(r => r.check))].sort()
  for (const check of checks) {
    for (const arm of ['plain', 'lint'] as const) {
      const pairs: { row: SweepRow; hit: Hit }[] = []
      for (const row of rows) {
        if (row.check !== check || row.arm !== arm) continue
        for (const hit of productHits(row)) pairs.push({ row, hit })
      }
      pairs.sort((a, b) => {
        const ka = `${a.row.id}\t${a.hit.file}\t${a.hit.line}\t${a.hit.rule}`
        const kb = `${b.row.id}\t${b.hit.file}\t${b.hit.line}\t${b.hit.rule}`
        return ka.localeCompare(kb)
      })
      out.push(...stratify(pairs, p => p.hit.rule, SAMPLE_CAP))
    }
  }
  return out
}

async function replayCliInput(clone: string, input: string): Promise<{ exit: number; stdout: string; stderr: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'sweep-bug-'))
  try {
    const args = input.trim().split(/\s+/).filter(a => a !== '')
    const ran = await capture('node', [join(clone, 'src/cli.ts'), ...args], {
      cwd,
      timeoutMs: CLI_STEP_TIMEOUT_MS,
    })
    return { exit: ran.code, stdout: ran.stdout, stderr: ran.stderr }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

async function reviewSweep(opts: {
  runDir: string
  manifest: Manifest
  rows: SweepRow[]
  model: string
  concurrency: number
}): Promise<{ reviews: SweepReviewRow[]; bugs: BugReplay[] }> {
  const reviewPath = join(opts.runDir, 'sweep-review.jsonl')
  const bugPath = join(opts.runDir, 'sweep-bugs.jsonl')
  const existing = await readJsonl(reviewPath, parseSweepReviewRow)
  const done = new Set(existing.map(reviewKey))
  const samples = sampleHits(opts.rows).filter(s => {
    return !done.has(
      reviewKey({
        check: s.hit.check,
        id: s.row.id,
        checkpoint: s.row.checkpoint,
        file: s.hit.file,
        line: s.hit.line,
        endLine: s.hit.endLine,
        rule: s.hit.rule,
      }),
    )
  })
  const append = mutex()
  const byWs = new Map<string, WorkspaceRow>()
  for (const ws of opts.manifest.workspaces) byWs.set(ws.id, ws)
  type Job = { sample: { row: SweepRow; hit: Hit }; ws: WorkspaceRow }
  const jobs: Job[] = []
  for (const sample of samples) {
    const ws = byWs.get(sample.row.id)
    if (ws === undefined) continue
    jobs.push({ sample, ws })
  }
  await pool({
    items: jobs,
    concurrency: opts.concurrency,
    kindOf: job => job.sample.row.problem,
    kindLimit: () => undefined,
    run: async job => {
      const { row, hit } = job.sample
      process.stderr.write(`sweep review ${row.check} ${row.id} ${hit.rule} ${hit.file}:${hit.line}\n`)
      const problem = await loadProblem(row.problem)
      const kind = getKind(problem.kind)
      const clone = await mkdtemp(join(tmpdir(), 'sweep-rev-'))
      try {
        await cloneBundle(join(opts.runDir, job.ws.bundle), clone)
        await checkoutTag(clone, row.checkpoint)
        await kind.prepareGrade(clone)
        const files = await collectFiles(clone, kind)
        const src = files.get(hit.file) ?? ''
        const fileList = [...files.entries()].map(([path, content]) => ({ path, content }))
        const specs = problem.specs.slice(0, row.checkpoint)
        const lintHit = { rule: hit.rule, message: hit.message, file: hit.file, start: hit.line, end: hit.endLine }
        const prompt = benefitPrompt(specs, fileList, lintHit, src)
        assertBlind(
          benefitPrompt(
            specs,
            fileList.map(f => ({ path: f.path, content: '' })),
            lintHit,
            '',
          ),
          'sweep benefit prompt',
        )
        const answer = await askReviewer(prompt, opts.model)
        const parsed = parseBenefitAnswer(answer)
        const review: SweepReviewRow = {
          check: row.check,
          id: row.id,
          problem: row.problem,
          arm: row.arm,
          rep: row.rep,
          checkpoint: row.checkpoint,
          rule: hit.rule,
          file: hit.file,
          line: hit.line,
          endLine: hit.endLine,
          message: hit.message,
          excerpt: excerptOf(src, hit.line, hit.endLine),
          verdict: parsed.verdict,
          why: parsed.why,
          input: parsed.input,
        }
        await append(async () => {
          await appendFile(reviewPath, `${JSON.stringify(review)}\n`)
        })
        if (parsed.verdict === 'bug' && parsed.input !== null && problem.kind === 'cli') {
          process.stderr.write(`sweep bug-replay ${row.id} ${JSON.stringify(parsed.input)}\n`)
          const ran = await replayCliInput(clone, parsed.input)
          const bug: BugReplay = {
            check: row.check,
            id: row.id,
            problem: row.problem,
            arm: row.arm,
            checkpoint: row.checkpoint,
            rule: hit.rule,
            file: hit.file,
            line: hit.line,
            input: parsed.input,
            exit: ran.exit,
            stdout: ran.stdout,
            stderr: ran.stderr,
          }
          await append(async () => {
            await appendFile(bugPath, `${JSON.stringify(bug)}\n`)
          })
        }
      } finally {
        await rm(clone, { recursive: true, force: true })
      }
    },
  })
  const reviews = await readJsonl(reviewPath, parseSweepReviewRow)
  const bugs = await readJsonl(bugPath, parseBugReplay)
  return { reviews, bugs }
}

function seriesFor(
  rows: SweepRow[],
  check: string,
  arm: ArmId,
  pick: (row: SweepRow) => number,
): { mean: number; min: number; max: number } {
  return stats(rows.filter(r => r.check === check && r.arm === arm).map(pick))
}

function topRules(rows: SweepRow[], check: string, arm: ArmId, n: number): { rule: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.check !== check || row.arm !== arm) continue
    for (const hit of productHits(row)) counts.set(hit.rule, (counts.get(hit.rule) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule))
    .slice(0, n)
}

function verdictCounts(reviews: SweepReviewRow[], check: string, arm: ArmId): Record<BenefitVerdict, number> {
  const c: Record<BenefitVerdict, number> = { bug: 0, fragile: 0, style: 0, noise: 0 }
  for (const r of reviews) {
    if (r.check === check && r.arm === arm) c[r.verdict] += 1
  }
  return c
}

function pct(n: number, d: number): string {
  if (d === 0) return 'n/a'
  return `${Math.round((100 * n) / d)}%`
}

function examplesFor(
  reviews: SweepReviewRow[],
  check: string,
  arm: ArmId,
  verdict: BenefitVerdict,
  n: number,
): SweepReviewRow[] {
  return reviews.filter(r => r.check === check && r.arm === arm && r.verdict === verdict).slice(0, n)
}

function exampleLine(r: SweepReviewRow): string {
  const span = r.line === r.endLine ? `${r.file}:${r.line}` : `${r.file}:${r.line}-${r.endLine}`
  const extra = r.input !== null ? ` input \`${r.input}\`` : ''
  return `- \`${r.id}\` \`${span}\` ${r.verdict}${extra}: ${r.why}`
}

export function sweepMarkdown(
  rows: SweepRow[],
  reviews: SweepReviewRow[],
  bugs: BugReplay[],
  meta: { model: string },
): string {
  const checks = [...new Set(rows.map(r => r.check))].sort()
  const lines: string[] = [
    '# Sweep',
    '',
    'Candidate checks that neither eval arm enforced, scored on frozen snapshots.',
    `Reviewer model \`${meta.model}\`. Up to ${SAMPLE_CAP} product hits per check per arm, stratified by rule.`,
    'Would-have-caught is (share of reviewed hits that are `bug` or `fragile`) times product hits per 1k statements in plain.',
    '',
  ]
  if (DROPPED.length > 0) {
    lines.push('## Dropped', '')
    for (const d of DROPPED) lines.push(`- \`${d.id}\`: ${d.why}`)
    lines.push('')
  }
  for (const check of checks) {
    const plainP = seriesFor(rows, check, 'plain', r => per1k(productHits(r).length, r.statements))
    const lintP = seriesFor(rows, check, 'lint', r => per1k(productHits(r).length, r.statements))
    const plainA = seriesFor(rows, check, 'plain', r => per1k(agentHits(r).length, r.statements))
    const lintA = seriesFor(rows, check, 'lint', r => per1k(agentHits(r).length, r.statements))
    const ov = rangesOverlap(plainP, lintP) ? 'yes' : 'no'
    const delta = lintP.mean - plainP.mean
    const sign = delta > 0 ? '+' : ''
    lines.push(`## \`${check}\``, '')
    lines.push(
      '| metric | plain mean (min-max) | lint mean (min-max) | delta (lint - plain) | overlap |',
      '| --- | --- | --- | --- | --- |',
      `| product hits / 1k statements | ${fmt(plainP)} | ${fmt(lintP)} | ${sign}${delta.toFixed(2)} | ${ov} |`,
      `| agent-check hits / 1k statements | ${fmt(plainA)} | ${fmt(lintA)} | ${(lintA.mean - plainA.mean).toFixed(2)} | ${rangesOverlap(plainA, lintA) ? 'yes' : 'no'} |`,
    )
    const plainDup = rows.filter(r => r.check === check && r.arm === 'plain' && r.metrics?.duplicationPct !== undefined)
    const lintDup = rows.filter(r => r.check === check && r.arm === 'lint' && r.metrics?.duplicationPct !== undefined)
    if (plainDup.length > 0 || lintDup.length > 0) {
      const p = stats(plainDup.map(r => r.metrics?.duplicationPct ?? 0))
      const l = stats(lintDup.map(r => r.metrics?.duplicationPct ?? 0))
      lines.push(
        `| duplicated lines % | ${fmt(p)} | ${fmt(l)} | ${(l.mean - p.mean).toFixed(2)} | ${rangesOverlap(p, l) ? 'yes' : 'no'} |`,
      )
    }
    lines.push('')
    const topP = topRules(rows, check, 'plain', 8)
    const topL = topRules(rows, check, 'lint', 8)
    lines.push('Top product rules (plain): ' + (topP.length === 0 ? 'none.' : topP.map(t => `\`${t.rule}\` ${t.count}`).join(', ')))
    lines.push('Top product rules (lint): ' + (topL.length === 0 ? 'none.' : topL.map(t => `\`${t.rule}\` ${t.count}`).join(', ')))
    lines.push('')
    for (const arm of ['plain', 'lint'] as const) {
      const c = verdictCounts(reviews, check, arm)
      const n = c.bug + c.fragile + c.style + c.noise
      lines.push(
        `${arm} reviewer (${n}): bug ${pct(c.bug, n)}, fragile ${pct(c.fragile, n)}, style ${pct(c.style, n)}, noise ${pct(c.noise, n)}.`,
      )
      const bugsEx = examplesFor(reviews, check, arm, 'bug', 2)
      const fragEx = examplesFor(reviews, check, arm, 'fragile', 2)
      if (bugsEx.length === 0 && fragEx.length === 0) lines.push('No bug or fragile examples.')
      else {
        for (const r of [...bugsEx, ...fragEx]) lines.push(exampleLine(r))
      }
      lines.push('')
    }
  }
  lines.push('## Would-have-caught ranking', '')
  lines.push('Estimated plain-arm `bug`+`fragile` per 1k statements. Sample share times product-hit rate.', '')
  type Rank = { check: string; score: number; share: number; rate: number; reviewed: number }
  const ranks: Rank[] = []
  for (const check of checks) {
    const c = verdictCounts(reviews, check, 'plain')
    const reviewed = c.bug + c.fragile + c.style + c.noise
    const share = reviewed === 0 ? 0 : (c.bug + c.fragile) / reviewed
    const rate = seriesFor(rows, check, 'plain', r => per1k(productHits(r).length, r.statements)).mean
    ranks.push({ check, score: share * rate, share, rate, reviewed })
  }
  ranks.sort((a, b) => b.score - a.score || a.check.localeCompare(b.check))
  lines.push('| check | bug+fragile / 1k (plain, estimated) | sample share | product hits / 1k | reviewed |', '| --- | --- | --- | --- | --- |')
  for (const r of ranks) {
    lines.push(
      `| \`${r.check}\` | ${r.reviewed === 0 ? 'n/a' : r.score.toFixed(2)} | ${r.reviewed === 0 ? 'n/a' : `${Math.round(r.share * 100)}%`} | ${r.rate.toFixed(2)} | ${r.reviewed} |`,
    )
  }
  lines.push('', '## Displacement', '')
  lines.push(
    'Checks neither arm enforced, where lint has more product hits per 1k statements than plain and the min-max ranges do not overlap.',
    '',
  )
  const displaced: string[] = []
  for (const check of checks) {
    const plainP = seriesFor(rows, check, 'plain', r => per1k(productHits(r).length, r.statements))
    const lintP = seriesFor(rows, check, 'lint', r => per1k(productHits(r).length, r.statements))
    if (lintP.mean > plainP.mean && !rangesOverlap(plainP, lintP)) {
      displaced.push(
        `- \`${check}\`: lint ${fmt(lintP)} vs plain ${fmt(plainP)}`,
      )
    }
  }
  if (displaced.length === 0) lines.push('None.', '')
  else lines.push(...displaced, '')
  lines.push('## cheatguard', '')
  const cg = rows.filter(r => r.check === 'cheatguard')
  if (cg.length === 0) lines.push('No cheatguard rows.', '')
  else {
    const checkpoints = [...new Set(cg.map(r => r.checkpoint))].sort((a, b) => a - b)
    lines.push('| transition | plain hits (mean) | lint hits (mean) |', '| --- | --- | --- |')
    for (const n of checkpoints) {
      const p = stats(cg.filter(r => r.arm === 'plain' && r.checkpoint === n).map(r => r.hits.length))
      const l = stats(cg.filter(r => r.arm === 'lint' && r.checkpoint === n).map(r => r.hits.length))
      const from = n === 1 ? 'v0' : `v${n - 1}`
      lines.push(`| ${from}..v${n} | ${fmt(p, 2)} | ${fmt(l, 2)} |`)
    }
    lines.push('')
    const cgHits = cg.flatMap(r => r.hits.map(h => ({ row: r, hit: h })))
    const shown = cgHits.slice(0, 8)
    if (shown.length === 0) lines.push('No findings.', '')
    else {
      lines.push('Examples', '')
      for (const x of shown) {
        lines.push(
          `- \`${x.row.id}\` ${x.row.arm} v${x.row.checkpoint} \`${x.hit.rule}\` \`${x.hit.file}:${x.hit.line}\`: ${x.hit.message}`,
        )
      }
      lines.push('')
    }
  }
  if (bugs.length > 0) {
    lines.push('## CLI bug inputs', '')
    for (const b of bugs) {
      const out = b.stdout.trim() === '' ? '(empty stdout)' : b.stdout.trim().slice(0, 200)
      lines.push(
        `- \`${b.id}\` \`${b.check}\` input \`${b.input}\` exit ${b.exit}: ${out}`,
      )
    }
    lines.push('')
  }
  return `${lines.join('\n')}`
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
  if (!args.review || args.model !== DEFAULT_MODEL) throw new Error('parseArgs: review defaults')
  const sc = parseArgs(['--self-check'])
  if (!sc.selfCheck) throw new Error('parseArgs: --self-check')
  let threw = false
  try {
    parseArgs(['evals/runs/x', '--model', 'cursor-grok-4.6-high'])
  } catch {
    threw = true
  }
  if (!threw) throw new Error('parseArgs: grok must be rejected')
  const sampled = stratify(
    [
      hitStub('a', 'r1'),
      hitStub('b', 'r1'),
      hitStub('c', 'r2'),
      hitStub('d', 'r2'),
      hitStub('e', 'r3'),
    ],
    h => h.rule,
    4,
  )
  if (sampled.length !== 4) throw new Error('stratify length')
  const rules = sampled.map(h => h.rule)
  if (new Set(rules).size < 3) throw new Error('stratify should spread rules')
  const md = sweepMarkdown(
    [
      {
        id: 'ledger-plain-r1',
        problem: 'ledger',
        arm: 'plain',
        rep: 1,
        checkpoint: 5,
        check: 'tsgolint-extras',
        statements: 100,
        hits: [
          {
            check: 'tsgolint-extras',
            rule: 'typescript(no-unsafe-assignment)',
            file: 'src/cli.ts',
            line: 3,
            endLine: 3,
            message: 'Unsafe assignment',
            code: 'product',
          },
        ],
      },
      {
        id: 'ledger-lint-r1',
        problem: 'ledger',
        arm: 'lint',
        rep: 1,
        checkpoint: 5,
        check: 'tsgolint-extras',
        statements: 100,
        hits: [],
      },
    ],
    [
      {
        check: 'tsgolint-extras',
        id: 'ledger-plain-r1',
        problem: 'ledger',
        arm: 'plain',
        rep: 1,
        checkpoint: 5,
        rule: 'typescript(no-unsafe-assignment)',
        file: 'src/cli.ts',
        line: 3,
        endLine: 3,
        message: 'Unsafe assignment',
        excerpt: 'const x: T = JSON.parse("{}")',
        verdict: 'bug',
        why: 'JSON.parse is unknown.',
        input: 'balances ledger.json',
      },
    ],
    [],
    { model: DEFAULT_MODEL },
  )
  if (!md.includes('Would-have-caught ranking')) throw new Error('sweep.md ranking heading')
  if (!md.includes('type-coverage')) throw new Error('sweep.md dropped type-coverage')
  if (/grok/i.test(md)) throw new Error('sweep.md leaked grok')
  process.stderr.write(`self-check sweep ok: ${[...ids].join(', ')}; dropped ${DROPPED.map(d => d.id).join(', ') || '(none)'}\n`)
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
    await archiveIfPresent(join(runDir, 'sweep-review.jsonl'), join(runDir, 'sweep-review.v1.jsonl'))
    await archiveIfPresent(join(runDir, 'sweep-bugs.jsonl'), join(runDir, 'sweep-bugs.v1.jsonl'))
    await archiveIfPresent(join(runDir, 'sweep.md'), join(runDir, 'sweep.v1.md'))
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
  const rows = await readJsonl(join(runDir, 'sweep.jsonl'), parseSweepRow)
  let reviews: SweepReviewRow[] = []
  let bugs: BugReplay[] = []
  if (opts.review) {
    const out = await reviewSweep({
      runDir,
      manifest,
      rows,
      model: opts.model,
      concurrency: opts.concurrency,
    })
    reviews = out.reviews
    bugs = out.bugs
    process.stderr.write(`sweep review done (${reviews.length} verdicts, ${bugs.length} bug inputs)\n`)
  } else {
    reviews = await readJsonl(join(runDir, 'sweep-review.jsonl'), parseSweepReviewRow)
    bugs = await readJsonl(join(runDir, 'sweep-bugs.jsonl'), parseBugReplay)
  }
  const md = sweepMarkdown(rows, reviews, bugs, { model: opts.model })
  await writeFile(join(runDir, 'sweep.md'), md)
  process.stdout.write(md)
}

process.chdir(REPO_ROOT)
const argv = process.argv.slice(2)
const opts = parseArgs(argv)
if (opts.selfCheck) {
  await selfCheckSweep()
} else {
  await runSweep(opts)
}
