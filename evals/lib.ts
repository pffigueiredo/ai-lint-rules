import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EVALS_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = dirname(EVALS_DIR)

export const LEAK_RE =
  /\b(eval|test|judge|experiment|rubric|score|compar|benchmark|candidate|arena)/i

export const ARM_IDS = ['plain', 'lint', 'lint-cc'] as const
export type ArmId = (typeof ARM_IDS)[number]
export type Group = 'core' | 'error' | 'functionality'

export function isArmId(v: string): v is ArmId {
  return (ARM_IDS as readonly string[]).includes(v)
}

export type Problem = {
  slug: string
  kind: string
  specs: string[]
  solutionDir: string
  dir: string
}

export type CaseResult = { name: string; group: Group; pass: boolean; detail: string }

export type PassRate = { core: number; error: number; functionality: number; regression: number }

export type CheckRun = {
  results: CaseResult[]
  solved: boolean
  isoSolved: boolean
  passRate: PassRate
}

export type Kind = {
  templateDir: string
  planted: readonly string[]
  promptFor: (checkpoint: number, spec: string) => string
  applyLintOverlay: (ws: string) => Promise<void>
  prepareTools: (ws: string) => Promise<void>
  prepareGrade: (ws: string) => Promise<void>
  hydrateForChecks: (dest: string, solutionDir: string) => Promise<void>
  hydrateEmpty: (dest: string) => Promise<void>
  runCheckpoint: (ws: string, problem: Problem, checkpoint: number) => Promise<CheckRun>
  sourceFiles: (srcDir: string) => Promise<string[]>
  knipEntry: readonly string[]
  yardstickOxlint: () => Promise<Record<string, unknown>>
  yardstickTsconfig: () => Promise<Record<string, unknown>>
  concurrency: number | undefined
}

export type WorkspaceRow = {
  id: string
  problem: string
  arm: ArmId
  rep: number
  model: string
  bundle: string
  workspaceDir: string
}

export type Manifest = {
  createdAt: string
  model: string
  checkpoints: number
  workspaces: WorkspaceRow[]
}

export type Capture = {
  code: number
  stdout: string
  stderr: string
}

export function isGroup(v: string): v is Group {
  return v === 'core' || v === 'error' || v === 'functionality'
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

export type CursorAgentStatus = 'ok' | 'timeout' | 'stalled' | 'error'

export function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ESRCH') return
    throw err
  }
}

export function spawnCursorAgent(opts: {
  args: readonly string[]
  cwd: string
  timeoutMs: number
  stallMs?: number
  onStdout?: (chunk: string) => void
}): Promise<{ status: CursorAgentStatus; stdout: string; error?: string | undefined }> {
  return new Promise(resolve => {
    let stdout = ''
    let timedOut = false
    let stalled = false
    let spawnErr: string | undefined
    let settled = false
    const proc = spawn('cursor-agent', [...opts.args], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const pid = proc.pid
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (stallTimer !== undefined) clearTimeout(stallTimer)
      killProcessGroup(pid)
      const status: CursorAgentStatus = timedOut
        ? 'timeout'
        : stalled
          ? 'stalled'
          : spawnErr !== undefined
            ? 'error'
            : 'ok'
      resolve({ status, stdout, error: spawnErr })
    }
    const armStall = (): void => {
      if (opts.stallMs === undefined) return
      if (stallTimer !== undefined) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        if (settled || timedOut) return
        stalled = true
        killProcessGroup(pid)
      }, opts.stallMs)
    }
    proc.stdout.setEncoding('utf8')
    proc.stderr.resume()
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      opts.onStdout?.(chunk)
      armStall()
    })
    proc.stdout.on('error', () => undefined)
    const timer = setTimeout(() => {
      if (settled || stalled) return
      timedOut = true
      killProcessGroup(pid)
    }, opts.timeoutMs)
    armStall()
    proc.on('error', err => {
      spawnErr = err instanceof Error ? err.message : String(err)
      settle()
    })
    proc.on('close', () => {
      settle()
    })
  })
}

