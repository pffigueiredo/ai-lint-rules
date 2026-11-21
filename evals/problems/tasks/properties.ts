import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import fc from 'fast-check'
import { type Capture, capture, isRecord } from '../../lib.ts'

export const TODAY = '2024-03-15'
export const DEFAULT_SEED = 20261121
// ponytail: 8 sequences of at most 8 generated commands, ids 1-4 and 99. Ceiling: traces longer than that. Raise DEFAULT_RUNS / MAX_COMMANDS if a bug only shows up later.
export const DEFAULT_RUNS = 8
export const MAX_COMMANDS = 8
export const STEP_TIMEOUT_MS = 8_000
export const ID_POOL = [1, 2, 3, 4, 99] as const

export type PropertyId =
  | 'undo-restores'
  | 'fail-is-noop'
  | 'no-cycle'
  | 'ready-matches-json'
  | 'done-blocked-or-recurring'
  | 'unique-ids'

export type Bounds = {
  seed: number
  numRuns: number
  maxCommands: number
}

export type PropertyDef = {
  id: PropertyId
  sentence: string
  spec: string
  checkpoints: number[]
}

export const PROPERTIES: PropertyDef[] = [
  {
    id: 'undo-restores',
    sentence:
      'A successful add, done, or block followed by undo must leave list --json, overdue, and stats as they were, including a recurring spawn and restored blockers, or the user sees the wrong tasks.',
    spec: 'checkpoint_5.md: "undo reverses the most recent successful add, done, or block... A spawned recurring task is part of the done it came from. Removing a block link restores the previous blockers." checkpoint_3.md: "restore the tasks to the state before that command."',
    checkpoints: [3, 4, 5],
  },
  {
    id: 'fail-is-noop',
    sentence:
      'A failing command must change nothing observable and must not be the thing the next undo reverses, or undo skips the real edit.',
    spec: 'checkpoint_5.md: "A failed cycle is not undone by undo." "That failed done is not undone by undo." checkpoint_3.md: failed done does not count; "If there is nothing to reverse, exit 1".',
    checkpoints: [3, 4, 5],
  },
  {
    id: 'no-cycle',
    sentence:
      'blockedOn in list --json must never contain a cycle, or a ring of tasks can never be marked done.',
    spec: 'checkpoint_5.md: "On a cycle, do not record the new link." "A cycle is a chain of block links that returns to its start, including a task blocked on itself."',
    checkpoints: [5],
  },
  {
    id: 'ready-matches-json',
    sentence:
      'list --ready must be the open tasks in list --json that have no open blocker, or the ready list hides work that can start or shows work that cannot.',
    spec: 'checkpoint_5.md: "Print only open tasks that are not blocked." "A task is blocked when at least one of its blocker ids refers to a task whose status is open." "A blocker id that does not refer to a current task is ignored."',
    checkpoints: [5],
  },
  {
    id: 'done-blocked-or-recurring',
    sentence:
      'done on an open blocked task must exit 1 with blocked and change nothing; done on a recurring unblocked open task must add exactly one new open task. The first lets a blocked task skip its wait. The second drops the next occurrence.',
    spec: 'checkpoint_5.md: "done on an open blocked task: exit 1 and print blocked. Do not change status. Do not spawn a recurring next task." checkpoint_4.md: "Completing an open recurring task marks it done and appends a new open task with a new id."',
    checkpoints: [4, 5],
  },
  {
    id: 'unique-ids',
    sentence: 'Task ids in list --json must stay unique, or done, block, and undo target the wrong row.',
    spec: 'checkpoint_1.md: "id values are unique positive integers."',
    checkpoints: [1, 2, 3, 4, 5],
  },
]

export type PlantedBug = {
  id: string
  property: PropertyId
  file: 'src/cli.ts' | 'src/lib.ts'
  find: string
  replace: string
}

