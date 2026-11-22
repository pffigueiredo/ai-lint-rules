import { type ArmId, ARM_IDS, isArmId } from './lib.ts'

export type Series = { mean: number; min: number; max: number }

export function uniqueArms(items: readonly { arm: ArmId }[]): ArmId[] {
  const out: ArmId[] = []
  for (const item of items) {
    if (!out.includes(item.arm)) out.push(item.arm)
  }
  return out
}

export function armsPresent(items: readonly { arm: ArmId }[]): ArmId[] {
  const have = new Set(items.map(i => i.arm))
  return ARM_IDS.filter(a => have.has(a))
}

export function resolveBaseline(present: readonly ArmId[], requested: string | undefined): ArmId {
  if (requested !== undefined) {
    if (!isArmId(requested)) throw new Error(`bad --baseline ${requested}`)
    if (!present.includes(requested)) throw new Error(`--baseline ${requested} not in run`)
    return requested
  }
  if (present.includes('plain')) return 'plain'
  const first = present[0]
  if (first === undefined) throw new Error('run has no arms')
  return first
}

export function otherArms(present: readonly ArmId[], baseline: ArmId): ArmId[] {
  return present.filter(a => a !== baseline)
}

export function stats(xs: number[]): Series {
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

export function fmt(s: Series, digits = 2): string {
  return `${s.mean.toFixed(digits)} (${s.min.toFixed(digits)}-${s.max.toFixed(digits)})`
}

export function rangesOverlap(a: Series, b: Series): boolean {
  return a.min <= b.max && b.min <= a.max
}

export function hhHead(baseline: ArmId, other: ArmId): string[] {
  return [
    `| metric | ${baseline} mean (min-max) | ${other} mean (min-max) | delta (${other} - ${baseline}) | overlap |`,
    '| --- | --- | --- | --- | --- |',
  ]
}

export function hhRow(name: string, a: Series, b: Series, digits: number): string {
  const delta = b.mean - a.mean
  const sign = delta > 0 ? '+' : ''
  const ov = rangesOverlap(a, b) ? 'yes' : 'no'
  return `| ${name} | ${fmt(a, digits)} | ${fmt(b, digits)} | ${sign}${delta.toFixed(digits)} | ${ov} |`
}

export function sectionTitle(base: string, other: ArmId, only: boolean): string {
  return only ? base : `${base} vs ${other}`
}

export function selfCheckCompare(): void {
  const head = hhHead('plain', 'lint')
  if (head[0] !== '| metric | plain mean (min-max) | lint mean (min-max) | delta (lint - plain) | overlap |') {
    throw new Error(`hhHead plain vs lint: ${head[0]}`)
  }
  if (resolveBaseline(['lint', 'plain'], undefined) !== 'plain') throw new Error('resolveBaseline prefers plain')
  if (resolveBaseline(['lint', 'lint-cc'], undefined) !== 'lint') {
    throw new Error('resolveBaseline first arm when plain is absent')
  }
  if (resolveBaseline(['lint', 'lint-cc'], 'lint-cc') !== 'lint-cc') throw new Error('resolveBaseline requested')
  if (otherArms(['plain', 'lint', 'lint-cc'], 'plain').join(',') !== 'lint,lint-cc') {
    throw new Error('otherArms')
  }
  if (otherArms(['lint', 'lint-v2'], 'lint').join(',') !== 'lint-v2') throw new Error('otherArms lint-v2')
  if (otherArms(['lint', 'lint-url'], 'lint').join(',') !== 'lint-url') throw new Error('otherArms lint-url')
  if (armsPresent([{ arm: 'lint-cc' }, { arm: 'lint' }]).join(',') !== 'lint,lint-cc') {
    throw new Error('armsPresent stable order')
  }
  if (armsPresent([{ arm: 'lint-v2' }, { arm: 'lint' }]).join(',') !== 'lint,lint-v2') {
    throw new Error('armsPresent lint-v2 after lint')
  }
  if (armsPresent([{ arm: 'lint-url' }, { arm: 'lint' }]).join(',') !== 'lint,lint-url') {
    throw new Error('armsPresent lint-url after lint')
  }
  if (sectionTitle('Outcome', 'lint', true) !== 'Outcome') throw new Error('sectionTitle only')
  if (sectionTitle('Outcome', 'lint-cc', false) !== 'Outcome vs lint-cc') throw new Error('sectionTitle many')
  const row = hhRow('statements', { mean: 1, min: 1, max: 1 }, { mean: 2, min: 2, max: 2 }, 1)
  if (!row.includes('+1.0')) throw new Error(`hhRow delta: ${row}`)
}
