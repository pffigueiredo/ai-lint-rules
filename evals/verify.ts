import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Bounds,
  type CheckResult,
  type PlantedBug,
  type PropertyId,
  DEFAULT_RUNS,
  DEFAULT_SEED,
  MAX_COMMANDS,
  PLANTED_BUGS,
  PROPERTIES,
  TODAY,
  checkProperty,
} from './problems/tasks/properties.ts'
import {
  type ArmId,
  type Manifest,
  capture,
  copySolution,
  isRecord,
  listCheckpointTags,
  parseManifest,
  readJson,
} from './lib.ts'
import { getKind, loadProblem } from './kinds.ts'

function usage(): never {
  process.stderr.write(
    'usage: node evals/verify.ts --self-check | node evals/verify.ts <runDir> [--checkpoint 5] [--runs N] [--seed S]\n',
  )
  process.exit(2)
}

function bounds(): Bounds {
  return { seed: DEFAULT_SEED, numRuns: DEFAULT_RUNS, maxCommands: MAX_COMMANDS }
}

function printResult(label: string, result: CheckResult): void {
  const head = `${label}: ${result.ok ? 'pass' : 'fail'} ${result.property} seed=${result.seed} runs=${result.numRuns}`
  process.stdout.write(`${head}\n`)
  if (result.ok) return
  if (result.commands.length > 0) {
    process.stdout.write(`  commands:\n`)
    for (const c of result.commands) process.stdout.write(`    ${c}\n`)
  }
  for (const line of result.detail.split('\n')) process.stdout.write(`  ${line}\n`)
}

async function applyBug(dir: string, bug: PlantedBug): Promise<void> {
  const path = join(dir, bug.file)
  const src = await readFile(path, 'utf8')
  const n = src.split(bug.find).length - 1
  if (n !== 1) throw new Error(`planted bug ${bug.id}: find hits ${n} times in ${bug.file}`)
  await writeFile(path, src.replace(bug.find, bug.replace))
}