export const PLANTED_BUGS: PlantedBug[] = [
  {
    id: 'undo-drops-blockers-keeps-spawn',
    property: 'undo-restores',
    file: 'src/cli.ts',
    find: '    store.tasks = prev\n    await saveStore(store)',
    replace:
      '    const extras = store.tasks.filter(t => prev.every(p => p.id !== t.id))\n    store.tasks = prev.map(t => ({ ...t, blockedOn: [] }))\n    store.tasks.push(...extras)\n    await saveStore(store)',
  },
  {
    id: 'cycle-pushed-on-undo-stack',
    property: 'fail-is-noop',
    file: 'src/cli.ts',
    find:
      '    if (wouldCycle(store.tasks, parsed.id, parsed.on)) {\n      writeOut(\'cycle\\n\')\n      process.exitCode = 4\n      return\n    }\n    store.history.push(cloneTasks(store.tasks))',
    replace:
      '    store.history.push(cloneTasks(store.tasks))\n    if (wouldCycle(store.tasks, parsed.id, parsed.on)) {\n      await saveStore(store)\n      writeOut(\'cycle\\n\')\n      process.exitCode = 4\n      return\n    }',
  },
  {
    id: 'cycle-misses-three',
    property: 'no-cycle',
    file: 'src/lib.ts',
    find:
      'export function wouldCycle(tasks: Task[], id: number, on: number): boolean {\n  if (id === on) return true\n  return canReach(tasks, on, id)\n}',
    replace:
      'export function wouldCycle(tasks: Task[], id: number, on: number): boolean {\n  if (id === on) return true\n  const t = tasks.find(x => x.id === on)\n  return t !== undefined && t.blockedOn.includes(id)\n}',
  },
  {
    id: 'ready-ignores-blockers',
    property: 'ready-matches-json',
    file: 'src/cli.ts',
    find:
      '    if (parsed.ready) tasks = tasks.filter(t => t.status === \'open\' && !isBlocked(loaded.store.tasks, t))',
    replace: '    if (parsed.ready) tasks = tasks.filter(t => t.status === \'open\')',
  },
  {
    id: 'blocked-done-flips-status',
    property: 'done-blocked-or-recurring',
    file: 'src/cli.ts',
    find:
      '    if (task.status === \'open\' && isBlocked(store.tasks, task)) {\n      writeOut(\'blocked\\n\')\n      process.exitCode = 1\n      return\n    }\n',
    replace: '',
  },
  {
    id: 'next-id-always-one',
    property: 'unique-ids',
    file: 'src/lib.ts',
    find:
      'export function nextId(tasks: Task[]): number {\n  let max = 0\n  for (const t of tasks) {\n    if (t.id > max) max = t.id\n  }\n  return max + 1\n}',
    replace: 'export function nextId(tasks: Task[]): number {\n  return 1\n}',
  },
]

export type CheckResult = {
  ok: boolean
  property: PropertyId
  seed: number
  numRuns: number
  commands: string[]
  detail: string
}

type Model = {
  undoStack: View[]
}

type Real = {
  cli: string
  cwd: string
  ran: string[]
}

type View = {
  listRaw: string
  listCode: number
  items: unknown[] | undefined
  overdueRaw: string
  statsRaw: string
  readyRaw: string
  readyItems: unknown[] | undefined
}

function trimLines(s: string): string {
  return s
    .split('\n')
    .map(l => l.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n+$/u, '')
}

function parseJsonArray(stdout: string): unknown[] | undefined {
  try {
    const v: unknown = JSON.parse(stdout)
    if (!Array.isArray(v)) return undefined
    return v
  } catch {
    return undefined
  }
}

function idOf(item: unknown): number | undefined {
  if (!isRecord(item)) return undefined
  const id = item['id']
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) return undefined
  return id
}

function statusOf(item: unknown): unknown {
  return isRecord(item) ? item['status'] : undefined
}

function everyOf(item: unknown): 'week' | 'month' | undefined {
  if (!isRecord(item)) return undefined
  const every = item['every']
  if (every === 'week' || every === 'month') return every
  return undefined
}

