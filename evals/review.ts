import { access, appendFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
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

export type CostVerdict = 'better' | 'same' | 'worse' | 'bug'

export type OverlayRule = { rule: string; message: string }

export type CostFinding = {
  rule: string
  file: string
  start: number
  end: number
  excerpt: string
  verdict: CostVerdict
  why: string
  input: string | null
}

export type CostRow = {
  kind: 'cost'
  id: string
  problem: string
  arm: 'lint'
  rep: number
  checkpoint: number
  findings: CostFinding[]
}

export type ReviewRow = BenefitRow | CostRow

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

export async function askReviewer(prompt: string, model: string): Promise<string> {
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

export function costKey(row: Pick<CostRow, 'id' | 'checkpoint'>): string {
  return `cost\t${row.id}\t${row.checkpoint}`
}

export function normalizeRule(id: string): string {
  const t = id.trim()
  const paren = /^([A-Za-z0-9-]+)\((.+)\)$/.exec(t)
  if (paren?.[1] !== undefined && paren[2] !== undefined) return `${paren[1]}(${paren[2]})`
  const slash = t.indexOf('/')
  if (slash > 0) return `${t.slice(0, slash)}(${t.slice(slash + 1)})`
  return `eslint(${t})`
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

function parseCostFinding(raw: unknown, at: string): Omit<CostFinding, 'excerpt'> {
  if (!isRecord(raw)) throw new Error(`${at}: finding must be an object`)
  const { rule, file, start, end, verdict, why } = raw
  if (typeof rule !== 'string' || typeof file !== 'string' || typeof why !== 'string') {
    throw new Error(`${at}: missing strings`)
  }
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)) {
    throw new Error(`${at}: bad span`)
  }
  if (verdict !== 'better' && verdict !== 'same' && verdict !== 'worse' && verdict !== 'bug') {
    throw new Error(`${at}: bad verdict ${String(verdict)}`)
  }
  const inputRaw = raw['input']
  let input: string | null = null
  if (typeof inputRaw === 'string' && inputRaw.trim() !== '') input = inputRaw.trim()
  if (typeof inputRaw !== 'string' && inputRaw !== null && inputRaw !== undefined) {
    throw new Error(`${at}: input must be string or null`)
  }
  if (verdict === 'bug' && input === null) throw new Error(`${at}: bug verdict requires input`)
  return { rule: normalizeRule(rule), file: file.replaceAll('\\', '/').replace(/^\.\//, ''), start, end, verdict, why: why.trim(), input }
}

function parseCostRow(raw: unknown): CostRow {
  if (!isRecord(raw) || raw['kind'] !== 'cost') throw new Error('review.jsonl: expected cost row')
  const { id, problem, arm, rep, checkpoint, findings } = raw
  if (typeof id !== 'string' || typeof problem !== 'string') throw new Error('review.jsonl cost row missing strings')
  if (arm !== 'lint') throw new Error('review.jsonl cost row: arm must be lint')
  if (typeof rep !== 'number' || typeof checkpoint !== 'number') throw new Error('review.jsonl cost row missing numbers')
  if (!Array.isArray(findings)) throw new Error('review.jsonl cost row missing findings')
  return {
    kind: 'cost',
    id,
    problem,
    arm,
    rep,
    checkpoint,
    findings: findings.map((f, i) => {
      const parsed = parseCostFinding(f, `findings[${i}]`)
      if (!isRecord(f) || typeof f['excerpt'] !== 'string') throw new Error(`findings[${i}]: missing excerpt`)
      return { ...parsed, excerpt: f['excerpt'] }
    }),
  }
}

function parseReviewRow(raw: unknown): ReviewRow {
  if (!isRecord(raw)) throw new Error('review.jsonl row must be an object')
  if (raw['kind'] === 'benefit') return parseBenefitRow(raw)
  if (raw['kind'] === 'cost') return parseCostRow(raw)
  throw new Error(`review.jsonl: unknown kind ${String(raw['kind'])}`)
}

function optionMessages(v: unknown): string[] {
  const out: string[] = []
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const item of x) walk(item)
      return
    }
    if (!isRecord(x)) return
    if (typeof x['message'] === 'string') out.push(x['message'])
    for (const [k, val] of Object.entries(x)) {
      if (k === 'message') continue
      walk(val)
    }
  }
  walk(v)
  return out
}

