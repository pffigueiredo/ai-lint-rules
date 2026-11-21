import { access, appendFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import {
  type ArmId,
  type Manifest,
  type WorkspaceRow,
  EVALS_DIR,
  capture,
  isRecord,
  listCheckpointTags,
  parseManifest,
  readJson,
  spawnCursorAgent,
  walkSource,
} from './lib.ts'
import { loadProblem } from './kinds.ts'

const DEFAULT_MODEL = 'gpt-5.6-sol-high'
const JUDGE_TIMEOUT_MS = 12 * 60_000
const CONF_KEEP = 3

type Criterion = {
  name: string
  category: string
  type: 'verbosity' | 'erosion'
  description: string
  positive_indicators: string[]
  negative_indicators: string[]
  source: 'scbench' | 'local'
  rule: string[] | null
}

type Flag = {
  file: string
  start: number
  end: number
  criteria: string
  explanation: string
  confidence: number
  excerpt: string
  origin: 'new' | 'carried'
}

type Dropped = { unknownCriteria: number; outOfRange: number }

type JudgeRow = {
  id: string
  problem: string
  arm: ArmId
  rep: number
  checkpoint: number
  flags: Flag[]
  dropped: Dropped
}

type PairwiseRow = {
  problem: string
  rep: number
  aArm: ArmId
  bArm: ArmId
  pick: 'A' | 'B' | 'tie'
  readability: number
  easeOfExtension: number
  robustness: number
  slop: number
  reason: string
}

type GradeRow = {
  id: string
  problem: string
  arm: ArmId
  rep: number
  checkpoint: number
  statements: number
}

type SrcFile = { path: string; content: string }

type Opts = {
  selfCheck: boolean
  runDir: string | undefined
  model: string
  concurrency: number
  fresh: boolean
}

function flagOnce(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== name) continue
    const v = argv[i + 1]
    if (v === undefined) throw new Error(`missing value for ${name}`)
    return v
  }
  return undefined
}

function parseArgs(argv: string[]): Opts {
  const selfCheck = argv.includes('--self-check')
  const fresh = argv.includes('--fresh')
  const model = flagOnce(argv, '--model') ?? DEFAULT_MODEL
  if (/grok/i.test(model)) throw new Error('judge model must not be grok (the candidate is grok)')
  const concurrencyRaw = flagOnce(argv, '--concurrency')
  const concurrency = Number(concurrencyRaw ?? '4')
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer')
  const positional = argv.filter(
    (a, i) =>
      a !== '--self-check' &&
      a !== '--fresh' &&
      a !== '--model' &&
      a !== '--concurrency' &&
      argv[i - 1] !== '--model' &&
      argv[i - 1] !== '--concurrency',
  )
  if (selfCheck) {
    if (fresh) throw new Error('--fresh does not apply to --self-check')
    return { selfCheck: true, runDir: undefined, model, concurrency, fresh: false }
  }
  const runDir = positional[0]
  if (runDir === undefined || positional.length !== 1) {
    throw new Error('usage: node evals/judge.ts <runDir> [--model gpt-5.6-sol-high] [--concurrency 4] [--fresh]')
  }
  return { selfCheck: false, runDir, model, concurrency, fresh }
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

async function loadRubric(): Promise<Criterion[]> {
  const text = await readFile(join(EVALS_DIR, 'rubric.jsonl'), 'utf8')
  const out: Criterion[] = []
  let n = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    n += 1
    out.push(parseCriterion(JSON.parse(line), `rubric.jsonl:${n}`))
  }
  if (out.length === 0) throw new Error('rubric.jsonl is empty')
  return out
}