function blockedOnOf(item: unknown): number[] | undefined {
  if (!isRecord(item)) return undefined
  const raw = item['blockedOn']
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return undefined
  const ids: number[] = []
  for (const x of raw) {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 1) return undefined
    ids.push(x)
  }
  return ids
}

function isOpenBlocked(items: unknown[], item: unknown): boolean {
  const edges = blockedOnOf(item)
  if (edges === undefined) return false
  for (const id of edges) {
    const blocker = items.find(x => idOf(x) === id)
    if (blocker !== undefined && statusOf(blocker) === 'open') return true
  }
  return false
}

function hasCycle(items: unknown[]): boolean {
  const byId = new Map<number, unknown>()
  for (const item of items) {
    const id = idOf(item)
    if (id !== undefined) byId.set(id, item)
  }
  const visiting = new Set<number>()
  const seen = new Set<number>()
  const visit = (id: number): boolean => {
    if (visiting.has(id)) return true
    if (seen.has(id)) return false
    visiting.add(id)
    const item = byId.get(id)
    const edges = item === undefined ? [] : blockedOnOf(item)
    if (edges !== undefined) {
      for (const b of edges) {
        if (visit(b)) return true
      }
    }
    visiting.delete(id)
    seen.add(id)
    return false
  }
  for (const id of byId.keys()) {
    if (visit(id)) return true
  }
  return false
}

function sameObs(a: View, b: View): boolean {
  const listEq =
    a.items !== undefined && b.items !== undefined
      ? isDeepStrictEqual(a.items, b.items)
      : trimLines(a.listRaw) === trimLines(b.listRaw)
  return listEq && trimLines(a.overdueRaw) === trimLines(b.overdueRaw) && trimLines(a.statsRaw) === trimLines(b.statsRaw)
}

function fmtObs(v: View): string {
  return JSON.stringify({
    list: v.items ?? trimLines(v.listRaw),
    overdue: trimLines(v.overdueRaw),
    stats: trimLines(v.statsRaw),
  })
}

function needsOverdueStats(property: PropertyId): boolean {
  return (
    property === 'undo-restores' ||
    property === 'fail-is-noop' ||
    property === 'done-blocked-or-recurring'
  )
}

function needsReady(property: PropertyId): boolean {
  return property === 'ready-matches-json'
}

async function exec(r: Real, args: readonly string[]): Promise<Capture> {
  return capture('node', [r.cli, ...args], { cwd: r.cwd, timeoutMs: STEP_TIMEOUT_MS })
}

async function observe(property: PropertyId, r: Real): Promise<View> {
  const list = await exec(r, ['list', '--json'])
  const items = list.code === 0 ? parseJsonArray(list.stdout) : undefined
  const view: View = {
    listRaw: list.stdout,
    listCode: list.code,
    items,
    overdueRaw: '',
    statsRaw: '',
    readyRaw: '',
    readyItems: undefined,
  }
  if (needsOverdueStats(property)) {
    const overdue = await exec(r, ['overdue', '--today', TODAY])
    const stats = await exec(r, ['stats'])
    view.overdueRaw = overdue.stdout
    view.statsRaw = stats.stdout
  }
  if (needsReady(property)) {
    const ready = await exec(r, ['list', '--json', '--ready'])
    view.readyRaw = ready.stdout
    view.readyItems = ready.code === 0 ? parseJsonArray(ready.stdout) : undefined
  }
  return view
}

function fail(property: PropertyId, args: readonly string[], ran: readonly string[], detail: string): never {
  throw new Error(`${property}: ${detail}\ncommand: ${args.join(' ')}\nexecuted:\n${ran.map(c => `  ${c}`).join('\n')}`)
}

