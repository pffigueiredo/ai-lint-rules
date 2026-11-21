import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ArmId,
  type Kind,
  type Problem,
  isRecord,
  loadProblem as loadProblemMeta,
  pinnedDep,
  readJson,
  repoDevDeps,
  writeJson,
} from './lib.ts'
import { cliKind } from './cli-kind.ts'
import { reactKind } from './react-kind.ts'

export const COMPLEXITY_PLUGIN = 'oxlint-plugin-complexity'
export const COMPLEXITY_CYCLOMATIC_MAX = 20
export const COMPLEXITY_COGNITIVE_MAX = 15
export const COMPLEXITY_RULES: Record<string, unknown> = {
  'eslint/complexity': ['error', { max: COMPLEXITY_CYCLOMATIC_MAX }],
  'complexity/complexity': [
    'error',
    { cyclomatic: 10_000, cognitive: COMPLEXITY_COGNITIVE_MAX, minLines: 0 },
  ],
}

export const KINDS = {
  cli: cliKind,
  react: reactKind,
}

export type KindId = keyof typeof KINDS

export function getKind(id: string): Kind {
  if (id in KINDS) return KINDS[id as KindId]
  throw new Error(`unknown kind ${JSON.stringify(id)}`)
}

export async function loadProblem(slug: string): Promise<Problem> {
  const problem = await loadProblemMeta(slug)
  getKind(problem.kind)
  return problem
}

export async function applyComplexityOverlay(ws: string): Promise<void> {
  const cfgPath = join(ws, '.oxlintrc.json')
  const cfg = await readJson(cfgPath)
  if (!isRecord(cfg)) throw new Error('.oxlintrc.json must be an object')
  const pluginsRaw = cfg['plugins']
  const plugins = Array.isArray(pluginsRaw) ? pluginsRaw.filter(p => typeof p === 'string') : []
  if (!plugins.includes('eslint')) plugins.push('eslint')
  const jsPluginsRaw = cfg['jsPlugins']
  const jsPlugins = Array.isArray(jsPluginsRaw) ? [...jsPluginsRaw] : []
  if (!jsPlugins.includes(COMPLEXITY_PLUGIN)) jsPlugins.push(COMPLEXITY_PLUGIN)
  const rules = cfg['rules']
  if (!isRecord(rules)) throw new Error('oxlintrc rules missing')
  cfg['plugins'] = plugins
  cfg['jsPlugins'] = jsPlugins
  cfg['rules'] = { ...rules, ...COMPLEXITY_RULES }
  await writeJson(cfgPath, cfg)
  const pkg = await readJson(join(ws, 'package.json'))
  if (!isRecord(pkg)) throw new Error('package.json must be an object')
  const deps = pkg['devDependencies']
  if (!isRecord(deps)) throw new Error('workspace devDependencies missing')
  deps[COMPLEXITY_PLUGIN] = pinnedDep(await repoDevDeps(), COMPLEXITY_PLUGIN)
  await writeJson(join(ws, 'package.json'), pkg)
}

export async function materializeArm(dest: string, arm: ArmId, kindId: string): Promise<void> {
  const kind = getKind(kindId)
  await mkdir(dest, { recursive: true })
  await cp(kind.templateDir, dest, { recursive: true })
  if (arm === 'plain') return
  await kind.applyLintOverlay(dest)
  if (arm === 'lint-cc') await applyComplexityOverlay(dest)
}