function parseStringArray(v: unknown, at: string): string[] {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${at}: want string[]`)
  return v
}

function parseCriterion(raw: unknown, at: string): Criterion {
  if (!isRecord(raw)) throw new Error(`${at}: not an object`)
  const name = raw['name']
  const category = raw['category']
  const type = raw['type']
  const description = raw['description']
  const source = raw['source']
  if (typeof name !== 'string' || typeof category !== 'string' || typeof description !== 'string') {
    throw new Error(`${at}: missing strings`)
  }
  if (type !== 'verbosity' && type !== 'erosion') throw new Error(`${at}: bad type`)
  if (source !== 'scbench' && source !== 'local') throw new Error(`${at}: bad source`)
  const ruleRaw = raw['rule']
  let rule: string[] | null
  if (ruleRaw === null) rule = null
  else {
    const xs = parseStringArray(ruleRaw, `${at}.rule`)
    rule = xs.length === 0 ? null : xs
  }
  return {
    name,
    category,
    type,
    description,
    positive_indicators: parseStringArray(raw['positive_indicators'], `${at}.positive_indicators`),
    negative_indicators: parseStringArray(raw['negative_indicators'], `${at}.negative_indicators`),
    source,
    rule,
  }
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
  if (stdout.includes('=== FILE:')) return stdout
  throw new Error(`judge produced no result\n${stdout.slice(-2000)}`)
}

async function askJudge(prompt: string, model: string): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'ask-'))
  try {
    const ran = await spawnCursorAgent({
      args: ['-p', '--mode', 'ask', '--trust', '--output-format', 'json', '--model', model, '--workspace', ws, prompt],
      cwd: ws,
      timeoutMs: JUDGE_TIMEOUT_MS,
    })
    if (ran.status !== 'ok') {
      throw new Error(`judge ${ran.status}${ran.error !== undefined ? `: ${ran.error}` : ''}\n${ran.stdout.slice(-1000)}`)
    }
    return extractResult(ran.stdout)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
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

function formatCriteria(criteria: Criterion[]): string {
  return criteria
    .map(c => {
      const pos = c.positive_indicators.map(x => `- ${x}`).join('\n')
      const neg = c.negative_indicators.map(x => `- ${x}`).join('\n')
      return `[${c.name}] ${c.description}\n\nPositive Indicators:\n${pos}\n\nNegative Indicators:\n${neg}`
    })
    .join('\n\n')
}

function formatSpecs(specs: string[]): string {
  return specs.map((s, i) => `Requirement ${i + 1}:\n${s.trim()}`).join('\n\n')
}

function flaggingPrompt(specs: string[], files: SrcFile[], criteria: Criterion[]): string {
  return `You are an expert file grading specialist with meticulous attention to detail and systematic evaluation methodology. Your role is to thoroughly evaluate files against provided criteria, ensuring no occurrence is missed.

## Grading Process

Follow this exact process for each file:

### Step 1: Read and Understand
- Read all target files completely to understand their structure and content
- Review all criteria to understand what you are looking for
- Note the required output format for flagged items

### Step 2: Systematic Evaluation

1. Mark every criteria that occurs in the portion of code you are currently reading
2. Document with precision. Record the following for each occurrence:
- The "criteria" field is the name of the criteria from the rubric you are flagging.
- The "start" field is the starting line number of the span and "end" is the ending line number of the span.
- The "explanation" field should be a string (1 sentence) explaining why the span was flagged
- The "confidence" field is a number between 1 and 5, 1 being the lowest and 5 being the highest, indicating how certain you are about the flagged span fully satisfying the criteria.

## Quality Standards

1. Exhaustive Coverage: Find EVERY occurrence in ALL files, not just the first or most obvious
2. No False Negatives: When in doubt, flag the span with the lowest confidence level.
3. Precise Locations: Always include exact line numbers
4. Consistent Formatting: Follow the specified output format exactly

Output your grades grouped by file using the exact format below. For EACH file, output:
1. === FILE: {exact_file_path} === header
2. A JSON array in a markdown code block containing all grades for that file
3. === END FILE === footer

If a file has no issues, output an empty array [] for that file.
IMPORTANT: Output a section for EVERY file listed below, even if it has no issues.

Each grade object: {"criteria": "<name>", "start": <int>, "end": <int>, "explanation": "<one sentence>", "confidence": <1-5>}

---
Here is the specification for the files you are grading:
<spec>
${formatSpecs(specs)}
</spec>

${formatFiles(files)}

Here is the rubric criteria:
${formatCriteria(criteria)}
`
}

function pairwisePrompt(specs: string[], a: SrcFile[], b: SrcFile[]): string {
  return `You will compare two implementations of the same specification. They are labeled Project A and Project B. You do not know who wrote them.

Which would you rather own and extend for a year?

Score Project A 1-5 on:
- readability (5 is easier to read)
- ease_of_extension (5 is easier to extend)
- robustness (5 is more robust)
- slop (5 is more slop: verbosity, defensive theater, stubs, hidden behavior, overengineering)

Pick overall "A", "B", or "tie" for which you would rather own. Write two or three sentences in "reason".

Reply with JSON only:
{"readability":1,"ease_of_extension":1,"robustness":1,"slop":1,"pick":"A","reason":"..."}

<spec>
${formatSpecs(specs)}
</spec>

=== Project A ===
${formatFiles(a)}

=== Project B ===
${formatFiles(b)}
`
}

function lineCount(src: string): number {
  if (src === '') return 0
  return src.split('\n').length
}

function excerptOf(src: string, start: number, end: number): string {
  return src.split('\n').slice(start - 1, end).join('\n')
}

function normalizeCode(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function extractJsonArray(text: string): unknown {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < start) return []
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
}

function parseGrades(answer: string, files: Map<string, string>, known: Set<string>): { flags: Omit<Flag, 'origin'>[]; dropped: Dropped } {
  const dropped: Dropped = { unknownCriteria: 0, outOfRange: 0 }
  const flags: Omit<Flag, 'origin'>[] = []
  const re = /=== FILE:\s*(.+?)\s*===\s*([\s\S]*?)=== END FILE ===/g
  for (;;) {
    const m = re.exec(answer)
    if (m === null) break
    const rawPath = m[1]
    const body = m[2]
    if (rawPath === undefined || body === undefined) continue
    const file = rawPath.replaceAll('\\', '/').replace(/^\.\//, '')
    const src = files.get(file)
    if (src === undefined) {
      dropped.outOfRange += 1
      continue
    }
    const arr = extractJsonArray(body)
    if (!Array.isArray(arr)) continue
    const nLines = lineCount(src)
    for (const item of arr) {
      if (!isRecord(item)) continue
      const criteria = typeof item['criteria'] === 'string' ? item['criteria'] : item['criterion']
      if (typeof criteria !== 'string' || !known.has(criteria)) {
        dropped.unknownCriteria += 1
        continue
      }
      const start = item['start']
      const end = item['end']
      const explanation = item['explanation']
      const confidence = item['confidence']
      if (typeof start !== 'number' || typeof end !== 'number' || typeof explanation !== 'string' || typeof confidence !== 'number') {
        dropped.outOfRange += 1
        continue
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start || end > nLines || confidence < 1 || confidence > 5) {
        dropped.outOfRange += 1
        continue
      }
      flags.push({
        file,
        start,
        end,
        criteria,
        explanation,
        confidence,
        excerpt: excerptOf(src, start, end),
      })
    }
  }
  return { flags, dropped }
}

function markOrigin(flags: Omit<Flag, 'origin'>[], prev: Flag[]): Flag[] {
  const prevNorm = new Map<string, Set<string>>()
  for (const f of prev) {
    const set = prevNorm.get(f.criteria) ?? new Set<string>()
    set.add(normalizeCode(f.excerpt))
    prevNorm.set(f.criteria, set)
  }
  return flags.map(f => {
    const set = prevNorm.get(f.criteria)
    const origin: 'new' | 'carried' = set !== undefined && set.has(normalizeCode(f.excerpt)) ? 'carried' : 'new'
    return { ...f, origin }
  })
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

function parseJudgeRow(raw: unknown): JudgeRow {
  if (!isRecord(raw)) throw new Error('judge.jsonl row must be an object')
  const { id, problem, arm, rep, checkpoint, flags, dropped } = raw
  if (typeof id !== 'string' || typeof problem !== 'string' || typeof checkpoint !== 'number' || typeof rep !== 'number') {
    throw new Error('judge.jsonl row missing fields')
  }
  if (arm !== 'plain' && arm !== 'lint') throw new Error(`bad arm ${String(arm)}`)
  if (!Array.isArray(flags) || !isRecord(dropped)) throw new Error('judge.jsonl row missing flags')
  return raw as JudgeRow
}

function parsePairwiseRow(raw: unknown): PairwiseRow {
  if (!isRecord(raw)) throw new Error('pairwise.jsonl row must be an object')
  return raw as PairwiseRow
}

function parseGradeRow(raw: unknown): GradeRow {
  if (!isRecord(raw)) throw new Error('results.jsonl row must be an object')
  const { id, problem, arm, rep, checkpoint, statements } = raw
  if (typeof id !== 'string' || typeof problem !== 'string' || typeof checkpoint !== 'number' || typeof rep !== 'number') {
    throw new Error('results.jsonl row missing fields')
  }
  if (arm !== 'plain' && arm !== 'lint') throw new Error(`bad arm ${String(arm)}`)
  if (typeof statements !== 'number') throw new Error('results.jsonl row missing statements')
  return { id, problem, arm, rep, checkpoint, statements }
}

async function collectSrc(ws: string): Promise<SrcFile[]> {
  const abs = await walkSource(join(ws, 'src'), ['.ts', '.tsx'])
  abs.sort()
  const files: SrcFile[] = []
  for (const p of abs) {
    files.push({ path: posixRel(ws, p), content: await readFile(p, 'utf8') })
  }
  return files
}

function filesMap(files: SrcFile[]): Map<string, string> {
  return new Map(files.map(f => [f.path, f.content]))
}

async function cloneBundle(bundlePath: string, dest: string): Promise<void> {
  const cloned = await capture('git', ['clone', bundlePath, dest], { cwd: process.cwd(), timeoutMs: 60_000 })
  if (cloned.code !== 0) throw new Error(`git clone ${bundlePath}: ${cloned.stderr}`)
}

async function checkoutTag(ws: string, n: number): Promise<void> {
  const co = await capture('git', ['checkout', '-f', `v${n}`], { cwd: ws, timeoutMs: 30_000 })
  if (co.code !== 0) throw new Error(`checkout v${n}: ${co.stderr}`)
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

function snapshotKey(id: string, checkpoint: number): string {
  return `${id}\t${checkpoint}`
}

function pairwiseKey(row: Pick<PairwiseRow, 'problem' | 'rep' | 'aArm' | 'bArm'>): string {
  return `${row.problem}\t${row.rep}\t${row.aArm}\t${row.bArm}`
}

async function judgeWorkspace(
  runDir: string,
  ws: WorkspaceRow,
  criteria: Criterion[],
  known: Set<string>,
  model: string,
  done: Set<string>,
  prevByKey: Map<string, Flag[]>,
  append: (fn: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const problem = await loadProblem(ws.problem)
  const clone = await mkdtemp(join(tmpdir(), 'snap-'))
  try {
    await cloneBundle(join(runDir, ws.bundle), clone)
    const tags = await listCheckpointTags(clone)
    for (const n of tags) {
      const key = snapshotKey(ws.id, n)
      if (done.has(key)) continue
      process.stderr.write(`judge ${ws.id} checkpoint ${n}\n`)
      await checkoutTag(clone, n)
      const files = await collectSrc(clone)
      const specs = problem.specs.slice(0, n)
      const answer = await askJudge(flaggingPrompt(specs, files, criteria), model)
      if (!answer.includes('=== FILE:')) {
        throw new Error(`judge returned no FILE sections for ${ws.id} v${n}\n${answer.slice(0, 500)}`)
      }
      const parsed = parseGrades(answer, filesMap(files), known)
      const prev = n === 1 ? [] : (prevByKey.get(snapshotKey(ws.id, n - 1)) ?? [])
      const flags = markOrigin(parsed.flags, prev)
      const row: JudgeRow = {
        id: ws.id,
        problem: ws.problem,
        arm: ws.arm,
        rep: ws.rep,
        checkpoint: n,
        flags,
        dropped: parsed.dropped,
      }
      await append(async () => {
        await appendFile(join(runDir, 'judge.jsonl'), `${JSON.stringify(row)}\n`)
      })
      done.add(key)
      prevByKey.set(key, flags)
    }
  } finally {
    await rm(clone, { recursive: true, force: true })
  }
}

function parsePick(v: unknown): 'A' | 'B' | 'tie' {
  if (v === 'A' || v === 'a') return 'A'
  if (v === 'B' || v === 'b') return 'B'
  if (v === 'tie' || v === 'Tie' || v === 'TIE') return 'tie'
  throw new Error(`bad pick ${String(v)}`)
}

function parseScore(v: unknown, name: string): number {
  if (typeof v !== 'number' || v < 1 || v > 5) throw new Error(`bad ${name}`)
  return v
}

function parsePairwiseAnswer(text: string): Omit<PairwiseRow, 'problem' | 'rep' | 'aArm' | 'bArm'> {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const blob = fence?.[1] ?? text
  const start = blob.indexOf('{')
  const end = blob.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`pairwise: no JSON\n${text.slice(0, 500)}`)
  const raw: unknown = JSON.parse(blob.slice(start, end + 1))
  if (!isRecord(raw)) throw new Error('pairwise: JSON is not an object')
  const reason = raw['reason']
  if (typeof reason !== 'string' || reason.trim() === '') throw new Error('pairwise: missing reason')
  return {
    pick: parsePick(raw['pick']),
    readability: parseScore(raw['readability'], 'readability'),
    easeOfExtension: parseScore(raw['ease_of_extension'] ?? raw['easeOfExtension'], 'ease_of_extension'),
    robustness: parseScore(raw['robustness'], 'robustness'),
    slop: parseScore(raw['slop'], 'slop'),
    reason: reason.trim(),
  }
}

async function loadFinalSrc(runDir: string, ws: WorkspaceRow): Promise<{ specs: string[]; files: SrcFile[] }> {
  const problem = await loadProblem(ws.problem)
  const clone = await mkdtemp(join(tmpdir(), 'pair-'))
  try {
    await cloneBundle(join(runDir, ws.bundle), clone)
    const tags = await listCheckpointTags(clone)
    const last = tags[tags.length - 1]
    if (last === undefined) throw new Error(`${ws.id} has no checkpoints`)
    await checkoutTag(clone, last)
    return { specs: problem.specs.slice(0, last), files: await collectSrc(clone) }
  } finally {
    await rm(clone, { recursive: true, force: true })
  }
}

async function runPairwise(
  runDir: string,
  manifest: Manifest,
  model: string,
  concurrency: number,
  done: Set<string>,
): Promise<void> {
  const byPair = new Map<string, { plain?: WorkspaceRow; lint?: WorkspaceRow }>()
  for (const ws of manifest.workspaces) {
    const k = `${ws.problem}\t${ws.rep}`
    const slot = byPair.get(k) ?? {}
    if (ws.arm === 'plain') slot.plain = ws
    else slot.lint = ws
    byPair.set(k, slot)
  }
  const jobs: { problem: string; rep: number; a: WorkspaceRow; b: WorkspaceRow }[] = []
  for (const slot of byPair.values()) {
    if (slot.plain === undefined || slot.lint === undefined) continue
    jobs.push({ problem: slot.plain.problem, rep: slot.plain.rep, a: slot.plain, b: slot.lint })
    jobs.push({ problem: slot.plain.problem, rep: slot.plain.rep, a: slot.lint, b: slot.plain })
  }
  const pending = jobs.filter(job => !done.has(pairwiseKey({ problem: job.problem, rep: job.rep, aArm: job.a.arm, bArm: job.b.arm })))
  const append = mutex()
  await pool(pending, concurrency, async job => {
    process.stderr.write(`pairwise ${job.problem} r${job.rep} A=${job.a.arm} B=${job.b.arm}\n`)
    const [a, b] = await Promise.all([loadFinalSrc(runDir, job.a), loadFinalSrc(runDir, job.b)])
    const answer = await askJudge(pairwisePrompt(a.specs, a.files, b.files), model)
    const parsed = parsePairwiseAnswer(answer)
    const row: PairwiseRow = {
      problem: job.problem,
      rep: job.rep,
      aArm: job.a.arm,
      bArm: job.b.arm,
      ...parsed,
    }
    await append(async () => {
      await appendFile(join(runDir, 'pairwise.jsonl'), `${JSON.stringify(row)}\n`)
    })
    done.add(pairwiseKey(row))
  })
}

type Series = { mean: number; min: number; max: number }

function stats(xs: number[]): Series {
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

function fmt(s: Series, digits = 2): string {
  return `${s.mean.toFixed(digits)} (${s.min.toFixed(digits)}-${s.max.toFixed(digits)})`
}

function rangesOverlap(a: Series, b: Series): boolean {
  return a.min <= b.max && b.min <= a.max
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

function kept(flags: Flag[]): Flag[] {
  return flags.filter(f => f.confidence >= CONF_KEEP)
}

function per100(flags: number, statements: number): number {
  if (statements === 0) return 0
  return (100 * flags) / statements
}

function hasRule(c: Criterion | undefined): boolean {
  return c !== undefined && c.rule !== null
}

type Snap = {
  id: string
  problem: string
  arm: ArmId
  rep: number
  checkpoint: number
  statements: number
  flags: Flag[]
}

function lastByWorkspace(snaps: Snap[]): Snap[] {
  const byId = new Map<string, Snap>()
  for (const s of snaps) {
    const cur = byId.get(s.id)
    if (cur === undefined || s.checkpoint > cur.checkpoint) byId.set(s.id, s)
  }
  return [...byId.values()]
}

function armSeries(snaps: Snap[], arm: ArmId, fn: (s: Snap) => number): Series {
  return stats(snaps.filter(s => s.arm === arm).map(fn))
}

function winnerOf(row: PairwiseRow): 'plain' | 'lint' | 'tie' {
  if (row.pick === 'tie') return 'tie'
  const chosen = row.pick === 'A' ? row.aArm : row.bArm
  return chosen
}

function agreedWinner(a: PairwiseRow, b: PairwiseRow): 'plain' | 'lint' | 'tie' {
  const wa = winnerOf(a)
  const wb = winnerOf(b)
  if (wa === wb) return wa
  return 'tie'
}

function slopMarkdown(
  snaps: Snap[],
  criteria: Criterion[],
  pairs: PairwiseRow[],
): string {
  const byName = new Map(criteria.map(c => [c.name, c]))
  const excl = (s: Snap) => kept(s.flags).filter(f => !hasRule(byName.get(f.criteria)))
  const last = lastByWorkspace(snaps)
  const lines: string[] = [
    '# Slop',
    '',
    'Flags with confidence >= 3. `rule` criteria are ones this repo already lints, so the lint arm wins them by construction. Read the excluded-rule row as the part the overlay does not already force.',
    '',
    'Flags per 100 statements and new-flags rows count unique spans. Flags in the same file whose line ranges overlap merge into one (highest confidence kept). Category counts are per criterion, not per span.',
    '',
    ...HH_HEAD,
    hhRow(
      'slop flags / 100 statements',
      armSeries(last, 'plain', s => per100(uniqueSpans(kept(s.flags)).length, s.statements)),
      armSeries(last, 'lint', s => per100(uniqueSpans(kept(s.flags)).length, s.statements)),
      2,
    ),
    hhRow(
      'slop flags / 100 statements (excluding rule criteria)',
      armSeries(last, 'plain', s => per100(uniqueSpans(excl(s)).length, s.statements)),
      armSeries(last, 'lint', s => per100(uniqueSpans(excl(s)).length, s.statements)),
      2,
    ),
  ]
  const byId = new Map<string, Snap[]>()
  for (const s of snaps) {
    const list = byId.get(s.id) ?? []
    list.push(s)
    byId.set(s.id, list)
  }
  const wsNew = (arm: ArmId): number[] => {
    const xs: number[] = []
    for (const list of byId.values()) {
      const sample = list[0]
      if (sample === undefined || sample.arm !== arm) continue
      const news = list.map(s => uniqueSpans(kept(s.flags).filter(f => f.origin === 'new')).length)
      xs.push(stats(news).mean)
    }
    return xs
  }
  lines.push(
    hhRow('new flags per checkpoint', stats(wsNew('plain')), stats(wsNew('lint')), 2),
    '',
  )
  const checkpoints = [...new Set(snaps.map(s => s.checkpoint))].sort((a, b) => a - b)
  for (const n of checkpoints) {
    const at = snaps.filter(s => s.checkpoint === n)
    lines.push(`## Checkpoint ${n}`, '', ...HH_HEAD)
    lines.push(
      hhRow(
        'slop flags / 100 statements',
        armSeries(at, 'plain', s => per100(uniqueSpans(kept(s.flags)).length, s.statements)),
        armSeries(at, 'lint', s => per100(uniqueSpans(kept(s.flags)).length, s.statements)),
        2,
      ),
      hhRow(
        'slop flags / 100 statements (excluding rule criteria)',
        armSeries(at, 'plain', s => per100(uniqueSpans(excl(s)).length, s.statements)),
        armSeries(at, 'lint', s => per100(uniqueSpans(excl(s)).length, s.statements)),
        2,
      ),
      hhRow(
        'new flags',
        armSeries(at, 'plain', s => uniqueSpans(kept(s.flags).filter(f => f.origin === 'new')).length),
        armSeries(at, 'lint', s => uniqueSpans(kept(s.flags).filter(f => f.origin === 'new')).length),
        2,
      ),
      '',
    )
  }
  const catPlain = new Map<string, number>()
  const catLint = new Map<string, number>()
  for (const s of last) {
    const dest = s.arm === 'plain' ? catPlain : catLint
    for (const f of kept(s.flags)) {
      const cat = byName.get(f.criteria)?.category ?? 'unknown'
      dest.set(cat, (dest.get(cat) ?? 0) + 1)
    }
  }
  const cats = [...new Set([...catPlain.keys(), ...catLint.keys()])].sort()
  lines.push('## Categories (final checkpoint, confidence >= 3)', '')
  lines.push('| category | plain | lint |', '| --- | --- | --- |')
  if (cats.length === 0) lines.push('| _(none)_ | 0 | 0 |')
  else {
    for (const c of cats) lines.push(`| ${c} | ${catPlain.get(c) ?? 0} | ${catLint.get(c) ?? 0} |`)
  }
  lines.push('')

  const byPair = new Map<string, PairwiseRow[]>()
  for (const p of pairs) {
    const k = `${p.problem}\t${p.rep}`
    const list = byPair.get(k) ?? []
    list.push(p)
    byPair.set(k, list)
  }
  let lintWins = 0
  let plainWins = 0
  let ties = 0
  const pairLines: string[] = []
  for (const [k, list] of [...byPair.entries()].sort()) {
    const [problem, repRaw] = k.split('\t')
    if (list.length < 2) {
      ties += 1
      pairLines.push(`- ${problem} r${repRaw}: incomplete (${list.length}/2 orders), counted as tie`)
      continue
    }
    const first = list[0]
    const second = list[1]
    if (first === undefined || second === undefined) continue
    const w = agreedWinner(first, second)
    if (w === 'lint') lintWins += 1
    else if (w === 'plain') plainWins += 1
    else ties += 1
    pairLines.push(`- ${problem} r${repRaw}: **${w}**`)
    for (const row of list) {
      pairLines.push(`  - A=${row.aArm} B=${row.bArm} pick ${row.pick}: ${row.reason}`)
    }
  }
  lines.push('## Pairwise preference', '')
  lines.push(`lint wins ${lintWins}, plain wins ${plainWins}, ties ${ties} (disagreement or incomplete orders count as a tie).`, '')
  lines.push(...pairLines, '')

  const catTotals = cats.map(c => ({ c, n: (catPlain.get(c) ?? 0) + (catLint.get(c) ?? 0) }))
  catTotals.sort((a, b) => b.n - a.n)
  const top = catTotals.slice(0, 3).map(x => x.c)
  lines.push('## What the flags look like', '')
  if (top.length === 0) {
    lines.push('No flags at confidence >= 3.', '')
    return `${lines.join('\n')}`
  }
  for (const cat of top) {
    lines.push(`### ${cat}`, '')
    for (const arm of ['plain', 'lint'] as const) {
      const samples: { snap: Snap; flag: Flag }[] = []
      for (const s of last.filter(x => x.arm === arm)) {
        for (const f of kept(s.flags)) {
          if ((byName.get(f.criteria)?.category ?? 'unknown') !== cat) continue
          samples.push({ snap: s, flag: f })
        }
      }
      samples.sort((a, b) => b.flag.confidence - a.flag.confidence)
      lines.push(`**${arm}**`, '')
      const pick = samples.slice(0, 3)
      if (pick.length === 0) {
        lines.push('No flags in this category.', '')
        continue
      }
      for (const s of pick) {
        const excerpt = s.flag.excerpt.split('\n').slice(0, 8).join('\n')
        lines.push(
          `\`${s.snap.id}\` checkpoint ${s.snap.checkpoint}, \`${s.flag.file}:${s.flag.start}-${s.flag.end}\` (${s.flag.criteria}, confidence ${s.flag.confidence})`,
          '',
          '```',
          excerpt,
          '```',
          '',
          s.flag.explanation,
          '',
        )
      }
    }
  }
  return `${lines.join('\n')}`
}

