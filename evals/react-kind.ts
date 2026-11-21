import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
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

const TEMPLATE_DIR = join(EVALS_DIR, 'template-react')
const REACT_BANS_SRC = join(REPO_ROOT, 'oxlint/react-bans')
const STACK_EXAMPLE = join(REPO_ROOT, 'oxlint/stack/oxlintrc.example.json')
const REPO_PLUGIN = join(REPO_ROOT, 'oxlint/react-bans/plugin.js')

const GRADING_DEPS = [
  'vitest',
  'jsdom',
  '@testing-library/react',
  '@testing-library/user-event',
  '@testing-library/dom',
  '@vitejs/plugin-react',
  'oxlint',
  'oxlint-tsgolint',
  '@oxlint/plugins',
  'eslint-plugin-react-you-might-not-need-an-effect',
] as const

const OVERLAY_DEPS = [
  'oxlint',
  'oxlint-tsgolint',
  '@oxlint/plugins',
  'eslint-plugin-react-you-might-not-need-an-effect',
] as const

function stackMinusTailwind(
  example: Record<string, unknown>,
  pluginPath: string,
): Record<string, unknown> {
  const jsPluginsRaw = example['jsPlugins']
  const jsPlugins = Array.isArray(jsPluginsRaw) ? jsPluginsRaw : []
  const nextPlugins: unknown[] = []
  for (const p of jsPlugins) {
    if (p === 'eslint-plugin-better-tailwindcss') continue
    if (p === './oxlint/react-bans/plugin.js') {
      nextPlugins.push(pluginPath)
      continue
    }
    nextPlugins.push(p)
  }
  const rulesRaw = example['rules']
  if (!isRecord(rulesRaw)) throw new Error('stack oxlintrc rules missing')
  const rules: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rulesRaw)) {
    if (k.startsWith('better-tailwindcss/')) continue
    rules[k] = v
  }
  const out: Record<string, unknown> = { ...example, jsPlugins: nextPlugins, rules }
  const settingsRaw = example['settings']
  if (isRecord(settingsRaw)) {
    const settings = { ...settingsRaw }
    delete settings['better-tailwindcss']
    if (Object.keys(settings).length === 0) delete out['settings']
    else out['settings'] = settings
  }
  return out
}

async function copyReactBans(destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  const ents = await readdir(REACT_BANS_SRC)
  for (const name of ents) {
    if (!name.endsWith('.js')) continue
    await cp(join(REACT_BANS_SRC, name), join(destDir, name))
  }
}

async function applyLintOverlay(ws: string): Promise<void> {
  const example = await readJson(STACK_EXAMPLE)
  if (!isRecord(example)) throw new Error('stack oxlintrc.example.json must be an object')
  await copyReactBans(join(ws, 'react-bans'))
  const cfg = stackMinusTailwind(example, './react-bans/plugin.js')
  cfg['$schema'] = './node_modules/oxlint/configuration_schema.json'
  const ignoreRaw = cfg['ignorePatterns']
  const ignore = Array.isArray(ignoreRaw) ? ignoreRaw.filter(p => typeof p === 'string') : []
  if (!ignore.includes('react-bans/**')) ignore.push('react-bans/**')
  cfg['ignorePatterns'] = ignore
  await writeJson(join(ws, '.oxlintrc.json'), cfg)
  await mergeCompilerOptions(join(ws, 'tsconfig.json'))
  const pkg = await readJson(join(ws, 'package.json'))
  if (!isRecord(pkg)) throw new Error('package.json must be an object')
  const repoDeps = await repoDevDeps()
  const deps = pkg['devDependencies']
  if (!isRecord(deps)) throw new Error('workspace devDependencies missing')
  for (const name of OVERLAY_DEPS) deps[name] = pinnedDep(repoDeps, name)
  pkg['scripts'] = { check: 'tsc && oxlint' }
  await writeJson(join(ws, 'package.json'), pkg)
}

async function mergeGradingDeps(ws: string): Promise<void> {
  const pkg = await readJson(join(ws, 'package.json'))
  if (!isRecord(pkg)) throw new Error('package.json must be an object')
  const repoDeps = await repoDevDeps()
  const deps = isRecord(pkg['devDependencies']) ? pkg['devDependencies'] : {}
  for (const name of GRADING_DEPS) deps[name] = pinnedDep(repoDeps, name)
  pkg['devDependencies'] = deps
  await writeJson(join(ws, 'package.json'), pkg)
}

async function pnpmInstall(ws: string): Promise<void> {
  const ran = await capture('pnpm', ['install', '--prefer-offline'], { cwd: ws, timeoutMs: 180_000 })
  if (ran.code !== 0) throw new Error(`pnpm install\n${ran.stderr}${ran.stdout}`)
}

async function prepareTools(ws: string): Promise<void> {
  await pnpmInstall(ws)
}

async function prepareGrade(ws: string): Promise<void> {
  await mergeGradingDeps(ws)
  await pnpmInstall(ws)
}

function promptFor(checkpoint: number, spec: string): string {
  const body = spec.trim()
  if (checkpoint === 1) {
    return `Build this app in this repo. The app is the default export of src/App.tsx. Data comes from fetch calls to /api/... endpoints. JSON shapes are listed with each endpoint.\n\n${body}\n`
  }
  return `New requirements for the app in this repo (default export of src/App.tsx):\n\n${body}\n`
}