function ruleDetail(option: unknown): string {
  const msgs = optionMessages(option)
  if (msgs.length > 0) return msgs.join(' ')
  if (option === undefined) return ''
  return JSON.stringify(option)
}

function collectEnabledRules(rules: unknown, dest: OverlayRule[]): void {
  if (!isRecord(rules)) return
  for (const [id, v] of Object.entries(rules)) {
    if (id.startsWith('better-tailwindcss/')) continue
    if (v === 'off' || v === 0) continue
    if (v === 'error' || v === 2 || v === 'warn' || v === 1) {
      dest.push({ rule: normalizeRule(id), message: '' })
      continue
    }
    if (Array.isArray(v) && (v[0] === 'error' || v[0] === 2 || v[0] === 'warn' || v[0] === 1)) {
      dest.push({ rule: normalizeRule(id), message: v.length > 1 ? ruleDetail(v[1]) : '' })
    }
  }
}

function mergeOverlay(rows: OverlayRule[]): OverlayRule[] {
  const by = new Map<string, string[]>()
  for (const r of rows) {
    const list = by.get(r.rule) ?? []
    if (r.message !== '' && !list.includes(r.message)) list.push(r.message)
    by.set(r.rule, list)
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([rule, msgs]) => ({ rule, message: msgs.join(' ') }))
}

function overlayFromConfig(cfg: Record<string, unknown>): OverlayRule[] {
  const dest: OverlayRule[] = []
  collectEnabledRules(cfg['rules'], dest)
  const overrides = cfg['overrides']
  if (Array.isArray(overrides)) {
    for (const o of overrides) {
      if (!isRecord(o)) continue
      const files = o['files']
      if (
        Array.isArray(files) &&
        files.length > 0 &&
        files.every(f => typeof f === 'string' && f.startsWith('tools/'))
      ) {
        continue
      }
      collectEnabledRules(o['rules'], dest)
    }
  }
  return mergeOverlay(dest)
}

function messagesOfRule(v: unknown): string[] {
  if (!isRecord(v) || !isRecord(v['meta'])) return []
  const out: string[] = []
  const docs = v['meta']['docs']
  if (isRecord(docs) && typeof docs['description'] === 'string') out.push(docs['description'])
  const messages = v['meta']['messages']
  if (isRecord(messages)) {
    for (const m of Object.values(messages)) {
      if (typeof m === 'string' && m.trim() !== '') out.push(m)
    }
  }
  return out
}

async function reactBanMessages(): Promise<Map<string, string[]>> {
  const dir = join(REPO_ROOT, 'oxlint/react-bans')
  const pluginSrc = await readFile(join(dir, 'plugin.js'), 'utf8')
  const names = new Set<string>()
  for (const m of pluginSrc.matchAll(/'([a-z0-9-]+)':/g)) {
    if (m[1] !== undefined) names.add(m[1])
  }
  const out = new Map<string, string[]>()
  const files = await readdir(dir)
  for (const f of files) {
    if (!f.endsWith('.js') || f === 'plugin.js') continue
    const base = f.slice(0, -3)
    if (!names.has(base)) continue
    const mod: unknown = await import(pathToFileURL(join(dir, f)).href)
    if (!isRecord(mod)) continue
    const msgs: string[] = []
    for (const v of Object.values(mod)) msgs.push(...messagesOfRule(v))
    if (msgs.length > 0) out.set(`ai(${base})`, msgs)
  }
  return out
}

export async function overlayRules(kindId: string): Promise<OverlayRule[]> {
  const examplePath =
    kindId === 'react'
      ? join(REPO_ROOT, 'oxlint/stack/oxlintrc.example.json')
      : join(REPO_ROOT, 'oxlint/typescript/oxlintrc.example.json')
  const cfg = await readJson(examplePath)
  if (!isRecord(cfg)) throw new Error(`${examplePath} must be an object`)
  const rules = overlayFromConfig(cfg)
  if (kindId !== 'react') return rules
  const plugin = await reactBanMessages()
  return rules.map(r => {
    const extra = plugin.get(r.rule)
    if (extra === undefined) return r
    const message = [r.message, ...extra].filter(m => m !== '').join(' ')
    return { rule: r.rule, message }
  })
}