function checkUnique(property: PropertyId, args: readonly string[], ran: readonly string[], view: View): void {
  const items = view.items
  if (items === undefined) {
    fail(property, args, ran, `list --json is not a JSON array (exit ${view.listCode}): ${trimLines(view.listRaw)}`)
  }
  const ids: number[] = []
  for (const item of items) {
    const id = idOf(item)
    if (id === undefined) {
      fail(property, args, ran, `task is missing a unique positive integer id: ${JSON.stringify(item)}`)
    }
    ids.push(id)
  }
  if (new Set(ids).size !== ids.length) {
    fail(property, args, ran, `duplicate ids ${ids.join(',')}`)
  }
}

function checkCycle(property: PropertyId, args: readonly string[], ran: readonly string[], view: View): void {
  const items = view.items
  if (items === undefined) {
    fail(property, args, ran, `list --json is not a JSON array (exit ${view.listCode}): ${trimLines(view.listRaw)}`)
  }
  for (const item of items) {
    if (blockedOnOf(item) === undefined) {
      fail(property, args, ran, `blockedOn is not an id array: ${JSON.stringify(item)}`)
    }
  }
  if (hasCycle(items)) fail(property, args, ran, `blockedOn cycle in ${JSON.stringify(items)}`)
}

function checkReady(property: PropertyId, args: readonly string[], ran: readonly string[], view: View): void {
  const items = view.items
  const readyItems = view.readyItems
  if (items === undefined) {
    fail(property, args, ran, `list --json is not a JSON array (exit ${view.listCode}): ${trimLines(view.listRaw)}`)
  }
  if (readyItems === undefined) {
    fail(property, args, ran, `list --json --ready is not a JSON array: ${trimLines(view.readyRaw)}`)
  }
  const expected = items.filter(t => statusOf(t) === 'open' && !isOpenBlocked(items, t))
  if (!isDeepStrictEqual(readyItems, expected)) {
    fail(
      property,
      args,
      ran,
      `ready !== open unblocked from list --json\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(readyItems)}`,
    )
  }
}

function checkDone(
  property: PropertyId,
  args: readonly string[],
  ran: readonly string[],
  cap: Capture,
  before: View,
  after: View,
): void {
  const idRaw = args[1]
  if (idRaw === undefined || before.items === undefined || after.items === undefined) return
  const id = Number(idRaw)
  const task = before.items.find(t => idOf(t) === id)
  if (task === undefined) return
  const blocked = statusOf(task) === 'open' && isOpenBlocked(before.items, task)
  if (blocked) {
    if (cap.code !== 1 || trimLines(cap.stdout) !== 'blocked') {
      fail(
        property,
        args,
        ran,
        `open blocked done: want exit 1 stdout blocked, got exit ${cap.code} ${JSON.stringify(trimLines(cap.stdout))}`,
      )
    }
    if (!sameObs(before, after)) {
      fail(
        property,
        args,
        ran,
        `open blocked done changed observables\nexpected: ${fmtObs(before)}\nactual: ${fmtObs(after)}`,
      )
    }
    return
  }
  if (statusOf(task) === 'open' && everyOf(task) !== undefined) {
    const beforeIds = new Set(before.items.map(idOf).filter((x): x is number => x !== undefined))
    const newOpen = after.items.filter(t => {
      if (statusOf(t) !== 'open') return false
      const newId = idOf(t)
      return newId !== undefined && !beforeIds.has(newId)
    })
    if (newOpen.length !== 1) {
      fail(property, args, ran, `recurring unblocked done must add exactly one new open task, added ${newOpen.length}`)
    }
  }
}

function isMutating(args: readonly string[]): boolean {
  const cmd = args[0]
  return cmd === 'add' || cmd === 'done' || cmd === 'block'
}

async function readStoreFile(cwd: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, 'tasks.json'), 'utf8')
  } catch {
    return undefined
  }
}

async function restoreStoreFile(cwd: string, snap: string | undefined): Promise<void> {
  const path = join(cwd, 'tasks.json')
  if (snap === undefined) await rm(path, { force: true })
  else await writeFile(path, snap)
}

