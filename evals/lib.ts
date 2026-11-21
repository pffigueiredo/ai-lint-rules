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

export type Step = {
  args: string[]
  stdin?: string
  exitCode: number
  stdout?: string
  json?: unknown
  files?: Record<string, unknown>
}

export type Case = {
  name: string
  group: Group
  files?: Record<string, string>
  steps: Step[]
}

export type Problem = {
  slug: string
  specs: string[]
  cases: Case[][]
  solutionDir: string
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

function isGroup(v: string): v is Group {
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

function parseStep(raw: unknown, at: string): Step {
  if (!isRecord(raw)) throw new Error(`${at}: step must be an object`)
  const { args } = raw
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) {
    throw new Error(`${at}: args must be a string array`)
  }
  const exitCode = raw['exitCode']
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) {
    throw new Error(`${at}: exitCode must be an integer`)
  }
  const step: Step = { args, exitCode }
  if (raw['stdin'] !== undefined) {
    if (typeof raw['stdin'] !== 'string') throw new Error(`${at}: stdin must be a string`)
    step.stdin = raw['stdin']
  }
  if (raw['stdout'] !== undefined) {
    if (typeof raw['stdout'] !== 'string') throw new Error(`${at}: stdout must be a string`)
    step.stdout = raw['stdout']
  }
  if (raw['json'] !== undefined) step.json = raw['json']
  if (raw['files'] !== undefined) {
    if (!isRecord(raw['files'])) throw new Error(`${at}: files must be an object`)
    step.files = raw['files']
  }
  return step
}

function parseCase(raw: unknown, at: string): Case {
  if (!isRecord(raw)) throw new Error(`${at}: case must be an object`)
  const name = raw['name']
  const group = raw['group']
  const stepsRaw = raw['steps']
  if (typeof name !== 'string' || name.length === 0) throw new Error(`${at}: name must be a nonempty string`)
  if (typeof group !== 'string' || !isGroup(group)) {
    throw new Error(`${at}: group must be core, error, or functionality`)
  }
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) throw new Error(`${at}: steps must be a nonempty array`)
  const cas: Case = {
    name,
    group,
    steps: stepsRaw.map((s, i) => parseStep(s, `${at}.steps[${i}]`)),
  }
  if (raw['files'] !== undefined) {
    if (!isRecord(raw['files']) || Object.values(raw['files']).some(v => typeof v !== 'string')) {
      throw new Error(`${at}: files must be a string map`)
    }
    const files: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw['files'])) {
      if (typeof v !== 'string') throw new Error(`${at}: files.${k} must be a string`)
      files[k] = v
    }
    cas.files = files
  }
  return cas
}

export function parseCases(raw: unknown, at: string): Case[] {
  if (!Array.isArray(raw)) throw new Error(`${at}: expected an array of cases`)
  return raw.map((c, i) => parseCase(c, `${at}[${i}]`))
}

export async function listProblemSlugs(): Promise<string[]> {
  const root = join(EVALS_DIR, 'problems')
  const ents = await readdir(root, { withFileTypes: true })
  return ents.filter(e => e.isDirectory()).map(e => e.name).sort()
}

export async function loadProblem(slug: string): Promise<Problem> {
  const dir = join(EVALS_DIR, 'problems', slug)
  const specs: string[] = []
  const cases: Case[][] = []
  for (let n = 1; n <= 20; n += 1) {
    const md = join(dir, `checkpoint_${n}.md`)
    let spec: string
    try {
      spec = await readFile(md, 'utf8')
    } catch {
      break
    }
    const jsonPath = join(dir, `checkpoint_${n}.json`)
    const raw = await readJson(jsonPath)
    specs.push(spec)
    cases.push(parseCases(raw, jsonPath))
  }
  if (specs.length === 0) throw new Error(`${dir}: no checkpoints`)
  return { slug, specs, cases, solutionDir: join(dir, 'solution') }
}

export async function copyTemplate(dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  await cp(join(EVALS_DIR, 'template'), dest, { recursive: true })
}

async function mergeCompilerOptions(tsconfigPath: string): Promise<void> {
  const tsconfig = await readJson(tsconfigPath)
  const strict = await readJson(join(REPO_ROOT, 'tsconfig/strict.json'))
  if (!isRecord(tsconfig) || !isRecord(strict)) throw new Error('tsconfig must be an object')
  const baseOpts = tsconfig['compilerOptions']
  const extra = strict['compilerOptions']
  if (!isRecord(baseOpts) || !isRecord(extra)) throw new Error('compilerOptions must be an object')
  tsconfig['compilerOptions'] = { ...baseOpts, ...extra }
  await writeJson(tsconfigPath, tsconfig)
}

export async function applyLintOverlay(ws: string): Promise<void> {
  const example = await readJson(join(REPO_ROOT, 'oxlint/typescript/oxlintrc.example.json'))
  if (!isRecord(example)) throw new Error('oxlintrc.example.json must be an object')
  example['$schema'] = './node_modules/oxlint/configuration_schema.json'
  await writeJson(join(ws, '.oxlintrc.json'), example)
  await mergeCompilerOptions(join(ws, 'tsconfig.json'))
  const pkg = await readJson(join(ws, 'package.json'))
  const repoPkg = await readJson(join(REPO_ROOT, 'package.json'))
  if (!isRecord(pkg) || !isRecord(repoPkg)) throw new Error('package.json must be an object')
  const repoDeps = repoPkg['devDependencies']
  if (!isRecord(repoDeps)) throw new Error('repo devDependencies missing')
  const oxlint = repoDeps['oxlint']
  const tsgolint = repoDeps['oxlint-tsgolint']
  if (typeof oxlint !== 'string' || typeof tsgolint !== 'string') {
    throw new Error('pinned oxlint versions missing from the repo package.json')
  }
  const deps = pkg['devDependencies']
  if (!isRecord(deps)) throw new Error('workspace devDependencies missing')
  deps['oxlint'] = oxlint
  deps['oxlint-tsgolint'] = tsgolint
  pkg['scripts'] = { check: 'tsc && oxlint' }
  await writeJson(join(ws, 'package.json'), pkg)
}

export async function materializeArm(dest: string, arm: ArmId): Promise<void> {
  await copyTemplate(dest)
  if (arm === 'lint') await applyLintOverlay(dest)
}

export async function mergedStrictTsconfig(): Promise<Record<string, unknown>> {
  const base = await readJson(join(EVALS_DIR, 'template/tsconfig.json'))
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
