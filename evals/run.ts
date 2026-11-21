import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { finished } from 'node:stream/promises'
import {
  type ArmId,
  type Manifest,
  type Problem,
  type WorkspaceRow,
  EVALS_DIR,
  capture,
  findLeak,
  parseManifest,
  writeJson,
} from './lib.ts'
import { getKind, loadProblem, materializeArm } from './kinds.ts'

type Opts = {
  problems: string[]
  arms: ArmId[]
  reps: number
  model: string
  checkpoints: number | undefined
  concurrency: number
  timeoutMs: number
  out: string | undefined
}

function flagValues(argv: string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== name) continue
    const v = argv[i + 1]
    if (v === undefined) throw new Error(`missing value for ${name}`)
    out.push(v)
    i += 1
  }
  return out
}

function flagOnce(argv: string[], name: string): string | undefined {
  const xs = flagValues(argv, name)
  return xs[0]
}

function parseArgs(argv: string[]): Opts {
  const problems = flagValues(argv, '--problem')
  const armRaw = flagValues(argv, '--arm')
  const repsRaw = flagOnce(argv, '--reps')
  const model = flagOnce(argv, '--model')
  const checkpointsRaw = flagOnce(argv, '--checkpoints')
  const concurrencyRaw = flagOnce(argv, '--concurrency')
  const timeoutRaw = flagOnce(argv, '--timeout-min')
  const out = flagOnce(argv, '--out')
  if (problems.length === 0) throw new Error('need --problem <slug>')
  if (armRaw.length === 0) throw new Error('need --arm plain|lint')
  const arms: ArmId[] = []
  for (const a of armRaw) {
    if (a !== 'plain' && a !== 'lint') throw new Error(`bad --arm ${a}`)
    if (!arms.includes(a)) arms.push(a)
  }
  const reps = Number(repsRaw)
  if (!Number.isInteger(reps) || reps < 1) throw new Error('--reps must be a positive integer')
  if (model === undefined || model.length === 0) throw new Error('need --model')
  const checkpoints = checkpointsRaw === undefined ? undefined : Number(checkpointsRaw)
  if (checkpoints !== undefined && (!Number.isInteger(checkpoints) || checkpoints < 1)) {
    throw new Error('--checkpoints must be a positive integer')
  }
  const concurrency = Number(concurrencyRaw ?? '2')
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer')
  const timeoutMin = Number(timeoutRaw ?? '20')
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) throw new Error('--timeout-min must be a positive number')
  return { problems, arms, reps, model, checkpoints, concurrency, timeoutMs: timeoutMin * 60_000, out }
}

function stamp(): string {
  return new Date().toISOString().replaceAll(/[-:]/g, '').replace('Z', '').slice(0, 15)
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@local',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@local',
}

async function git(cwd: string, args: string[]): Promise<void> {
  const ran = await capture('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    timeoutMs: 30_000,
  })
  if (ran.code !== 0) throw new Error(`git ${args.join(' ')}\n${ran.stderr}${ran.stdout}`)
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const ran = await capture('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    timeoutMs: 30_000,
  })
  if (ran.code !== 0) throw new Error(`git ${args.join(' ')}\n${ran.stderr}${ran.stdout}`)
  return ran.stdout
}

async function assertBlind(ws: string, prompt: string, planted: readonly string[]): Promise<void> {
  const promptHit = findLeak(prompt)
  if (promptHit !== undefined) throw new Error(`prompt leaks ${JSON.stringify(promptHit)}`)
  const pathHit = findLeak(ws)
  if (pathHit !== undefined) throw new Error(`workspace path leaks ${JSON.stringify(pathHit)}`)
  for (const rel of planted) {
    let body: string
    try {
      body = await readFile(join(ws, rel), 'utf8')
    } catch {
      continue
    }
    const hit = findLeak(rel) ?? findLeak(body)
    if (hit !== undefined) throw new Error(`${rel} leaks ${JSON.stringify(hit)}`)
  }
}

async function hasTag(ws: string, tag: string): Promise<boolean> {
  const ran = await capture('git', ['tag', '-l', tag], { cwd: ws, env: { ...process.env, ...GIT_ENV } })
  return ran.stdout.trim() === tag
}

