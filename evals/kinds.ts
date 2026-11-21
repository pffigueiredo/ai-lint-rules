import { cp, mkdir } from 'node:fs/promises'
import {
  type ArmId,
  type Kind,
  type Problem,
  loadProblem as loadProblemMeta,
} from './lib.ts'
import { cliKind } from './cli-kind.ts'

export const KINDS = {
  cli: cliKind,
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

export async function materializeArm(dest: string, arm: ArmId, kindId: string): Promise<void> {
  const kind = getKind(kindId)
  await mkdir(dest, { recursive: true })
  await cp(kind.templateDir, dest, { recursive: true })
  if (arm === 'lint') await kind.applyLintOverlay(dest)
}
