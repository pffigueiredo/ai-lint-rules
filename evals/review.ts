import { access, appendFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import {
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
  readJson,
  spawnCursorAgent,
  writeJson,
} from './lib.ts'
import { getKind, loadProblem } from './kinds.ts'

const OXLINT = join(REPO_ROOT, 'node_modules/.bin/oxlint')
const REVIEW_TIMEOUT_MS = 12 * 60_000
const CONTEXT_PAD = 20
const METRICS_CODE = 'metrics(file)'
const COMPLEXITY_CODE = 'eslint(complexity)'

export type BenefitVerdict = 'bug' | 'fragile' | 'style' | 'noise'

export type LintHit = {
  rule: string
  message: string
  file: string
  start: number
  end: number
}

export type BenefitRow = {
  kind: 'benefit'
  id: string
  problem: string
  arm: 'plain'
  rep: number
  checkpoint: number
  rule: string
  message: string
  file: string
  start: number
  end: number
  excerpt: string
  verdict: BenefitVerdict
  why: string
  input: string | null
}

type SrcFile = { path: string; content: string }

type ReviewOpts = {
  runDir: string
  model: string
  concurrency: number
  fresh: boolean
  checkpoint: number | undefined
}

function posixRel(from: string, to: string): string {
  return relative(from, to).split('\\').join('/')
}

function withLineNumbers(src: string): string {
  const lines = src.split('\n')
  const width = String(Math.max(lines.length, 1)).length
  return lines.map((line, i) => `${String(i + 1).padStart(width, ' ')} | ${line}`).join('\n')
}

function formatFiles(files: SrcFile[]): string {
  return files
    .map(f => `=== FILE: ${f.path} ===\n\`\`\`\n${withLineNumbers(f.content)}\n\`\`\`\n=== END FILE ===`)
    .join('\n\n')
}

function formatSpecs(specs: string[]): string {
  return specs.map((s, i) => `Requirement ${i + 1}:\n${s.trim()}`).join('\n\n')
}

function excerptOf(src: string, start: number, end: number): string {
  return src.split('\n').slice(start - 1, end).join('\n')
}

function lineCount(src: string): number {
  if (src === '') return 0
  return src.split('\n').length
}

function numberedSlice(src: string, from: number, to: number): string {
  const lines = src.split('\n')
  const width = String(Math.max(lines.length, 1)).length
  const lo = Math.max(1, from)
  const hi = Math.min(lines.length, to)
  const out: string[] = []
  for (let i = lo; i <= hi; i += 1) {
    const line = lines[i - 1] ?? ''
    out.push(`${String(i).padStart(width, ' ')} | ${line}`)
  }
  return out.join('\n')
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

function lastJsonObjects(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const v: unknown = JSON.parse(t)
      if (isRecord(v)) rows.push(v)
    } catch {
      continue
    }
  }
  if (rows.length > 0) return rows
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const v: unknown = JSON.parse(text.slice(start, end + 1))
    return isRecord(v) ? [v] : []
  } catch {
    return []
  }
}

function extractResult(stdout: string): string {
  const rows = lastJsonObjects(stdout)
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row === undefined) continue
    const result = row['result']
    if (typeof result === 'string' && result.trim() !== '') return result
  }
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start >= 0 && end > start) return stdout.slice(start, end + 1)
  throw new Error(`reviewer produced no result\n${stdout.slice(-2000)}`)
}