export function capture(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; stdin?: string },
): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin)
    else child.stdin.end()
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill('SIGKILL')
          }, opts.timeoutMs)
    child.on('error', err => {
      if (timer !== undefined) clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

function rate(results: CaseResult[], group: Group): number {
  const xs = results.filter(r => r.group === group)
  if (xs.length === 0) return 1
  return xs.filter(r => r.pass).length / xs.length
}

export function assembleCheckRun(iso: CaseResult[], regression: CaseResult[]): CheckRun {
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

export async function listCheckpointTags(ws: string): Promise<number[]> {
  const ran = await capture('git', ['tag', '-l', 'v*'], { cwd: ws, timeoutMs: 30_000 })
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

export async function listProblemSlugs(): Promise<string[]> {
  const root = join(EVALS_DIR, 'problems')
  const ents = await readdir(root, { withFileTypes: true })
  return ents.filter(e => e.isDirectory()).map(e => e.name).sort()
}

export async function loadProblem(slug: string): Promise<Problem> {
  const dir = join(EVALS_DIR, 'problems', slug)
  let kind: string
  try {
    kind = (await readFile(join(dir, 'kind'), 'utf8')).trim()
  } catch {
    throw new Error(`${dir}: missing kind file`)
  }
  const specs: string[] = []
  for (let n = 1; n <= 20; n += 1) {
    const md = join(dir, `checkpoint_${n}.md`)
    try {
      specs.push(await readFile(md, 'utf8'))
    } catch {
      break
    }
  }
  if (specs.length === 0) throw new Error(`${dir}: no checkpoints`)
  return { slug, kind, specs, solutionDir: join(dir, 'solution'), dir }
}

export async function walkSource(dir: string, exts: readonly string[]): Promise<string[]> {
  let ents
  try {
    ents = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walkSource(p, exts)))
    else if (exts.some(ext => e.name.endsWith(ext))) out.push(p)
  }
  return out
}

export async function mergeCompilerOptions(tsconfigPath: string): Promise<void> {
  const tsconfig = await readJson(tsconfigPath)
  const strict = await readJson(join(REPO_ROOT, 'tsconfig/strict.json'))
  if (!isRecord(tsconfig) || !isRecord(strict)) throw new Error('tsconfig must be an object')
  const baseOpts = tsconfig['compilerOptions']
  const extra = strict['compilerOptions']
  if (!isRecord(baseOpts) || !isRecord(extra)) throw new Error('compilerOptions must be an object')
  tsconfig['compilerOptions'] = { ...baseOpts, ...extra }
  await writeJson(tsconfigPath, tsconfig)
}

export async function mergedTsconfig(templateTsconfig: string): Promise<Record<string, unknown>> {
  const base = await readJson(templateTsconfig)
  const strict = await readJson(join(REPO_ROOT, 'tsconfig/strict.json'))
  if (!isRecord(base) || !isRecord(strict)) throw new Error('tsconfig must be an object')
  const baseOpts = base['compilerOptions']
  const extra = strict['compilerOptions']
  if (!isRecord(baseOpts) || !isRecord(extra)) throw new Error('compilerOptions must be an object')
  return {
    ...base,
    compilerOptions: { ...baseOpts, ...extra },
    include: ['src'],
  }
}

export async function repoDevDeps(): Promise<Record<string, unknown>> {
  const repoPkg = await readJson(join(REPO_ROOT, 'package.json'))
  if (!isRecord(repoPkg)) throw new Error('package.json must be an object')
  const deps = repoPkg['devDependencies']
  if (!isRecord(deps)) throw new Error('repo devDependencies missing')
  return deps
}

export function pinnedDep(deps: Record<string, unknown>, name: string): string {
  const v = deps[name]
  if (typeof v !== 'string') throw new Error(`pinned ${name} missing from the repo package.json`)
  return v
}

export const METRICS_PLUGIN = join(EVALS_DIR, 'metrics-plugin.js')

export function withComplexityYardstick(example: Record<string, unknown>): Record<string, unknown> {
  const pluginsRaw = example['plugins']
  const plugins = Array.isArray(pluginsRaw) ? pluginsRaw.filter(p => typeof p === 'string') : []
  if (!plugins.includes('eslint')) plugins.push('eslint')
  const jsPluginsRaw = example['jsPlugins']
  const jsPlugins = Array.isArray(jsPluginsRaw) ? [...jsPluginsRaw] : []
  if (!jsPlugins.includes(METRICS_PLUGIN)) jsPlugins.push(METRICS_PLUGIN)
  const rules = example['rules']
  if (!isRecord(rules)) throw new Error('oxlintrc rules missing')
  return {
    ...example,
    plugins,
    jsPlugins,
    rules: { ...rules, 'eslint/complexity': ['error', { max: 0 }], 'metrics/file': 'error' },
  }
}

export async function copySolution(dest: string, solutionDir: string): Promise<void> {
  await mkdir(join(dest, 'src'), { recursive: true })
  await cp(join(solutionDir, 'src'), join(dest, 'src'), { recursive: true })
}

export function findLeak(text: string): string | undefined {
  const m = LEAK_RE.exec(text)
  if (m === null) return undefined
  const token = m[0]
  if (token === undefined) return undefined
  return token
}

export const ARMS: { id: ArmId; overlay: 'none' | 'lint' | 'lint-cc' }[] = [
  { id: 'plain', overlay: 'none' },
  { id: 'lint', overlay: 'lint' },
  { id: 'lint-cc', overlay: 'lint-cc' },
]

export function parseManifest(raw: unknown): Manifest {
  if (!isRecord(raw) || !Array.isArray(raw['workspaces'])) throw new Error('manifest.json: missing workspaces')
  const workspaces: WorkspaceRow[] = []
  for (const w of raw['workspaces']) {
    if (!isRecord(w)) throw new Error('manifest workspace must be an object')
    const { id, problem, arm, rep, model, bundle, workspaceDir } = w
    if (typeof id !== 'string' || typeof problem !== 'string' || typeof model !== 'string') {
      throw new Error('manifest workspace missing strings')
    }
    if (typeof arm !== 'string' || !isArmId(arm)) throw new Error(`bad arm ${String(arm)}`)
    if (typeof rep !== 'number' || typeof bundle !== 'string' || typeof workspaceDir !== 'string') {
      throw new Error('manifest workspace missing fields')
    }
    workspaces.push({ id, problem, arm, rep, model, bundle, workspaceDir })
  }
  const createdAt = raw['createdAt']
  const model = raw['model']
  const checkpoints = raw['checkpoints']
  if (typeof createdAt !== 'string' || typeof model !== 'string' || typeof checkpoints !== 'number') {
    throw new Error('manifest missing createdAt/model/checkpoints')
  }
  return { createdAt, model, checkpoints, workspaces }
}

export async function pool<T>(opts: {
  items: readonly T[]
  concurrency: number
  kindOf: (item: T) => string
  kindLimit: (kind: string) => number | undefined
  run: (item: T) => Promise<void>
}): Promise<void> {
  const { items, concurrency, kindOf, kindLimit, run } = opts
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer')
  const q = items.slice()
  const inflight = new Map<string, number>()
  let running = 0
  const errors: unknown[] = []
  let waiting: (() => void) | undefined
  let missed = false

  const cap = (kind: string): number => {
    const n = kindLimit(kind)
    return n === undefined ? Number.POSITIVE_INFINITY : n
  }
  const canRun = (kind: string): boolean => running < concurrency && (inflight.get(kind) ?? 0) < cap(kind)
  const pick = (): T | undefined => {
    const i = q.findIndex(item => canRun(kindOf(item)))
    if (i < 0) return undefined
    const item = q[i]
    q.splice(i, 1)
    return item
  }
  const signal = (): void => {
    missed = true
    const w = waiting
    waiting = undefined
    w?.()
  }
  const wait = (): Promise<void> => {
    if (missed) {
      missed = false
      return Promise.resolve()
    }
    return new Promise(resolve => {
      waiting = resolve
      if (!missed) return
      missed = false
      waiting = undefined
      resolve()
    })
  }
  const start = (item: T): void => {
    const kind = kindOf(item)
    running += 1
    inflight.set(kind, (inflight.get(kind) ?? 0) + 1)
    void run(item)
      .catch((err: unknown) => {
        errors.push(err)
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      })
      .finally(() => {
        running -= 1
        inflight.set(kind, (inflight.get(kind) ?? 1) - 1)
        signal()
      })
  }

  for (;;) {
    for (;;) {
      const item = pick()
      if (item === undefined) break
      start(item)
    }
    if (q.length === 0 && running === 0) break
    await wait()
  }
  if (errors.length > 0) throw new AggregateError(errors, `${errors.length} job(s) failed; rerun with --out to resume`)
}

export async function selfCheckPool(): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  type Job = { id: string; kind: 'react' | 'cli' }
  const jobs: Job[] = [
    { id: 'r1', kind: 'react' },
    { id: 'r2', kind: 'react' },
    { id: 'r3', kind: 'react' },
    { id: 'c1', kind: 'cli' },
    { id: 'c2', kind: 'cli' },
    { id: 'c3', kind: 'cli' },
    { id: 'c4', kind: 'cli' },
  ]
  let react = 0
  let cli = 0
  let maxReact = 0
  let maxCli = 0
  const done: string[] = []
  await pool({
    items: jobs,
    concurrency: 3,
    kindOf: job => job.kind,
    kindLimit: kind => (kind === 'react' ? 1 : undefined),
    run: async job => {
      if (job.kind === 'react') {
        react += 1
        maxReact = Math.max(maxReact, react)
        await sleep(40)
        react -= 1
      } else {
        cli += 1
        maxCli = Math.max(maxCli, cli)
        await sleep(40)
        cli -= 1
      }
      done.push(job.id)
    },
  })
  if (maxReact !== 1) throw new Error(`pool: max simultaneous react jobs ${maxReact}, want 1`)
  if (maxCli < 2) throw new Error(`pool: max simultaneous cli jobs ${maxCli}, want >= 2 overlapping`)
  if (done.length !== jobs.length) throw new Error(`pool: finished ${done.length}/${jobs.length}`)
}