async function writeSlopMd(runDir: string, criteria: Criterion[], judgeRows: JudgeRow[], pairs: PairwiseRow[]): Promise<void> {
  const grades = await readJsonl(join(runDir, 'results.jsonl'), parseGradeRow)
  const gKey = (r: GradeRow) => snapshotKey(r.id, r.checkpoint)
  const gMap = new Map(grades.map(g => [gKey(g), g]))
  const snaps: Snap[] = []
  for (const row of judgeRows) {
    const g = gMap.get(snapshotKey(row.id, row.checkpoint))
    if (g === undefined) throw new Error(`results.jsonl missing ${row.id} checkpoint ${row.checkpoint}; run grade.ts first`)
    snaps.push({
      id: row.id,
      problem: row.problem,
      arm: row.arm,
      rep: row.rep,
      checkpoint: row.checkpoint,
      statements: g.statements,
      flags: row.flags,
    })
  }
  const md = slopMarkdown(snaps, criteria, pairs)
  await writeFile(join(runDir, 'slop.md'), md)
  process.stdout.write(md)
}

function lineOverlap(a1: number, a2: number, b1: number, b2: number): boolean {
  return a1 <= b2 && b1 <= a2
}

function uniqueSpans<T extends { file: string; start: number; end: number; confidence: number }>(flags: T[]): T[] {
  const byFile = new Map<string, T[]>()
  for (const f of flags) {
    const list = byFile.get(f.file) ?? []
    list.push(f)
    byFile.set(f.file, list)
  }
  const out: T[] = []
  for (const list of byFile.values()) out.push(...mergeFileSpans(list))
  return out
}