function formatOverlay(rules: OverlayRule[]): string {
  return rules.map(r => (r.message === '' ? `- ${r.rule}` : `- ${r.rule}: ${r.message}`)).join('\n')
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

export function parseCostAnswer(text: string, files: Map<string, string>): CostFinding[] {
  const raw = parseJsonObject(text)
  const findings = raw['findings']
  if (!Array.isArray(findings)) throw new Error('cost: missing findings array')
  const out: CostFinding[] = []
  for (let i = 0; i < findings.length; i += 1) {
    const parsed = parseCostFinding(findings[i], `findings[${i}]`)
    const src = files.get(parsed.file)
    if (src === undefined) throw new Error(`cost: unknown file ${parsed.file}`)
    const n = lineCount(src)
    if (parsed.start < 1 || parsed.end < parsed.start || parsed.end > n) {
      throw new Error(`cost: ${parsed.file} span ${parsed.start}-${parsed.end} out of range`)
    }
    out.push({ ...parsed, excerpt: excerptOf(src, parsed.start, parsed.end) })
  }
  return out
}

export function costPrompt(specs: string[], files: SrcFile[], rules: OverlayRule[]): string {
  return `You are reviewing a small program written while the following lint rules were in force. Find code that exists to satisfy one of those rules rather than because the spec needs it.

Typical substitutions:
- type guards and rebuilt objects instead of \`as\`
- \`?? default\` or explicit checks instead of \`!\`
- process.stdout.write wrappers instead of console
- src/lib/use-* hooks or URL/query state instead of useState/useEffect

Rules in force:
${formatOverlay(rules)}

For each such piece of code, name the rule it satisfies, the file and line span, and a verdict against the banned construct it replaces:
- better: clearer or smaller than the banned construct
- same: equivalent
- worse: worse in clarity or size
- bug: it introduced a defect. Name an input the spec allows that fails, so a person can run it (CLI argv after src/cli.ts, or the user action in a UI).

Reply with JSON only:
{"findings":[{"rule":"eslint(no-console)","file":"src/cli.ts","start":1,"end":8,"verdict":"worse","why":"one sentence"}]}

If you find none, reply {"findings":[]}.
For bug, include "input". For the others, omit input.

<spec>
${formatSpecs(specs)}
</spec>

${formatFiles(files)}
`
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

// Agent code may say "plain" (`const plain = ...`), so only harness-written text is checked.
function withoutContent(files: SrcFile[]): SrcFile[] {
  return files.map(f => ({ ...f, content: '' }))
}

export function assertBlind(text: string, label: string): void {
  if (/\b(plain|lint-arm|lint arm)\b/i.test(text)) throw new Error(`${label} leaks an arm name`)
  if (/grok/i.test(text)) throw new Error(`${label} leaks grok`)
  if (/\b(cursor-grok|gpt-5|claude-|gemini-)/i.test(text)) throw new Error(`${label} leaks a model id`)
}

async function collectSnapshot(
  runDir: string,
  ws: WorkspaceRow,
  requested: number | undefined,
  needHits: boolean,
): Promise<{ checkpoint: number; specs: string[]; files: SrcFile[]; hits: LintHit[]; kindId: string } | undefined> {
  const problem = await loadProblem(ws.problem)
  const kind = getKind(problem.kind)
  const clone = await mkdtemp(join(tmpdir(), 'rev-'))
  try {
    await cloneBundle(join(runDir, ws.bundle), clone)
    const tags = await listCheckpointTags(clone)
    const checkpoint = requested ?? tags[tags.length - 1]
    if (checkpoint === undefined || !tags.includes(checkpoint)) return undefined
    await checkoutTag(clone, checkpoint)
    if (needHits) await kind.prepareGrade(clone)
    const files = await collectSrc(clone, kind)
    const specs = problem.specs.slice(0, checkpoint)
    if (!needHits || files.length === 0) {
      return { checkpoint, specs, files, hits: [], kindId: problem.kind }
    }
    const fileMap = new Map(files.map(f => [f.path, f.content]))
    const cfg = await kind.yardstickOxlint()
    const cfgPath = join(clone, '.metrics-oxlintrc.json')
    await writeJson(cfgPath, cfg)
    const ran = await capture(OXLINT, ['--format', 'json', '-c', cfgPath, join(clone, 'src')], {
      cwd: clone,
      timeoutMs: 60_000,
    })
    await rm(cfgPath, { force: true })
    const hits = parseLintHits(ran.stdout, clone, fileMap)
    return { checkpoint, specs, files, hits, kindId: problem.kind }
  } finally {
    await rm(clone, { recursive: true, force: true })
  }
}

type BenefitJob = {
  kind: 'benefit'
  ws: WorkspaceRow
  checkpoint: number
  hit: LintHit
  files: SrcFile[]
  specs: string[]
  src: string
}

type CostJob = {
  kind: 'cost'
  ws: WorkspaceRow
  checkpoint: number
  files: SrcFile[]
  specs: string[]
  rules: OverlayRule[]
}

type Job = BenefitJob | CostJob

export async function runReview(opts: ReviewOpts): Promise<void> {
  const manifest: Manifest = parseManifest(await readJson(join(opts.runDir, 'manifest.json')))
  if (opts.fresh) {
    await archiveIfPresent(join(opts.runDir, 'review.jsonl'), join(opts.runDir, 'review.v1.jsonl'))
    await archiveIfPresent(join(opts.runDir, 'review.md'), join(opts.runDir, 'review.v1.md'))
  }
  const existing = await readJsonl(join(opts.runDir, 'review.jsonl'), parseReviewRow)
  const doneBenefit = new Set(existing.filter((r): r is BenefitRow => r.kind === 'benefit').map(benefitKey))
  const doneCost = new Set(existing.filter((r): r is CostRow => r.kind === 'cost').map(costKey))
  const rulesCache = new Map<string, OverlayRule[]>()
  const overlayFor = async (kindId: string): Promise<OverlayRule[]> => {
    const cached = rulesCache.get(kindId)
    if (cached !== undefined) return cached
    const rules = await overlayRules(kindId)
    rulesCache.set(kindId, rules)
    return rules
  }
  const jobs: Job[] = []
  for (const ws of manifest.workspaces) {
    process.stderr.write(`review collect ${ws.id}\n`)
    const snap = await collectSnapshot(opts.runDir, ws, opts.checkpoint, ws.arm === 'plain')
    if (snap === undefined) continue
    if (ws.arm === 'plain') {
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
        if (doneBenefit.has(key)) continue
        jobs.push({ kind: 'benefit', ws, checkpoint: snap.checkpoint, hit, files: snap.files, specs: snap.specs, src })
      }
      continue
    }
    if (doneCost.has(costKey({ id: ws.id, checkpoint: snap.checkpoint }))) continue
    jobs.push({
      kind: 'cost',
      ws,
      checkpoint: snap.checkpoint,
      files: snap.files,
      specs: snap.specs,
      rules: await overlayFor(snap.kindId),
    })
  }
  const append = mutex()
  await pool(jobs, opts.concurrency, async job => {
    if (job.kind === 'benefit') {
      process.stderr.write(`review benefit ${job.ws.id} ${job.hit.rule} ${job.hit.file}:${job.hit.start}\n`)
      const prompt = benefitPrompt(job.specs, job.files, job.hit, job.src)
      assertBlind(benefitPrompt(job.specs, withoutContent(job.files), job.hit, ''), 'benefit prompt')
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
      return
    }
    process.stderr.write(`review cost ${job.ws.id}\n`)
    const prompt = costPrompt(job.specs, job.files, job.rules)
    assertBlind(costPrompt(job.specs, withoutContent(job.files), job.rules), 'cost prompt')
    const answer = await askReviewer(prompt, opts.model)
    const findings = parseCostAnswer(answer, new Map(job.files.map(f => [f.path, f.content])))
    const row: CostRow = {
      kind: 'cost',
      id: job.ws.id,
      problem: job.ws.problem,
      arm: 'lint',
      rep: job.ws.rep,
      checkpoint: job.checkpoint,
      findings,
    }
    await append(async () => {
      await appendFile(join(opts.runDir, 'review.jsonl'), `${JSON.stringify(row)}\n`)
    })
  })
  const newBenefit = jobs.filter(j => j.kind === 'benefit').length
  const newCost = jobs.filter(j => j.kind === 'cost').length
  process.stderr.write(`review done (${newBenefit} benefit, ${newCost} cost new)\n`)
  const rows = await readJsonl(join(opts.runDir, 'review.jsonl'), parseReviewRow)
  const md = reviewMarkdown(rows, { checkpoint: opts.checkpoint, model: opts.model })
  await writeFile(join(opts.runDir, 'review.md'), md)
  process.stdout.write(md)
}

export type NetVerdict = 'earns its place' | 'neutral' | 'costs more than it catches'

export type BenefitCounts = { bug: number; fragile: number; style: number; noise: number }
export type CostCounts = { better: number; same: number; worse: number; bug: number }

const BENEFIT_VERDICTS: BenefitVerdict[] = ['bug', 'fragile', 'style', 'noise']
const COST_VERDICTS: CostVerdict[] = ['bug', 'worse', 'better', 'same']

export function emptyBenefitCounts(): BenefitCounts {
  return { bug: 0, fragile: 0, style: 0, noise: 0 }
}

export function emptyCostCounts(): CostCounts {
  return { better: 0, same: 0, worse: 0, bug: 0 }
}

export function netVerdict(benefit: BenefitCounts, cost: CostCounts): NetVerdict {
  const plainHits = benefit.bug + benefit.fragile + benefit.style + benefit.noise
  const workarounds = cost.better + cost.same + cost.worse + cost.bug
  const seriousBenefit = benefit.bug + benefit.fragile
  const costHarm = cost.worse + cost.bug
  if (
    seriousBenefit >= 1 &&
    (plainHits === 0 || seriousBenefit / plainHits >= 0.15) &&
    (workarounds === 0 || costHarm / workarounds <= 0.25)
  ) {
    return 'earns its place'
  }
  if (costHarm > seriousBenefit) return 'costs more than it catches'
  if (plainHits > 0 && seriousBenefit === 0 && workarounds === 0) return 'costs more than it catches'
  return 'neutral'
}

function pct(n: number, d: number): string {
  if (d === 0) return 'n/a'
  return `${Math.round((100 * n) / d)}%`
}

function pickExamples<T extends { verdict: string }>(rows: T[], order: readonly string[], n: number): T[] {
  const buckets = new Map<string, T[]>()
  for (const r of rows) {
    const list = buckets.get(r.verdict) ?? []
    list.push(r)
    buckets.set(r.verdict, list)
  }
  const out: T[] = []
  while (out.length < n) {
    let added = false
    for (const v of order) {
      const list = buckets.get(v)
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

function countsBenefit(rows: BenefitRow[]): BenefitCounts {
  const c = emptyBenefitCounts()
  for (const r of rows) c[r.verdict] += 1
  return c
}

function countsCost(findings: CostFinding[]): CostCounts {
  const c = emptyCostCounts()
  for (const f of findings) c[f.verdict] += 1
  return c
}

type CostEx = CostFinding & { id: string }
type RuleBucket = { benefit: BenefitRow[]; cost: CostEx[] }

function bucketsByRule(rows: ReviewRow[]): Map<string, RuleBucket> {
  const by = new Map<string, RuleBucket>()
  const bucket = (rule: string): RuleBucket => {
    const cur = by.get(rule)
    if (cur !== undefined) return cur
    const next: RuleBucket = { benefit: [], cost: [] }
    by.set(rule, next)
    return next
  }
  for (const row of rows) {
    if (row.kind === 'benefit') bucket(row.rule).benefit.push(row)
    else {
      for (const f of row.findings) bucket(f.rule).cost.push({ ...f, id: row.id })
    }
  }
  return by
}

function exampleLine(id: string, file: string, start: number, end: number, verdict: string, why: string, input: string | null): string {
  const span = start === end ? `${file}:${start}` : `${file}:${start}-${end}`
  const extra = input !== null ? ` input \`${input}\`` : ''
  return `- \`${id}\` \`${span}\` ${verdict}${extra}: ${why}`
}

export function reviewMarkdown(
  rows: ReviewRow[],
  meta: { checkpoint: number | undefined; model: string },
): string {
  const checkpoints = [...new Set(rows.map(r => r.checkpoint))].sort((a, b) => a - b)
  const checkpointLabel =
    meta.checkpoint !== undefined
      ? `Checkpoint ${meta.checkpoint}.`
      : checkpoints.length === 1
        ? `Checkpoint ${checkpoints[0]}.`
        : checkpoints.length === 0
          ? 'No snapshots reviewed.'
          : `Checkpoints ${checkpoints.join(', ')}.`
  const by = bucketsByRule(rows)
  const rules = [...by.keys()].sort()
  const benefitN = rows.filter(r => r.kind === 'benefit').length
  const costN = rows.filter(r => r.kind === 'cost').length
  const lines: string[] = [
    '# Rule review',
    '',
    checkpointLabel,
    `Reviewer model \`${meta.model}\`.`,
    `${benefitN} plain-arm lint hits, ${costN} lint-arm snapshots.`,
    '',
    '## Net verdict',
    '',
    'Computed from the reviewer verdicts, not re-judged.',
    '',
    '- earns its place. At least one plain-arm `bug` or `fragile`, they are at least 15% of plain hits, and at most 25% of lint-arm workarounds are `worse` or `bug`. No workarounds counts as 0% harm.',
    '- costs more than it catches. Lint-arm `worse`+`bug` outnumber plain-arm `bug`+`fragile`, or every plain hit is `style` or `noise` and there are no workarounds.',
    '- neutral. Anything else.',
    '',
  ]
  if (rules.length === 0) {
    lines.push('No verdicts yet.', '')
    return `${lines.join('\n')}`
  }
  for (const rule of rules) {
    const bucket = by.get(rule)
    if (bucket === undefined) continue
    const b = countsBenefit(bucket.benefit)
    const c = countsCost(bucket.cost)
    const plain = bucket.benefit.length
    const work = bucket.cost.length
    const net = netVerdict(b, c)
    lines.push(
      `## \`${rule}\``,
      '',
      '| plain hits | % bug | % fragile | % style | % noise | workarounds | % better | % same | % worse | % bug | net |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      `| ${plain} | ${pct(b.bug, plain)} | ${pct(b.fragile, plain)} | ${pct(b.style, plain)} | ${pct(b.noise, plain)} | ${work} | ${pct(c.better, work)} | ${pct(c.same, work)} | ${pct(c.worse, work)} | ${pct(c.bug, work)} | ${net} |`,
      '',
      'Plain',
      '',
    )
    const bEx = pickExamples(bucket.benefit, BENEFIT_VERDICTS, 3)
    if (bEx.length === 0) lines.push('None.', '')
    else {
      for (const r of bEx) {
        lines.push(exampleLine(r.id, r.file, r.start, r.end, r.verdict, r.why, r.input))
      }
      lines.push('')
    }
    lines.push('Lint-arm', '')
    const cEx = pickExamples(bucket.cost, COST_VERDICTS, 3)
    if (cEx.length === 0) lines.push('None.', '')
    else {
      for (const f of cEx) {
        lines.push(exampleLine(f.id, f.file, f.start, f.end, f.verdict, f.why, f.input))
      }
      lines.push('')
    }
  }
  return `${lines.join('\n')}`
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

  const srcFiles: SrcFile[] = [{ path: 'src/cli.ts', content: src }]
  const fileMap = new Map([['src/cli.ts', src]])
  const empty = parseCostAnswer('{"findings":[]}', fileMap)
  if (empty.length !== 0) throw new Error('parseCostAnswer: empty')
  const cost = parseCostAnswer(
    '{"findings":[{"rule":"no-console","file":"src/cli.ts","start":2,"end":2,"verdict":"same","why":"stdout.write is console."}]}',
    fileMap,
  )
  if (cost.length !== 1 || cost[0]?.rule !== 'eslint(no-console)' || cost[0].verdict !== 'same') {
    throw new Error('parseCostAnswer: normalize no-console')
  }
  threw = false
  try {
    parseCostAnswer('{"findings":[{"rule":"x","file":"src/cli.ts","start":2,"end":2,"verdict":"bug","why":"x"}]}', fileMap)
  } catch {
    threw = true
  }
  if (!threw) throw new Error('parseCostAnswer: bug without input should fail')

  const cliRules = await overlayRules('cli')
  const cliIds = new Set(cliRules.map(r => r.rule))
  for (const id of ['eslint(no-console)', 'typescript(no-non-null-assertion)', 'typescript(consistent-type-assertions)']) {
    if (!cliIds.has(id)) throw new Error(`overlayRules cli missing ${id}`)
  }
  const assertion = cliRules.find(r => r.rule === 'typescript(consistent-type-assertions)')
  if (assertion === undefined || !assertion.message.includes('assertionStyle')) {
    throw new Error('overlayRules: consistent-type-assertions should keep assertionStyle')
  }
  const reactRules = await overlayRules('react')
  const useState = reactRules.find(r => r.rule === 'ai(no-use-state)')
  if (useState === undefined || !useState.message.includes('Do not use React')) {
    throw new Error('overlayRules react missing ai(no-use-state) message')
  }
  const restricted = reactRules.find(r => r.rule === 'eslint(no-restricted-imports)')
  if (restricted === undefined || !restricted.message.includes('Server data lives in src/lib')) {
    throw new Error('overlayRules react missing no-restricted-imports messages')
  }
  if (reactRules.some(r => r.rule.startsWith('better-tailwindcss'))) {
    throw new Error('overlayRules react should drop tailwind')
  }

  const cPrompt = costPrompt(['Print a total.'], srcFiles, cliRules)
  assertBlind(cPrompt, 'cost self-check prompt')
  if (!cPrompt.includes('eslint(no-console)')) throw new Error('cost prompt missing overlay rules')
  if (!cPrompt.includes('process.stdout.write')) throw new Error('cost prompt missing substitutions')
  if (cPrompt.includes(EVALS_DIR) || cPrompt.includes(METRICS_PLUGIN)) throw new Error('cost prompt leaks repo paths')

  if (normalizeRule('typescript/no-non-null-assertion') !== 'typescript(no-non-null-assertion)') {
    throw new Error('normalizeRule slash')
  }

  const earns = netVerdict({ bug: 0, fragile: 3, style: 0, noise: 13 }, { better: 4, same: 2, worse: 0, bug: 0 })
  if (earns !== 'earns its place') throw new Error(`netVerdict fragile share: ${earns}`)
  const nags = netVerdict({ bug: 0, fragile: 0, style: 0, noise: 41 }, { better: 0, same: 0, worse: 0, bug: 0 })
  if (nags !== 'costs more than it catches') throw new Error(`netVerdict nags: ${nags}`)
  const harm = netVerdict({ bug: 0, fragile: 0, style: 1, noise: 8 }, { better: 0, same: 0, worse: 0, bug: 2 })
  if (harm !== 'costs more than it catches') throw new Error(`netVerdict lint bugs: ${harm}`)
  const mixed = netVerdict({ bug: 0, fragile: 0, style: 0, noise: 41 }, { better: 0, same: 6, worse: 0, bug: 0 })
  if (mixed !== 'neutral') throw new Error(`netVerdict same wrappers: ${mixed}`)

  const md = reviewMarkdown(
    [
      {
        kind: 'benefit',
        id: 'ledger-plain-r1',
        problem: 'ledger',
        arm: 'plain',
        rep: 1,
        checkpoint: 3,
        rule: 'eslint(no-console)',
        message: 'Unexpected console statement.',
        file: 'src/cli.ts',
        start: 2,
        end: 2,
        excerpt: 'console.log(x)',
        verdict: 'noise',
        why: 'CLI output.',
        input: null,
      },
    ],
    { checkpoint: 3, model: 'gpt-5.6-sol-high' },
  )
  if (!md.includes('costs more than it catches')) throw new Error('review.md net verdict missing')
  if (!md.includes('Checkpoint 3.')) throw new Error('review.md checkpoint')
  if (/grok/i.test(md)) throw new Error('review.md leaked grok')

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
