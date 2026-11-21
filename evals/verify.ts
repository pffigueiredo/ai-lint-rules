import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Bounds,
  type CheckResult,
  type PlantedBug,
  DEFAULT_RUNS,
  DEFAULT_SEED,
  MAX_COMMANDS,
  PLANTED_BUGS,
  PROPERTIES,
  TODAY,
  checkProperty,
} from './problems/tasks/properties.ts'
import { copySolution } from './lib.ts'
import { loadProblem } from './kinds.ts'

function usage(): never {
  process.stderr.write('usage: node evals/verify.ts --self-check\n')
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

const argv = process.argv.slice(2)
if (argv[0] === '--self-check' && argv.length === 1) {
  await selfCheck()
} else {
  usage()
}