function mergeFileSpans<T extends { start: number; end: number; confidence: number }>(flags: T[]): T[] {
  if (flags.length === 0) return []
  const sorted = flags.slice().sort((a, b) => a.start - b.start || b.confidence - a.confidence || a.end - b.end)
  const first = sorted[0]
  if (first === undefined) return []
  const merged: T[] = []
  let cur = first
  for (let i = 1; i < sorted.length; i += 1) {
    const f = sorted[i]
    if (f === undefined) continue
    if (!lineOverlap(cur.start, cur.end, f.start, f.end)) {
      merged.push(cur)
      cur = f
      continue
    }
    const take = f.confidence > cur.confidence ? f : cur
    cur = {
      ...take,
      start: Math.min(cur.start, f.start),
      end: Math.max(cur.end, f.end),
      confidence: Math.max(cur.confidence, f.confidence),
    }
  }
  merged.push(cur)
  return merged
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 1 : inter / union
}

function flagKey(f: { file: string; criteria: string; start: number }): string {
  return `${f.file}|${f.criteria}|${f.start}`
}

function flag(partial: Partial<Flag> & Pick<Flag, 'file' | 'start' | 'end' | 'criteria' | 'confidence'>): Flag {
  return {
    explanation: 'x',
    excerpt: 'x',
    origin: 'new',
    ...partial,
  }
}