async function checkFailUndo(
  property: PropertyId,
  m: Model,
  r: Real,
  args: readonly string[],
  before: View,
  after: View,
): Promise<void> {
  if (!sameObs(before, after)) {
    fail(
      property,
      args,
      r.ran,
      `failing command changed observables\nexpected: ${fmtObs(before)}\nactual: ${fmtObs(after)}`,
    )
  }
  const expected = m.undoStack[m.undoStack.length - 1]
  if (expected === undefined) return
  const snap = await readStoreFile(r.cwd)
  const undoCap = await exec(r, ['undo'])
  const afterUndo = await observe(property, r)
  await restoreStoreFile(r.cwd, snap)
  if (undoCap.code === 0 && !sameObs(afterUndo, expected)) {
    r.ran.push('undo')
    fail(
      property,
      ['undo'],
      r.ran,
      `undo after a failing command did not reverse the previous success\nexpected: ${fmtObs(expected)}\nactual: ${fmtObs(afterUndo)}`,
    )
  }
}

async function step(property: PropertyId, m: Model, r: Real, args: readonly string[]): Promise<void> {
  r.ran.push(args.join(' '))
  const before = await observe(property, r)
  const cap = await exec(r, args)
  const after = await observe(property, r)
  const ran = r.ran
  if (property === 'unique-ids') checkUnique(property, args, ran, after)
  if (property === 'no-cycle') checkCycle(property, args, ran, after)
  if (property === 'ready-matches-json') checkReady(property, args, ran, after)
  if (property === 'done-blocked-or-recurring' && args[0] === 'done') {
    checkDone(property, args, ran, cap, before, after)
  }
  if (property === 'fail-is-noop' && cap.code !== 0) {
    await checkFailUndo(property, m, r, args, before, after)
  }
  if (args[0] === 'undo' && cap.code === 0 && (property === 'undo-restores' || property === 'fail-is-noop')) {
    const expected = m.undoStack.pop()
    if (expected === undefined) {
      fail(property, args, ran, 'undo succeeded but no successful add, done, or block was recorded')
    }
    if (!sameObs(after, expected)) {
      fail(
        property,
        args,
        ran,
        `undo did not restore the previous observables\nexpected: ${fmtObs(expected)}\nactual: ${fmtObs(after)}`,
      )
    }
    return
  }
  if (isMutating(args) && cap.code === 0) m.undoStack.push(before)
}

function cmd(property: PropertyId, args: readonly string[]): fc.AsyncCommand<Model, Real> {
  return {
    check: () => true,
    run: async (m, r) => step(property, m, r, args),
    toString: () => args.join(' '),
  }
}

function prefixCommands(property: PropertyId): fc.AsyncCommand<Model, Real>[] {
  const addA = cmd(property, ['add', 'a', '--today', TODAY])
  if (property === 'unique-ids') return [addA]
  return [addA, cmd(property, ['add', 'b', '--today', TODAY]), cmd(property, ['add', 'c', '--today', TODAY])]
}

function multi(property: PropertyId, steps: readonly (readonly string[])[]): fc.AsyncCommand<Model, Real> {
  return {
    check: () => true,
    run: async (m, r) => {
      for (const args of steps) await step(property, m, r, args)
    },
    toString: () => steps.map(a => a.join(' ')).join(' ; '),
  }
}

