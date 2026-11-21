import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EVALS_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = dirname(EVALS_DIR)

export const LEAK_RE =
  /\b(eval|test|judge|experiment|rubric|score|compar|benchmark|candidate|arena)/i

export type ArmId = 'plain' | 'lint'
export type Group = 'core' | 'error' | 'functionality'

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
  yardstickOxlint: () => Promise<Record<string, unknown>>
  yardstickTsconfig: () => Promise<Record<string, unknown>>
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

export const ARMS: { id: ArmId; overlay: boolean }[] = [
  { id: 'plain', overlay: false },
  { id: 'lint', overlay: true },
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
    if (arm !== 'plain' && arm !== 'lint') throw new Error(`bad arm ${String(arm)}`)
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
