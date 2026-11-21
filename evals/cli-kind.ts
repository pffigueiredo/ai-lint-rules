import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  type Capture,
  type CaseResult,
  type CheckRun,
  type Group,
  type Kind,
  type Problem,
  EVALS_DIR,
  REPO_ROOT,
  assembleCheckRun,
  capture,
  copySolution,
  isGroup,
  isRecord,
  mergeCompilerOptions,
  mergedTsconfig,
  pinnedDep,
  readJson,
  repoDevDeps,
  walkSource,
  withComplexityYardstick,
  writeJson,
} from './lib.ts'

const STEP_TIMEOUT_MS = 8_000

type Step = {
  args: string[]
  stdin?: string
  exitCode: number
  stdout?: string
  json?: unknown
  files?: Record<string, unknown>
}

type Case = {
  name: string
  group: Group
  files?: Record<string, string>
  steps: Step[]
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

function parseCases(raw: unknown, at: string): Case[] {
  if (!Array.isArray(raw)) throw new Error(`${at}: expected an array of cases`)
  return raw.map((c, i) => parseCase(c, `${at}[${i}]`))
}

async function loadCases(dir: string, count: number): Promise<Case[][]> {
  const cases: Case[][] = []
  for (let n = 1; n <= count; n += 1) {
    const jsonPath = join(dir, `checkpoint_${n}.json`)
    const raw = await readJson(jsonPath)
    cases.push(parseCases(raw, jsonPath))
  }
  return cases
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

async function compareFiles(
  cwd: string,
  expected: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; detail: string }> {
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

async function runCase(cliDir: string, cas: Case): Promise<CaseResult> {
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

async function applyLintOverlay(ws: string): Promise<void> {
  const example = await readJson(join(REPO_ROOT, 'oxlint/typescript/oxlintrc.example.json'))
  if (!isRecord(example)) throw new Error('oxlintrc.example.json must be an object')
  example['$schema'] = './node_modules/oxlint/configuration_schema.json'
  await writeJson(join(ws, '.oxlintrc.json'), example)
  await mergeCompilerOptions(join(ws, 'tsconfig.json'))
  const pkg = await readJson(join(ws, 'package.json'))
  const repoDeps = await repoDevDeps()
  if (!isRecord(pkg)) throw new Error('package.json must be an object')
  const oxlint = pinnedDep(repoDeps, 'oxlint')
  const tsgolint = pinnedDep(repoDeps, 'oxlint-tsgolint')
  const deps = pkg['devDependencies']
  if (!isRecord(deps)) throw new Error('workspace devDependencies missing')
  deps['oxlint'] = oxlint
  deps['oxlint-tsgolint'] = tsgolint
  pkg['scripts'] = { check: 'tsc && oxlint' }
  await writeJson(join(ws, 'package.json'), pkg)
}

async function prepareTools(ws: string): Promise<void> {
  const dest = join(ws, 'node_modules')
  await rm(dest, { recursive: true, force: true })
  await symlink(join(REPO_ROOT, 'node_modules'), dest)
}

async function runCheckpoint(ws: string, problem: Problem, checkpoint: number): Promise<CheckRun> {
  const bundles = await loadCases(problem.dir, problem.specs.length)
  const current = bundles[checkpoint - 1]
  if (current === undefined) throw new Error(`missing cases for checkpoint ${checkpoint}`)
  const iso: CaseResult[] = []
  for (const cas of current) iso.push(await runCase(ws, cas))
  const regression: CaseResult[] = []
  for (let n = 1; n < checkpoint; n += 1) {
    const prev = bundles[n - 1]
    if (prev === undefined) continue
    for (const cas of prev) regression.push(await runCase(ws, cas))
  }
  return assembleCheckRun(iso, regression)
}

function promptFor(checkpoint: number, spec: string): string {
  const body = spec.trim()
  if (checkpoint === 1) {
    return `Build this CLI in this repo. The entry point is src/cli.ts, run as node src/cli.ts <args>.\n\n${body}\n`
  }
  return `New requirements for the CLI in this repo (entry point src/cli.ts):\n\n${body}\n`
}

export const cliKind: Kind = {
  templateDir: join(EVALS_DIR, 'template'),
  planted: ['AGENTS.md', 'package.json', 'tsconfig.json', '.gitignore', '.oxlintrc.json'],
  promptFor,
  applyLintOverlay,
  prepareTools,
  prepareGrade: prepareTools,
  hydrateForChecks: async (dest, solutionDir) => {
    await copySolution(dest, solutionDir)
  },
  hydrateEmpty: async dest => {
    await mkdir(join(dest, 'src'), { recursive: true })
    await writeFile(join(dest, 'src/cli.ts'), 'export {}\n')
  },
  runCheckpoint,
  sourceFiles: srcDir => walkSource(srcDir, ['.ts']),
  yardstickOxlint: async () => {
    const example = await readJson(join(REPO_ROOT, 'oxlint/typescript/oxlintrc.example.json'))
    if (!isRecord(example)) throw new Error('oxlintrc.example.json must be an object')
    const cfg = withComplexityYardstick(example)
    cfg['$schema'] = join(REPO_ROOT, 'node_modules/oxlint/configuration_schema.json')
    return cfg
  },
  yardstickTsconfig: () => mergedTsconfig(join(EVALS_DIR, 'template/tsconfig.json')),
}