async function runAgent(
  ws: string,
  prompt: string,
  model: string,
  logPath: string,
  timeoutMs: number,
): Promise<'ok' | 'timeout' | 'error'> {
  await mkdir(dirname(logPath), { recursive: true })
  const out = createWriteStream(logPath)
  let timedOut = false
  let spawnErr: string | undefined
  await new Promise<void>(resolve => {
    const proc = spawn(
      'cursor-agent',
      ['-p', '--force', '--trust', '--output-format', 'stream-json', '--model', model, '--workspace', ws, prompt],
      { cwd: ws, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    proc.stdout.pipe(out, { end: false })
    proc.stderr.resume()
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)
    proc.on('error', err => {
      spawnErr = err instanceof Error ? err.message : String(err)
      clearTimeout(timer)
      resolve()
    })
    proc.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  out.end()
  await finished(out).catch(() => undefined)
  if (timedOut) {
    await appendFile(
      logPath,
      `${JSON.stringify({ type: 'result', subtype: 'error', is_error: true, timed_out: true })}\n`,
    )
    return 'timeout'
  }
  if (spawnErr !== undefined) {
    await appendFile(
      logPath,
      `${JSON.stringify({ type: 'result', subtype: 'error', is_error: true, error: spawnErr })}\n`,
    )
    return 'error'
  }
  return 'ok'
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  const q = items.slice()
  const workers = Array.from({ length: Math.min(n, Math.max(q.length, 1)) }, async () => {
    for (;;) {
      const item = q.shift()
      if (item === undefined) return
      await fn(item)
    }
  })
  await Promise.all(workers)
}

async function prepareWorkspace(dest: string, arm: ArmId, kindId: string): Promise<void> {
  await rm(dest, { recursive: true, force: true })
  await materializeArm(dest, arm, kindId)
  const install = await capture('pnpm', ['install', '--prefer-offline'], { cwd: dest, timeoutMs: 120_000 })
  if (install.code !== 0) throw new Error(`pnpm install\n${install.stderr}${install.stdout}`)
  await git(dest, ['init'])
  await git(dest, ['add', '-A'])
  await git(dest, ['commit', '--allow-empty', '-m', 'start'])
  await git(dest, ['tag', '-f', 'v0'])
}

async function restoreFromBundle(bundle: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true })
  await git(process.cwd(), ['clone', bundle, dest])
  const install = await capture('pnpm', ['install', '--prefer-offline'], { cwd: dest, timeoutMs: 120_000 })
  if (install.code !== 0) throw new Error(`pnpm install after clone\n${install.stderr}${install.stdout}`)
}

type Job = {
  problem: Problem
  arm: ArmId
  rep: number
  k: number
  row: WorkspaceRow
}

async function runJob(runDir: string, model: string, timeoutMs: number, job: Job): Promise<void> {
  let ws = job.row.workspaceDir
  try {
    await gitOut(ws, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    const bundle = join(runDir, job.row.bundle)
    await restoreFromBundle(bundle, ws)
  }
  for (let n = 1; n <= job.k; n += 1) {
    if (await hasTag(ws, `v${n}`)) {
      process.stderr.write(`${job.row.id} skip v${n}\n`)
      continue
    }
    const spec = job.problem.specs[n - 1]
    if (spec === undefined) throw new Error(`${job.problem.slug} missing checkpoint ${n}`)
    const kind = getKind(job.problem.kind)
    const prompt = kind.promptFor(n, spec)
    await assertBlind(ws, prompt, kind.planted)
    const logPath = join(runDir, job.row.id, `agent-${n}.jsonl`)
    process.stderr.write(`${job.row.id} checkpoint ${n}\n`)
    const status = await runAgent(ws, prompt, model, logPath, timeoutMs)
    if (status !== 'ok') process.stderr.write(`${job.row.id} agent ${status}\n`)
    await git(ws, ['add', '-A'])
    await git(ws, ['commit', '--allow-empty', '-m', `v${n}`])
    await git(ws, ['tag', '-f', `v${n}`])
    await git(ws, ['bundle', 'create', join(runDir, job.row.bundle), '--all'])
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const problems: Problem[] = []
  for (const slug of opts.problems) problems.push(await loadProblem(slug))
  const runDir = opts.out ?? join(EVALS_DIR, 'runs', stamp())
  await mkdir(runDir, { recursive: true })
  let manifest: Manifest
  try {
    const raw: unknown = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'))
    manifest = parseManifest(raw)
  } catch {
    manifest = { createdAt: new Date().toISOString(), model: opts.model, checkpoints: 0, workspaces: [] }
  }

  const jobs: Job[] = []
  for (const problem of problems) {
    const k = Math.min(opts.checkpoints ?? problem.specs.length, problem.specs.length)
    if (manifest.checkpoints === 0) manifest.checkpoints = k
    for (let rep = 1; rep <= opts.reps; rep += 1) {
      for (const arm of opts.arms) {
        const id = `${problem.slug}-${arm}-r${rep}`
        let row = manifest.workspaces.find(w => w.id === id)
        if (row === undefined) {
          const ws = join(tmpdir(), `${problem.slug}-${randomBytes(4).toString('hex')}`)
          process.stderr.write(`prepare ${id} -> ${ws}\n`)
          await prepareWorkspace(ws, arm, problem.kind)
          row = {
            id,
            problem: problem.slug,
            arm,
            rep,
            model: opts.model,
            bundle: `${id}.bundle`,
            workspaceDir: ws,
          }
          manifest.workspaces.push(row)
          await writeJson(join(runDir, 'manifest.json'), manifest)
        }
        jobs.push({ problem, arm, rep, k, row })
      }
    }
  }
  await writeJson(join(runDir, 'manifest.json'), manifest)
  await pool(jobs, opts.concurrency, job => runJob(runDir, opts.model, opts.timeoutMs, job))
  process.stdout.write(`${runDir}\n`)
}

await main()