async function askReviewer(prompt: string, model: string): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'ask-'))
  try {
    const ran = await spawnCursorAgent({
      args: ['-p', '--mode', 'ask', '--trust', '--output-format', 'json', '--model', model, '--workspace', ws, prompt],
      cwd: ws,
      timeoutMs: REVIEW_TIMEOUT_MS,
    })
    if (ran.status !== 'ok') {
      throw new Error(`reviewer ${ran.status}${ran.error !== undefined ? `: ${ran.error}` : ''}\n${ran.stdout.slice(-1000)}`)
    }
    return extractResult(ran.stdout)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  const q = items.slice()
  const errors: unknown[] = []
  const workers = Array.from({ length: Math.min(n, Math.max(q.length, 1)) }, async () => {
    for (;;) {
      const item = q.shift()
      if (item === undefined) return
      await fn(item).catch((err: unknown) => {
        errors.push(err)
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      })
    }
  })
  await Promise.all(workers)
  if (errors.length > 0) throw new AggregateError(errors, `${errors.length} job(s) failed; rerun to resume`)
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

async function cloneBundle(bundlePath: string, dest: string): Promise<void> {
  const cloned = await capture('git', ['clone', bundlePath, dest], { cwd: process.cwd(), timeoutMs: 60_000 })
  if (cloned.code !== 0) throw new Error(`git clone ${bundlePath}: ${cloned.stderr}`)
}

async function checkoutTag(ws: string, n: number): Promise<void> {
  const co = await capture('git', ['checkout', '-f', `v${n}`], { cwd: ws, timeoutMs: 30_000 })
  if (co.code !== 0) throw new Error(`checkout v${n}: ${co.stderr}`)
}

async function collectSrc(ws: string, kind: Kind): Promise<SrcFile[]> {
  const abs = await kind.sourceFiles(join(ws, 'src'))
  abs.sort()
  const files: SrcFile[] = []
  for (const p of abs) {
    files.push({ path: posixRel(ws, p), content: await readFile(p, 'utf8') })
  }
  return files
}

export function isYardstickNoise(code: string): boolean {
  return code === METRICS_CODE || code === COMPLEXITY_CODE
}

export function parseLintHits(stdout: string, ws: string, files: Map<string, string>): LintHit[] {
  const start = stdout.indexOf('{')
  if (start < 0) return []
  const parsed: unknown = JSON.parse(stdout.slice(start))
  if (!isRecord(parsed) || !Array.isArray(parsed['diagnostics'])) {
    throw new Error('oxlint json: missing diagnostics')
  }
  const hits: LintHit[] = []
  for (const d of parsed['diagnostics']) {
    if (!isRecord(d)) continue
    const code = d['code']
    const severity = d['severity']
    const message = d['message']
    const filename = d['filename']
    if (typeof code !== 'string' || typeof message !== 'string' || typeof filename !== 'string') continue
    if (isYardstickNoise(code)) continue
    if (severity !== 'error') continue
    const file = posixRel(ws, filename.replace(/^file:\/\//, ''))
    const src = files.get(file)
    if (src === undefined) continue
    const span = hitSpan(d, src)
    if (span === undefined) continue
    hits.push({ rule: code, message, file, start: span.start, end: span.end })
  }
  return hits
}

function hitSpan(d: Record<string, unknown>, src: string): { start: number; end: number } | undefined {
  const labels = d['labels']
  if (!Array.isArray(labels) || labels.length === 0) return undefined
  let start = Number.POSITIVE_INFINITY
  let end = 0
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
    if (typeof offset === 'number' && typeof length === 'number' && length >= 0) {
      const endOff = offset + Math.max(length, 1) - 1
      end = Math.max(end, lineAt(src, endOff))
    }
  }
  const n = lineCount(src)
  if (!Number.isFinite(start) || start < 1 || end < start || end > n) return undefined
  return { start, end }
}

export function benefitKey(row: Pick<BenefitRow, 'id' | 'checkpoint' | 'file' | 'start' | 'end' | 'rule'>): string {
  return `benefit\t${row.id}\t${row.checkpoint}\t${row.file}\t${row.start}\t${row.end}\t${row.rule}`
}

function parseBenefitRow(raw: unknown): BenefitRow {
  if (!isRecord(raw) || raw['kind'] !== 'benefit') throw new Error('review.jsonl: expected benefit row')
  const { id, problem, arm, rep, checkpoint, rule, message, file, start, end, excerpt, verdict, why } = raw
  if (typeof id !== 'string' || typeof problem !== 'string' || typeof rule !== 'string' || typeof message !== 'string') {
    throw new Error('review.jsonl benefit row missing strings')
  }
  if (arm !== 'plain') throw new Error('review.jsonl benefit row: arm must be plain')
  if (typeof rep !== 'number' || typeof checkpoint !== 'number' || typeof start !== 'number' || typeof end !== 'number') {
    throw new Error('review.jsonl benefit row missing numbers')
  }
  if (typeof file !== 'string' || typeof excerpt !== 'string' || typeof why !== 'string') {
    throw new Error('review.jsonl benefit row missing fields')
  }
  if (verdict !== 'bug' && verdict !== 'fragile' && verdict !== 'style' && verdict !== 'noise') {
    throw new Error(`review.jsonl benefit row: bad verdict ${String(verdict)}`)
  }
  const inputRaw = raw['input']
  const input = inputRaw === null || inputRaw === undefined ? null : typeof inputRaw === 'string' ? inputRaw : null
  if (typeof inputRaw !== 'string' && inputRaw !== null && inputRaw !== undefined) {
    throw new Error('review.jsonl benefit row: input must be string or null')
  }
  return { kind: 'benefit', id, problem, arm, rep, checkpoint, rule, message, file, start, end, excerpt, verdict, why, input }
}

function parseJsonObject(text: string): Record<string, unknown> {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const blob = fence?.[1] ?? text
  const start = blob.indexOf('{')
  const end = blob.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`reviewer: no JSON\n${text.slice(0, 500)}`)
  const raw: unknown = JSON.parse(blob.slice(start, end + 1))
  if (!isRecord(raw)) throw new Error('reviewer: JSON is not an object')
  return raw
}

export function parseBenefitAnswer(text: string): { verdict: BenefitVerdict; why: string; input: string | null } {
  const raw = parseJsonObject(text)
  const verdict = raw['verdict']
  const why = raw['why']
  if (verdict !== 'bug' && verdict !== 'fragile' && verdict !== 'style' && verdict !== 'noise') {
    throw new Error(`benefit: bad verdict ${String(verdict)}`)
  }
  if (typeof why !== 'string' || why.trim() === '') throw new Error('benefit: missing why')
  const inputRaw = raw['input']
  let input: string | null = null
  if (typeof inputRaw === 'string' && inputRaw.trim() !== '') input = inputRaw.trim()
  if (verdict === 'bug' && input === null) throw new Error('benefit: bug verdict requires input')
  return { verdict, why: why.trim(), input }
}

export function benefitPrompt(specs: string[], files: SrcFile[], hit: LintHit, src: string): string {
  const ctxFrom = hit.start - CONTEXT_PAD
  const ctxTo = hit.end + CONTEXT_PAD
  return `You are reviewing one automated lint finding on a small program.

Many automated findings are noise. Agreeing with the tool is not the goal. Decide whether this finding is a real defect, a future maintenance risk, a style preference, or a misfire.

Pick exactly one verdict:
- bug: the flagged code is wrong on some input the spec allows. Name that input so a person can run it (CLI argv after src/cli.ts, or the user action in a UI).
- fragile: the code is correct now but likely to break as the codebase grows or is refactored. Say how.
- style: preference only. Behavior and structure stay sound if this stays.
- noise: the rule is misapplied here.

Reply with JSON only:
{"verdict":"bug","why":"one sentence","input":"..."}
{"verdict":"fragile","why":"one sentence"}
{"verdict":"style","why":"one sentence"}
{"verdict":"noise","why":"one sentence"}

For bug, input is required. For the others, omit input.

<spec>
${formatSpecs(specs)}
</spec>

Rule: ${hit.rule}
Message: ${hit.message}

Flagged span with nearby lines:
\`\`\`
${numberedSlice(src, ctxFrom, ctxTo)}
\`\`\`

${formatFiles(files)}
`
}

function assertBlind(text: string, label: string): void {
  if (/\b(plain|lint-arm|lint arm)\b/i.test(text)) throw new Error(`${label} leaks an arm name`)
  if (/grok/i.test(text)) throw new Error(`${label} leaks grok`)
  if (/\b(cursor-grok|gpt-5|claude-|gemini-)/i.test(text)) throw new Error(`${label} leaks a model id`)
}

async function collectPlainHits(
  runDir: string,
  ws: WorkspaceRow,
  requested: number | undefined,
): Promise<{ checkpoint: number; specs: string[]; files: SrcFile[]; hits: LintHit[] } | undefined> {
  const problem = await loadProblem(ws.problem)
  const kind = getKind(problem.kind)
  const clone = await mkdtemp(join(tmpdir(), 'rev-'))
  try {
    await cloneBundle(join(runDir, ws.bundle), clone)
    const tags = await listCheckpointTags(clone)
    const checkpoint = requested ?? tags[tags.length - 1]
    if (checkpoint === undefined || !tags.includes(checkpoint)) return undefined
    await checkoutTag(clone, checkpoint)
    await kind.prepareGrade(clone)
    const files = await collectSrc(clone, kind)
    const fileMap = new Map(files.map(f => [f.path, f.content]))
    const srcDir = join(clone, 'src')
    const specs = problem.specs.slice(0, checkpoint)
    if (files.length === 0) return { checkpoint, specs, files, hits: [] }
    const cfg = await kind.yardstickOxlint()
    const cfgPath = join(clone, '.metrics-oxlintrc.json')
    await writeJson(cfgPath, cfg)
    const ran = await capture(OXLINT, ['--format', 'json', '-c', cfgPath, srcDir], { cwd: clone, timeoutMs: 60_000 })
    await rm(cfgPath, { force: true })
    const hits = parseLintHits(ran.stdout, clone, fileMap)
    return { checkpoint, specs, files, hits }
  } finally {
    await rm(clone, { recursive: true, force: true })
  }
}

type BenefitJob = {
  ws: WorkspaceRow
  checkpoint: number
  hit: LintHit
  files: SrcFile[]
  specs: string[]
  src: string
}

export async function runReview(opts: ReviewOpts): Promise<void> {
  const manifest: Manifest = parseManifest(await readJson(join(opts.runDir, 'manifest.json')))
  if (opts.fresh) {
    await archiveIfPresent(join(opts.runDir, 'review.jsonl'), join(opts.runDir, 'review.v1.jsonl'))
    await archiveIfPresent(join(opts.runDir, 'review.md'), join(opts.runDir, 'review.v1.md'))
  }
  const existing = await readJsonl(join(opts.runDir, 'review.jsonl'), raw => {
    if (!isRecord(raw)) throw new Error('review.jsonl row must be an object')
    if (raw['kind'] === 'benefit') return parseBenefitRow(raw)
    throw new Error(`review.jsonl: unknown kind ${String(raw['kind'])}`)
  })
  const done = new Set(existing.filter((r): r is BenefitRow => r.kind === 'benefit').map(benefitKey))
  const jobs: BenefitJob[] = []
  for (const ws of manifest.workspaces) {
    if (ws.arm !== 'plain') continue
    process.stderr.write(`review collect ${ws.id}\n`)
    const snap = await collectPlainHits(opts.runDir, ws, opts.checkpoint)
    if (snap === undefined) continue
    const fileMap = new Map(snap.files.map(f => [f.path, f.content]))
    for (const hit of snap.hits) {
      const src = fileMap.get(hit.file)
      if (src === undefined) continue
      const key = benefitKey({
        id: ws.id,
        checkpoint: snap.checkpoint,
        file: hit.file,
        start: hit.start,
        end: hit.end,
        rule: hit.rule,
      })
      if (done.has(key)) continue
      jobs.push({ ws, checkpoint: snap.checkpoint, hit, files: snap.files, specs: snap.specs, src })
    }
  }
  const append = mutex()
  await pool(jobs, opts.concurrency, async job => {
    process.stderr.write(`review benefit ${job.ws.id} ${job.hit.rule} ${job.hit.file}:${job.hit.start}\n`)
    const prompt = benefitPrompt(job.specs, job.files, job.hit, job.src)
    assertBlind(prompt, 'benefit prompt')
    const answer = await askReviewer(prompt, opts.model)
    const parsed = parseBenefitAnswer(answer)
    const row: BenefitRow = {
      kind: 'benefit',
      id: job.ws.id,
      problem: job.ws.problem,
      arm: 'plain',
      rep: job.ws.rep,
      checkpoint: job.checkpoint,
      rule: job.hit.rule,
      message: job.hit.message,
      file: job.hit.file,
      start: job.hit.start,
      end: job.hit.end,
      excerpt: excerptOf(job.src, job.hit.start, job.hit.end),
      verdict: parsed.verdict,
      why: parsed.why,
      input: parsed.input,
    }
    await append(async () => {
      await appendFile(join(opts.runDir, 'review.jsonl'), `${JSON.stringify(row)}\n`)
    })
  })
  process.stderr.write(`review benefit done (${jobs.length} new, ${done.size} kept)\n`)
}

function sampleHitJson(): string {
  return JSON.stringify({
    diagnostics: [
      {
        message: 'Unexpected console statement.',
        code: 'eslint(no-console)',
        severity: 'error',
        filename: '/tmp/ws/src/cli.ts',
        labels: [{ span: { offset: 6, length: 11, line: 2, column: 1 } }],
      },
      {
        message: 'Forbidden non-null assertion.',
        code: 'typescript(no-non-null-assertion)',
        severity: 'error',
        filename: '/tmp/ws/src/cli.ts',
        labels: [{ span: { offset: 30, length: 2, line: 3, column: 1 } }],
      },
      {
        message: 'statements 3 moduleComplexity 1',
        code: METRICS_CODE,
        severity: 'error',
        filename: '/tmp/ws/src/cli.ts',
        labels: [{ span: { offset: 0, length: 1, line: 1, column: 1 } }],
      },
      {
        message: 'function has a complexity of 4',
        code: COMPLEXITY_CODE,
        severity: 'error',
        filename: '/tmp/ws/src/cli.ts',
        labels: [{ span: { offset: 0, length: 1, line: 1, column: 1 } }],
      },
      {
        message: 'hint only',
        code: 'eslint(no-console)',
        severity: 'warning',
        filename: '/tmp/ws/src/cli.ts',
        labels: [{ span: { offset: 6, length: 11, line: 2, column: 1 } }],
      },
    ],
  })
}

export async function selfCheckReview(): Promise<void> {
  const src = 'const x = 1\nconsole.log(x)\nargs[i]!\n'
  const files = new Map([['src/cli.ts', src]])
  const hits = parseLintHits(sampleHitJson(), '/tmp/ws', files)
  if (hits.length !== 2) throw new Error(`parseLintHits: want 2, got ${hits.length}`)
  const consoleHit = hits.find(h => h.rule === 'eslint(no-console)')
  if (consoleHit === undefined || consoleHit.start !== 2 || consoleHit.end !== 2) {
    throw new Error('parseLintHits: no-console span')
  }
  const bang = hits.find(h => h.rule === 'typescript(no-non-null-assertion)')
  if (bang === undefined || bang.start !== 3) throw new Error('parseLintHits: non-null span')

  const bug = parseBenefitAnswer('{"verdict":"bug","why":"drops extra csv columns.","input":"import extra.csv"}')
  if (bug.verdict !== 'bug' || bug.input !== 'import extra.csv') throw new Error('parseBenefitAnswer: bug')
  const noise = parseBenefitAnswer('```json\n{"verdict":"noise","why":"CLI output."}\n```')
  if (noise.verdict !== 'noise' || noise.input !== null) throw new Error('parseBenefitAnswer: noise')
  let threw = false
  try {
    parseBenefitAnswer('{"verdict":"bug","why":"bad"}')
  } catch {
    threw = true
  }
  if (!threw) throw new Error('parseBenefitAnswer: bug without input should fail')

  const prompt = benefitPrompt(
    ['Print a total.'],
    [{ path: 'src/cli.ts', content: src }],
    { rule: 'eslint(no-console)', message: 'Unexpected console statement.', file: 'src/cli.ts', start: 2, end: 2 },
    src,
  )
  assertBlind(prompt, 'benefit self-check prompt')
  if (!prompt.includes('Many automated findings are noise')) {
    throw new Error('benefit prompt must tell the reviewer that findings are often noise')
  }
  if (!prompt.includes('eslint(no-console)')) throw new Error('benefit prompt missing rule')
  if (prompt.includes(EVALS_DIR) || prompt.includes(METRICS_PLUGIN)) throw new Error('benefit prompt leaks repo paths')

  const dir = await mkdtemp(join(tmpdir(), 'rev-fresh-'))
  try {
    await writeFile(join(dir, 'review.jsonl'), 'one\n')
    await archiveIfPresent(join(dir, 'review.jsonl'), join(dir, 'review.v1.jsonl'))
    if (await exists(join(dir, 'review.jsonl'))) throw new Error('fresh: review.jsonl should have moved')
    if ((await readFile(join(dir, 'review.v1.jsonl'), 'utf8')) !== 'one\n') throw new Error('fresh: review.v1.jsonl mismatch')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  process.stderr.write('self-check review parsers ok\n')
}
