import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ArmId,
  type Kind,
  type Problem,
  type RulePatch,
  getArm,
  isRecord,
  kindPatch,
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

export function applyRulePatch(cfg: Record<string, unknown>, patch: RulePatch | undefined): void {
  if (patch === undefined) return
  const rulesRaw = cfg['rules']
  if (!isRecord(rulesRaw)) throw new Error('oxlintrc rules missing')
  if (patch.drop !== undefined) {
    for (const id of patch.drop) delete rulesRaw[id]
    const overrides = cfg['overrides']
    if (Array.isArray(overrides)) {
      for (const o of overrides) {
        if (!isRecord(o) || !isRecord(o['rules'])) continue
        for (const id of patch.drop) delete o['rules'][id]
      }
    }
  }
  if (patch.add !== undefined) Object.assign(rulesRaw, patch.add)
}

export function applyRuleAdds(cfg: Record<string, unknown>, patch: RulePatch | undefined): void {
  if (patch?.add === undefined) return
  const rulesRaw = cfg['rules']
  if (!isRecord(rulesRaw)) throw new Error('oxlintrc rules missing')
  Object.assign(rulesRaw, patch.add)
}

async function applyArmExtras(ws: string, spec: ReturnType<typeof getArm>): Promise<void> {
  if (spec.extraDeps.length === 0 && !spec.tsReset) return
  const pkg = await readJson(join(ws, 'package.json'))
  if (!isRecord(pkg)) throw new Error('package.json must be an object')
  const deps = isRecord(pkg['devDependencies']) ? pkg['devDependencies'] : {}
  const repoDeps = await repoDevDeps()
  for (const name of spec.extraDeps) deps[name] = pinnedDep(repoDeps, name)
  pkg['devDependencies'] = deps
  await writeJson(join(ws, 'package.json'), pkg)
  if (!spec.tsReset) return
  await mkdir(join(ws, 'src'), { recursive: true })
  await writeFile(join(ws, 'src/reset.d.ts'), "import '@total-typescript/ts-reset'\n")
}

export async function materializeArm(dest: string, arm: ArmId, kindId: string): Promise<void> {
  const spec = getArm(arm)
  const kind = getKind(kindId)
  await mkdir(dest, { recursive: true })
  await cp(kind.templateDir, dest, { recursive: true })
  if (!spec.overlay) return
  await kind.applyLintOverlay(dest)
  if (spec.complexity) await applyComplexityOverlay(dest)
  const patch = kindPatch(spec, kindId)
  if (patch !== undefined) {
    const cfgPath = join(dest, '.oxlintrc.json')
    const cfg = await readJson(cfgPath)
    if (!isRecord(cfg)) throw new Error('.oxlintrc.json must be an object')
    applyRulePatch(cfg, patch)
    await writeJson(cfgPath, cfg)
  }
  await applyArmExtras(dest, spec)
}