function selfCheckSpans(): void {
  const merged = uniqueSpans([
    flag({ file: 'a.ts', start: 10, end: 12, criteria: 'lenient_parsing', confidence: 3 }),
    flag({ file: 'a.ts', start: 10, end: 12, criteria: 'type_coercion_hiding_mismatches', confidence: 5 }),
    flag({ file: 'a.ts', start: 11, end: 11, criteria: 'validation_mismatch', confidence: 4 }),
    flag({ file: 'a.ts', start: 20, end: 21, criteria: 'echo_docstrings', confidence: 5 }),
    flag({ file: 'b.ts', start: 10, end: 12, criteria: 'lenient_parsing', confidence: 5 }),
  ])
  if (merged.length !== 3) throw new Error(`spans: want 3 unique, got ${merged.length}`)
  const a = merged.filter(f => f.file === 'a.ts')
  if (a.length !== 2) throw new Error(`spans: want 2 in a.ts, got ${a.length}`)
  const num = a.find(f => f.start <= 10 && f.end >= 12)
  if (num === undefined || num.confidence !== 5) throw new Error('spans: overlapping Number(x) should keep confidence 5')
  if (num.criteria !== 'type_coercion_hiding_mismatches') throw new Error('spans: keep the highest-confidence criterion')
  const adjacent = uniqueSpans([
    flag({ file: 'a.ts', start: 10, end: 12, criteria: 'lenient_parsing', confidence: 3 }),
    flag({ file: 'a.ts', start: 13, end: 14, criteria: 'echo_docstrings', confidence: 3 }),
  ])
  if (adjacent.length !== 2) throw new Error(`spans: adjacent ranges must not merge, got ${adjacent.length}`)
}