async function selfCheck(): Promise<void> {
  const problem = await loadProblem('tasks')
  const b = bounds()
  process.stderr.write(
    `self-check bounds: seed ${b.seed}, ${b.numRuns} runs, max ${b.maxCommands} commands, today ${TODAY}, ids 1-4 and 99\n`,
  )
  const ref = await mkdtemp(join(tmpdir(), 'tasks-ref-'))
  const failed: string[] = []
  try {
    await copySolution(ref, problem.solutionDir)
    const cli = join(ref, 'src/cli.ts')
    const refResults = await Promise.all(
      PROPERTIES.map(async def => {
        process.stderr.write(`self-check reference ${def.id}\n`)
        const t0 = Date.now()
        const result = await checkProperty(cli, def.id, b)
        process.stderr.write(`  ${def.id} ${Date.now() - t0}ms\n`)
        return result
      }),
    )
    for (const result of refResults) {
      printResult('reference', result)
      if (!result.ok) failed.push(`reference failed ${result.property}`)
    }
  } finally {
    await rm(ref, { recursive: true, force: true })
  }
  const bugResults = await Promise.all(
    PLANTED_BUGS.map(async bug => {
      const dir = await mkdtemp(join(tmpdir(), `tasks-${bug.id}-`))
      try {
        await copySolution(dir, problem.solutionDir)
        await applyBug(dir, bug)
        process.stderr.write(`self-check planted ${bug.id} (${bug.property})\n`)
        const t0 = Date.now()
        const result = await checkProperty(join(dir, 'src/cli.ts'), bug.property, b)
        process.stderr.write(`  ${bug.id} ${Date.now() - t0}ms\n`)
        return { bug, result }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }),
  )
  for (const { bug, result } of bugResults) {
    printResult(`bug ${bug.id}`, result)
    if (result.ok) failed.push(`planted bug ${bug.id} did not fail ${bug.property}`)
    if (!result.ok && result.commands.length === 0) {
      failed.push(`planted bug ${bug.id} failed ${bug.property} without a shrunk command sequence`)
    }
  }
  if (failed.length > 0) {
    process.stderr.write(`${failed.join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write(
    `self-check ok: ${PROPERTIES.map(p => p.id).join(', ')}; planted ${PLANTED_BUGS.map(b => b.id).join(', ')}\n`,
  )
}

type PropertyRow = {
  id: string
  arm: ArmId
  checkpoint: number
  property: PropertyId
  ok: boolean
  seed: number
  numRuns: number
  commands: string[]
  detail: string
  ms: number
}

function rowKey(r: { id: string; checkpoint: number; property: string; seed: number; numRuns: number }): string {
  return `${r.id}|${r.checkpoint}|${r.property}|${r.seed}|${r.numRuns}`
}

function parseRow(raw: unknown): PropertyRow | undefined {
  if (!isRecord(raw)) return undefined
  const id = raw['id']
  const arm = raw['arm']
  const checkpoint = raw['checkpoint']
  const property = raw['property']
  const ok = raw['ok']
  const seed = raw['seed']
  const numRuns = raw['numRuns']
  const commands = raw['commands']
  const detail = raw['detail']
  const ms = raw['ms']
  if (typeof id !== 'string' || (arm !== 'plain' && arm !== 'lint')) return undefined
  if (typeof checkpoint !== 'number' || typeof property !== 'string' || typeof ok !== 'boolean') return undefined
  if (typeof seed !== 'number' || typeof numRuns !== 'number' || typeof detail !== 'string' || typeof ms !== 'number') {
    return undefined
  }
  if (!Array.isArray(commands) || commands.some(c => typeof c !== 'string')) return undefined
  const def = PROPERTIES.find(p => p.id === property)
  if (def === undefined) return undefined
  return { id, arm, checkpoint, property: def.id, ok, seed, numRuns, commands, detail, ms }
}

async function loadRows(path: string): Promise<PropertyRow[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const rows: PropertyRow[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    const row = parseRow(raw)
    if (row !== undefined) rows.push(row)
  }
  return rows
}

function propertiesMarkdown(rows: PropertyRow[], checkpoint: number, b: Bounds): string {
  const at = rows.filter(r => r.checkpoint === checkpoint && r.seed === b.seed && r.numRuns === b.numRuns)
  const lines: string[] = [
    '# Properties',
    '',
    `Checkpoint ${checkpoint}. Seed ${b.seed}, ${b.numRuns} runs, max ${b.maxCommands} commands, \`--today ${TODAY}\`, ids 1-4 and 99.`,
    '',
    '| property | plain violate | lint violate |',
    '| --- | --- | --- |',
  ]
  for (const def of PROPERTIES) {
    if (!def.checkpoints.includes(checkpoint)) continue
    const of = (arm: ArmId): string => {
      const xs = at.filter(r => r.property === def.id && r.arm === arm)
      if (xs.length === 0) return 'n/a'
      return `${xs.filter(r => !r.ok).length}/${xs.length}`
    }
    lines.push(`| ${def.id} | ${of('plain')} | ${of('lint')} |`)
  }
  lines.push('', '## Counterexamples', '')
  const bad = at.filter(r => !r.ok)
  if (bad.length === 0) {
    lines.push('None.', '')
    return `${lines.join('\n')}`
  }
  for (const r of bad) {
    const def = PROPERTIES.find(p => p.id === r.property)
    lines.push(`### \`${r.id}\` ${r.property}`, '')
    if (def !== undefined) lines.push(`${def.sentence}`, '')
    if (r.commands.length > 0) {
      lines.push('Commands:', '')
      lines.push('```')
      for (const c of r.commands) lines.push(`node src/cli.ts ${c}`)
      lines.push('```', '')
    }
    lines.push('```')
    lines.push(r.detail.trim() === '' ? '(no detail)' : r.detail.trim())
    lines.push('```', '')
  }
  return `${lines.join('\n')}`
}

async function appendRow(jsonlPath: string, row: PropertyRow): Promise<void> {
  await writeFile(jsonlPath, `${JSON.stringify(row)}\n`, { flag: 'a' })
}

async function verifyWorkspace(
  runDir: string,
  ws: Manifest['workspaces'][number],
  checkpoint: number,
  b: Bounds,
  done: Set<string>,
  jsonlPath: string,
): Promise<PropertyRow[]> {
  const kind = getKind('cli')
  const clone = await mkdtemp(join(tmpdir(), `${ws.id}-v-`))
  const written: PropertyRow[] = []
  try {
    const bundlePath = join(runDir, ws.bundle)
    const cloned = await capture('git', ['clone', bundlePath, clone], { cwd: runDir, timeoutMs: 30_000 })
    if (cloned.code !== 0) throw new Error(`git clone ${bundlePath}: ${cloned.stderr}`)
    await kind.prepareGrade(clone)
    const tags = await listCheckpointTags(clone)
    const defs = PROPERTIES.filter(p => p.checkpoints.includes(checkpoint))
    const missing = !tags.includes(checkpoint)
    if (!missing) {
      const co = await capture('git', ['checkout', '-f', `v${checkpoint}`], { cwd: clone, timeoutMs: 30_000 })
      if (co.code !== 0) throw new Error(`checkout v${checkpoint}: ${co.stderr}`)
      await kind.prepareGrade(clone)
    }
    const cli = join(clone, 'src/cli.ts')
    const pending = defs.filter(d => !done.has(rowKey({ id: ws.id, checkpoint, property: d.id, seed: b.seed, numRuns: b.numRuns })))
    const results = await Promise.all(
      pending.map(async def => {
        process.stderr.write(`verify ${ws.id} ${def.id}\n`)
        const t0 = Date.now()
        const result: CheckResult = missing
          ? {
              ok: false,
              property: def.id,
              seed: b.seed,
              numRuns: b.numRuns,
              commands: [],
              detail: `missing git tag v${checkpoint}`,
            }
          : await checkProperty(cli, def.id, b)
        const row: PropertyRow = {
          id: ws.id,
          arm: ws.arm,
          checkpoint,
          property: def.id,
          ok: result.ok,
          seed: result.seed,
          numRuns: result.numRuns,
          commands: result.commands,
          detail: result.detail,
          ms: Date.now() - t0,
        }
        return row
      }),
    )
    for (const row of results) {
      await appendRow(jsonlPath, row)
      done.add(rowKey(row))
      written.push(row)
    }
  } finally {
    await rm(clone, { recursive: true, force: true })
  }
  return written
}

async function verifyRunDir(runDir: string, checkpoint: number, b: Bounds): Promise<void> {
  const manifest = parseManifest(await readJson(join(runDir, 'manifest.json')))
  const jsonlPath = join(runDir, 'properties.jsonl')
  const existing = await loadRows(jsonlPath)
  const done = new Set(existing.map(rowKey))
  const tasks = manifest.workspaces.filter(w => w.problem === 'tasks')
  if (tasks.length === 0) throw new Error(`${runDir}: no tasks workspaces in manifest.json`)
  const rows = existing.slice()
  for (const ws of tasks) {
    process.stderr.write(`verify ${ws.id} checkpoint ${checkpoint}\n`)
    rows.push(...(await verifyWorkspace(runDir, ws, checkpoint, b, done, jsonlPath)))
  }
  const md = propertiesMarkdown(rows, checkpoint, b)
  await writeFile(join(runDir, 'properties.md'), md)
  process.stdout.write(md)
}

function parsePositiveInt(raw: string | undefined, flag: string): number {
  const n = Number(raw)
  if (raw === undefined || !Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a positive integer`)
  return n
}

function parseRunArgs(argv: string[]): { runDir: string; checkpoint: number; bounds: Bounds } {
  let runDir: string | undefined
  let checkpoint = 5
  let numRuns = DEFAULT_RUNS
  let seed = DEFAULT_SEED
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === undefined) break
    if (a === '--checkpoint') {
      i += 1
      checkpoint = parsePositiveInt(argv[i], '--checkpoint')
      continue
    }
    if (a === '--runs') {
      i += 1
      numRuns = parsePositiveInt(argv[i], '--runs')
      continue
    }
    if (a === '--seed') {
      i += 1
      seed = parsePositiveInt(argv[i], '--seed')
      continue
    }
    if (a.startsWith('--') || runDir !== undefined) usage()
    runDir = a
  }
  if (runDir === undefined) usage()
  return { runDir, checkpoint, bounds: { seed, numRuns, maxCommands: MAX_COMMANDS } }
}

const argv = process.argv.slice(2)
if (argv[0] === '--self-check' && argv.length === 1) {
  await selfCheck()
} else if (argv[0] !== undefined) {
  const parsed = parseRunArgs(argv)
  await verifyRunDir(parsed.runDir, parsed.checkpoint, parsed.bounds)
} else {
  usage()
}