function commandArbs(property: PropertyId): fc.Arbitrary<fc.AsyncCommand<Model, Real>>[] {
  const addArb = fc
    .record({
      title: fc.constantFrom('a', 'b', 'c', 'milk'),
      tag: fc.option(fc.constantFrom('work', 'home'), { nil: undefined }),
      priority: fc.constantFrom(-1, 0, 2),
      due: fc.constantFrom('2024-01-31', '2024-02-27', '+1d', '+2w'),
      every: fc.option(fc.constantFrom('week', 'month'), { nil: undefined }),
    })
    .map(o => {
      const args = ['add', o.title]
      if (o.tag !== undefined) args.push('--tag', o.tag)
      args.push('--priority', String(o.priority), '--due', o.due)
      if (o.every !== undefined) args.push('--every', o.every)
      args.push('--today', TODAY)
      return cmd(property, args)
    })
  const idArb = fc.constantFrom(...ID_POOL)
  const doneArb = idArb.map(id => cmd(property, ['done', String(id)]))
  const blockArb = fc.tuple(idArb, idArb).map(([id, on]) => cmd(property, ['block', String(id), '--on', String(on)]))
  const triangle = fc.constant(
    multi(property, [
      ['block', '1', '--on', '2'],
      ['block', '2', '--on', '3'],
      ['block', '3', '--on', '1'],
    ]),
  )
  const blockedDone = fc.constant(
    multi(property, [
      ['block', '1', '--on', '2'],
      ['done', '1'],
    ]),
  )
  return [
    fc.constant(cmd(property, ['add', 'a', '--today', TODAY])),
    addArb,
    fc.constant(cmd(property, ['undo'])),
    fc.constant(cmd(property, ['block', '1', '--on', '1'])),
    fc.constant(cmd(property, ['done', '1'])),
    fc.constant(cmd(property, ['block', '1', '--on', '2'])),
    triangle,
    blockedDone,
    doneArb,
    blockArb,
    fc.constant(cmd(property, ['add'])),
  ]
}

function commandsFromIterable(v: unknown): string[] {
  if (v === null || v === undefined || typeof v !== 'object') return []
  try {
    return [...(v as Iterable<unknown>)].map(c => String(c))
  } catch {
    return []
  }
}

function commandsFromExecuted(detail: string): string[] {
  const marker = '\nexecuted:\n'
  const idx = detail.indexOf(marker)
  if (idx < 0) return []
  const lines: string[] = []
  for (const line of detail.slice(idx + marker.length).split('\n')) {
    if (!line.startsWith('  ')) break
    lines.push(line.slice(2))
  }
  return lines
}

function commandsFromDetail(detail: string): string[] {
  const line = detail.split('\n').find(l => l.startsWith('Counterexample: '))
  if (line === undefined) return []
  const inner = line.slice('Counterexample: '.length).trim()
  if (!inner.startsWith('[') || !inner.endsWith(']')) return []
  const body = inner.slice(1, -1)
  if (body === '') return []
  return body.split(',').map(s => s.trim()).filter(s => s.length > 0)
}

export async function checkProperty(cli: string, property: PropertyId, bounds: Bounds): Promise<CheckResult> {
  try {
    await access(cli)
  } catch {
    return { ok: false, property, seed: bounds.seed, numRuns: bounds.numRuns, commands: [], detail: `missing ${cli}` }
  }
  const prefix = prefixCommands(property)
  const out = await fc.check(
    fc.asyncProperty(
      fc.commands(commandArbs(property), {
        maxCommands: bounds.maxCommands,
        size: 'max',
        disableReplayLog: true,
      }),
      async cmds => {
        const cwd = await mkdtemp(join(tmpdir(), 'tasks-prop-'))
        try {
          await fc.asyncModelRun(
            () => ({ model: { undoStack: [] }, real: { cli, cwd, ran: [] } }),
            [...prefix, ...cmds],
          )
        } finally {
          await rm(cwd, { recursive: true, force: true })
        }
      },
    ),
    { seed: bounds.seed, numRuns: bounds.numRuns },
  )
  if (!out.failed) {
    return { ok: true, property, seed: bounds.seed, numRuns: bounds.numRuns, commands: [], detail: '' }
  }
  const err = out.errorInstance
  const detail = err instanceof Error ? err.message : String(err)
  const executed = commandsFromExecuted(detail)
  const ce = out.counterexample
  const first = Array.isArray(ce) ? ce[0] : undefined
  const shrunk = commandsFromIterable(first)
  const fallback = [...prefix.map(c => c.toString()), ...shrunk]
  const fromLine = commandsFromDetail(detail)
  const commands = executed.length > 0 ? executed : fallback.length > 0 ? fallback : fromLine
  return { ok: false, property, seed: bounds.seed, numRuns: bounds.numRuns, commands, detail }
}