async function selfCheckFresh(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fresh-'))
  try {
    await writeFile(join(dir, 'judge.jsonl'), 'one\n')
    await writeFile(join(dir, 'slop.md'), 'v1body\n')
    await archiveIfPresent(join(dir, 'judge.jsonl'), join(dir, 'judge.v1.jsonl'))
    await archiveIfPresent(join(dir, 'slop.md'), join(dir, 'slop.v1.md'))
    if (await exists(join(dir, 'judge.jsonl'))) throw new Error('fresh: judge.jsonl should have moved')
    if ((await readFile(join(dir, 'judge.v1.jsonl'), 'utf8')) !== 'one\n') throw new Error('fresh: judge.v1.jsonl mismatch')
    if ((await readFile(join(dir, 'slop.v1.md'), 'utf8')) !== 'v1body\n') throw new Error('fresh: slop.v1.md mismatch')
    await writeFile(join(dir, 'judge.jsonl'), 'two\n')
    await archiveIfPresent(join(dir, 'judge.jsonl'), join(dir, 'judge.v1.jsonl'))
    if ((await readFile(join(dir, 'judge.v1.jsonl'), 'utf8')) !== 'one\n') {
      throw new Error('fresh: second --fresh clobbered judge.v1.jsonl')
    }
    if (await exists(join(dir, 'judge.jsonl'))) throw new Error('fresh: second run should drop judge.jsonl')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function selfCheckParser(known: Set<string>): void {
  const src = 'a\nb\nc\nd\ne\n'
  const text = `=== FILE: src/ok.ts ===
\`\`\`json
[
  {"criteria": "narration_comments", "start": 2, "end": 2, "explanation": "x", "confidence": 5},
  {"criteria": "not_a_real", "start": 1, "end": 1, "explanation": "x", "confidence": 5},
  {"criteria": "echo_docstrings", "start": 99, "end": 99, "explanation": "x", "confidence": 4},
  {"criteria": "stub_implementations", "start": 0, "end": 1, "explanation": "x", "confidence": 4}
]
\`\`\`
=== END FILE ===`
  const { flags, dropped } = parseGrades(text, new Map([['src/ok.ts', src]]), known)
  if (flags.length !== 1) throw new Error(`parser: want 1 kept flag, got ${flags.length}`)
  if (dropped.unknownCriteria !== 1) throw new Error(`parser: want 1 unknown criteria, got ${dropped.unknownCriteria}`)
  if (dropped.outOfRange !== 2) throw new Error(`parser: want 2 out of range, got ${dropped.outOfRange}`)
}

type Expected = {
  spec: string
  cleanFile: string
  planted: { file: string; criterion: string; start: number; end: number }[]
}

async function loadExpected(): Promise<Expected> {
  const raw = await readJson(join(EVALS_DIR, 'judge-fixture/expected.json'))
  if (!isRecord(raw) || typeof raw['spec'] !== 'string' || typeof raw['cleanFile'] !== 'string' || !Array.isArray(raw['planted'])) {
    throw new Error('judge-fixture/expected.json malformed')
  }
  const planted: Expected['planted'] = []
  for (const p of raw['planted']) {
    if (!isRecord(p)) throw new Error('planted entry must be an object')
    const { file, criterion, start, end } = p
    if (typeof file !== 'string' || typeof criterion !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
      throw new Error('planted entry missing fields')
    }
    planted.push({ file, criterion, start, end })
  }
  return { spec: raw['spec'], cleanFile: raw['cleanFile'], planted }
}

async function judgeFixtureOnce(criteria: Criterion[], known: Set<string>, expected: Expected, model: string): Promise<Flag[]> {
  const files = await collectSrc(join(EVALS_DIR, 'judge-fixture'))
  const answer = await askJudge(flaggingPrompt([expected.spec], files, criteria), model)
  const parsed = parseGrades(answer, filesMap(files), known)
  return markOrigin(parsed.flags, [])
}

async function selfCheck(model: string): Promise<void> {
  const criteria = await loadRubric()
  const known = new Set(criteria.map(c => c.name))
  selfCheckParser(known)
  selfCheckSpans()
  await selfCheckFresh()
  process.stderr.write('self-check parser ok\n')
  const expected = await loadExpected()
  for (const p of expected.planted) {
    if (!known.has(p.criterion)) throw new Error(`planted unknown criterion ${p.criterion}`)
  }
  const [runA, runB] = await Promise.all([
    judgeFixtureOnce(criteria, known, expected, model),
    judgeFixtureOnce(criteria, known, expected, model),
  ])
  const hits = expected.planted.filter(p =>
    runA.some(
      f =>
        f.file === p.file &&
        f.criteria === p.criterion &&
        f.confidence >= CONF_KEEP &&
        lineOverlap(f.start, f.end, p.start, p.end),
    ),
  )
  const recall = expected.planted.length === 0 ? 1 : hits.length / expected.planted.length
  const cleanA = runA.filter(f => f.file === expected.cleanFile && f.confidence >= CONF_KEEP)
  const missed = expected.planted.filter(p => !hits.includes(p))
  const jac = jaccard(new Set(runA.map(flagKey)), new Set(runB.map(flagKey)))
  process.stdout.write(`recall: ${recall.toFixed(2)} (${hits.length}/${expected.planted.length})\n`)
  process.stdout.write(`clean-file flags (confidence >= 3): ${cleanA.length}\n`)
  process.stdout.write(`agreement Jaccard: ${jac.toFixed(2)}\n`)
  if (missed.length > 0) {
    process.stderr.write(`missed planted:\n`)
    for (const p of missed) process.stderr.write(`- ${p.file} ${p.criterion} ${p.start}-${p.end}\n`)
  }
  if (cleanA.length > 0) {
    process.stderr.write('clean-file flags:\n')
    for (const f of cleanA) process.stderr.write(`- ${f.criteria} ${f.start}-${f.end} c${f.confidence} ${f.explanation}\n`)
  }
  if (recall < 0.6 || cleanA.length > 2) {
    throw new Error(`self-check failed: recall ${recall.toFixed(2)} (want >= 0.6), clean-file flags ${cleanA.length} (want <= 2)`)
  }
  process.stdout.write('self-check ok\n')
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

async function judgeRun(runDir: string, model: string, concurrency: number, fresh: boolean): Promise<void> {
  const gradesPath = join(runDir, 'results.jsonl')
  try {
    await readFile(gradesPath, 'utf8')
  } catch {
    throw new Error(`${gradesPath} missing; run grade.ts first`)
  }
  if (fresh) {
    await archiveIfPresent(join(runDir, 'judge.jsonl'), join(runDir, 'judge.v1.jsonl'))
    await archiveIfPresent(join(runDir, 'slop.md'), join(runDir, 'slop.v1.md'))
  }
  const criteria = await loadRubric()
  const known = new Set(criteria.map(c => c.name))
  const manifest: Manifest = parseManifest(await readJson(join(runDir, 'manifest.json')))
  const existing = await readJsonl(join(runDir, 'judge.jsonl'), parseJudgeRow)
  const done = new Set(existing.map(r => snapshotKey(r.id, r.checkpoint)))
  const prevByKey = new Map(existing.map(r => [snapshotKey(r.id, r.checkpoint), r.flags]))
  const appendJudge = mutex()
  await pool(manifest.workspaces, concurrency, ws =>
    judgeWorkspace(runDir, ws, criteria, known, model, done, prevByKey, appendJudge),
  )
  const pairExisting = await readJsonl(join(runDir, 'pairwise.jsonl'), parsePairwiseRow)
  const pairDone = new Set(pairExisting.map(pairwiseKey))
  await runPairwise(runDir, manifest, model, concurrency, pairDone)
  const judgeRows = await readJsonl(join(runDir, 'judge.jsonl'), parseJudgeRow)
  const pairs = await readJsonl(join(runDir, 'pairwise.jsonl'), parsePairwiseRow)
  await writeSlopMd(runDir, criteria, judgeRows, pairs)
}

const argv = process.argv.slice(2)
const opts = parseArgs(argv)
if (opts.selfCheck) await selfCheck(opts.model)
else {
  if (opts.runDir === undefined) throw new Error('need runDir')
  await judgeRun(opts.runDir, opts.model, opts.concurrency, opts.fresh)
}