function checkpointOf(file: string): number {
  const m = /checkpoint_(\d+)\.test\.tsx$/.exec(file.replaceAll('\\', '/'))
  if (m === null) throw new Error(`cannot read checkpoint index from ${file}`)
  const n = Number(m[1])
  if (!Number.isInteger(n) || n < 1) throw new Error(`bad checkpoint index in ${file}`)
  return n
}

function groupOf(ancestors: string[], fullName: string): Group {
  for (const a of ancestors) {
    if (isGroup(a)) return a
  }
  throw new Error(`hidden check ${JSON.stringify(fullName)} is not under core, error, or functionality`)
}

function collectVitestResults(raw: unknown, checkpoint: number): { iso: CaseResult[]; regression: CaseResult[] } {
  if (!isRecord(raw) || !Array.isArray(raw['testResults'])) {
    throw new Error('vitest json: missing testResults')
  }
  const iso: CaseResult[] = []
  const regression: CaseResult[] = []
  for (const file of raw['testResults']) {
    if (!isRecord(file) || typeof file['name'] !== 'string' || !Array.isArray(file['assertionResults'])) {
      continue
    }
    const n = checkpointOf(file['name'])
    for (const a of file['assertionResults']) {
      if (!isRecord(a)) continue
      const title = a['fullName']
      const status = a['status']
      const ancestors = a['ancestorTitles']
      if (typeof title !== 'string' || typeof status !== 'string' || !Array.isArray(ancestors)) continue
      const ancestorTitles = ancestors.filter(s => typeof s === 'string')
      const failMsgs = a['failureMessages']
      const detail =
        Array.isArray(failMsgs) ? failMsgs.filter(s => typeof s === 'string').join('\n') : ''
      const row: CaseResult = {
        name: title,
        group: groupOf(ancestorTitles, title),
        pass: status === 'passed',
        detail: status === 'passed' ? '' : detail,
      }
      if (n === checkpoint) iso.push(row)
      else if (n < checkpoint) regression.push(row)
    }
  }
  return { iso, regression }
}

async function copyHiddenChecks(ws: string, problem: Problem, checkpoint: number): Promise<string[]> {
  const files: string[] = []
  for (let n = 1; n <= checkpoint; n += 1) {
    const name = `checkpoint_${n}.test.tsx`
    await cp(join(problem.dir, name), join(ws, name))
    files.push(name)
  }
  await cp(join(EVALS_DIR, 'react-render.tsx'), join(ws, 'render-app.tsx'))
  return files
}

async function writeVitestConfig(ws: string, files: string[]): Promise<void> {
  await writeFile(
    join(ws, 'grader-setup.mjs'),
    `import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})
`,
  )
  const body = `import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    reporters: ['json'],
    outputFile: 'check-results.json',
    include: ${JSON.stringify(files)},
    setupFiles: ['./grader-setup.mjs'],
    testTimeout: 2500,
    fileParallelism: false,
  },
})
`
  await writeFile(join(ws, 'grader-vitest.config.mjs'), body)
}

async function runCheckpoint(ws: string, problem: Problem, checkpoint: number): Promise<CheckRun> {
  const files = await copyHiddenChecks(ws, problem, checkpoint)
  await writeVitestConfig(ws, files)
  const ran = await capture('pnpm', ['exec', 'vitest', 'run', '--config', 'grader-vitest.config.mjs'], {
    cwd: ws,
    timeoutMs: 120_000,
  })
  let raw: unknown
  try {
    raw = await readJson(join(ws, 'check-results.json'))
  } catch {
    throw new Error(`vitest produced no results (exit ${ran.code})\n${ran.stderr}\n${ran.stdout}`)
  }
  const { iso, regression } = collectVitestResults(raw, checkpoint)
  if (iso.length === 0 && regression.length === 0) {
    throw new Error(`vitest reported no checks for checkpoint ${checkpoint}\n${ran.stderr}\n${ran.stdout}`)
  }
  return assembleCheckRun(iso, regression)
}

async function hydrateFromTemplate(dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  await cp(TEMPLATE_DIR, dest, { recursive: true })
}

export const reactKind: Kind = {
  templateDir: TEMPLATE_DIR,
  planted: [
    'AGENTS.md',
    'package.json',
    'tsconfig.json',
    '.gitignore',
    '.oxlintrc.json',
    'vite.config.ts',
    'index.html',
    'src/main.tsx',
    'src/App.tsx',
    'src/vite-env.d.ts',
  ],
  promptFor,
  applyLintOverlay,
  prepareTools,
  prepareGrade,
  hydrateForChecks: async (dest, solutionDir) => {
    await hydrateFromTemplate(dest)
    await copySolution(dest, solutionDir)
    await prepareGrade(dest)
  },
  hydrateEmpty: async dest => {
    await hydrateFromTemplate(dest)
    await writeFile(
      join(dest, 'src/App.tsx'),
      'export default function App() {\n  return null\n}\n',
    )
    await prepareGrade(dest)
  },
  runCheckpoint,
  sourceFiles: srcDir => walkSource(srcDir, ['.ts', '.tsx']),
  knipEntry: ['src/main.tsx', 'src/App.tsx'],
  yardstickOxlint: async () => {
    const example = await readJson(STACK_EXAMPLE)
    if (!isRecord(example)) throw new Error('stack oxlintrc.example.json must be an object')
    const cfg = withComplexityYardstick(stackMinusTailwind(example, REPO_PLUGIN))
    cfg['$schema'] = join(REPO_ROOT, 'node_modules/oxlint/configuration_schema.json')
    return cfg
  },
  yardstickTsconfig: () => mergedTsconfig(join(TEMPLATE_DIR, 'tsconfig.json')),
  concurrency: 1,
}
