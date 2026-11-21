import { access, readFile, writeFile } from 'node:fs/promises'
import {
  type Store,
  type Task,
  cloneTasks,
  formatLine,
  isBlocked,
  jsonTask,
  nextId,
  parseAdd,
  parseBlock,
  parseList,
  parseOverdue,
  parseStore,
  sortList,
  sortOverdue,
  spawnFrom,
  wouldCycle,
} from './lib.ts'

const FILE = 'tasks.json'
const USAGE = 'usage: add|list|done|undo|stats\n'
const OVERDUE_USAGE = 'usage: overdue --today YYYY-MM-DD\n'
const BLOCK_USAGE = 'usage: block ID --on ID\n'

function writeOut(text: string): void {
  process.stdout.write(text)
}

async function loadStore(): Promise<{ ok: true; store: Store } | { ok: false; code: number }> {
  try {
    await access(FILE)
  } catch {
    return { ok: true, store: { tasks: [], history: [] } }
  }
  let text: string
  try {
    text = await readFile(FILE, 'utf8')
  } catch {
    return { ok: false, code: 2 }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, code: 2 }
  }
  const store = parseStore(parsed)
  if (store === undefined) return { ok: false, code: 3 }
  return { ok: true, store }
}

async function saveStore(store: Store): Promise<void> {
  await writeFile(FILE, `${JSON.stringify(store, null, 2)}\n`)
}

function printList(tasks: Task[], json: boolean): void {
  if (json) {
    writeOut(`${JSON.stringify(tasks.map(jsonTask))}\n`)
    return
  }
  if (tasks.length === 0) {
    writeOut('0 tasks\n')
    return
  }
  writeOut(`${tasks.map(formatLine).join('\n')}\n`)
}

function makeTask(
  id: number,
  parsed: { title: string; tags: string[]; priority: number; due: string | undefined; every: Task['every']; dueDay: number | undefined },
): Task {
  const task: Task = {
    id,
    title: parsed.title,
    status: 'open',
    priority: parsed.priority,
    tags: parsed.tags,
    blockedOn: [],
  }
  if (parsed.due !== undefined) task.due = parsed.due
  if (parsed.every !== undefined) task.every = parsed.every
  if (parsed.dueDay !== undefined) task.dueDay = parsed.dueDay
  return task
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const rest = argv.slice(1)
  if (command === 'add') {
    const parsed = parseAdd(rest)
    if (parsed === undefined) {
      process.exitCode = 1
      return
    }
    const loaded = await loadStore()
    if (!loaded.ok) {
      process.exitCode = loaded.code
      return
    }
    const { store } = loaded
    store.history.push(cloneTasks(store.tasks))
    const id = nextId(store.tasks)
    store.tasks.push(makeTask(id, parsed))
    await saveStore(store)
    writeOut(`added ${id}\n`)
    return
  }
  if (command === 'list') {
    const parsed = parseList(rest)
    if (parsed === undefined) {
      process.exitCode = 1
      return
    }
    const loaded = await loadStore()
    if (!loaded.ok) {
      process.exitCode = loaded.code
      return
    }
    let tasks = loaded.store.tasks
    const tag = parsed.tag
    if (tag !== undefined) tasks = tasks.filter(t => t.tags.includes(tag))
    if (parsed.ready) tasks = tasks.filter(t => t.status === 'open' && !isBlocked(loaded.store.tasks, t))
    printList(sortList(tasks), parsed.json)
    return
  }
  if (command === 'done') {
    const idRaw = rest[0]
    if (idRaw === undefined || !/^\d+$/.test(idRaw)) {
      process.exitCode = 1
      return
    }
    const id = Number(idRaw)
    const loaded = await loadStore()
    if (!loaded.ok) {
      process.exitCode = loaded.code
      return
    }
    const { store } = loaded
    const task = store.tasks.find(t => t.id === id)
    if (task === undefined) {
      process.exitCode = 1
      return
    }
    if (task.status === 'open' && isBlocked(store.tasks, task)) {
      writeOut('blocked\n')
      process.exitCode = 1
      return
    }
    store.history.push(cloneTasks(store.tasks))
    const wasOpen = task.status === 'open'
    task.status = 'done'
    if (wasOpen) {
      const spawned = spawnFrom(task, nextId(store.tasks))
      if (spawned !== undefined) {
        store.tasks.push(spawned)
        await saveStore(store)
        writeOut(`done ${id}\nadded ${spawned.id}\n`)
        return
      }
    }
    await saveStore(store)
    writeOut(`done ${id}\n`)
    return
  }
  if (command === 'undo') {
    const loaded = await loadStore()
    if (!loaded.ok) {
      process.exitCode = loaded.code
      return
    }
    const { store } = loaded
    const prev = store.history.pop()
    if (prev === undefined) {
      writeOut('nothing to undo\n')
      process.exitCode = 1
      return
    }
    store.tasks = prev
    await saveStore(store)
    writeOut('undone\n')
    return
  }
  if (command === 'stats') {
    const loaded = await loadStore()
    if (!loaded.ok) {
      process.exitCode = loaded.code
      return
    }
    let open = 0
    let done = 0
    for (const t of loaded.store.tasks) {
      if (t.status === 'open') open += 1
      else done += 1
    }
    writeOut(`open ${open}\ndone ${done}\n`)
    return
  }
  if (command === 'overdue') {
    const parsed = parseOverdue(rest)
    if (typeof parsed !== 'string') {
      writeOut(OVERDUE_USAGE)
      process.exitCode = 5
      return
    }
    const loaded = await loadStore()
    if (!loaded.ok) {
      process.exitCode = loaded.code
      return
    }
    const tasks = sortOverdue(
      loaded.store.tasks.filter(t => t.status === 'open' && t.due !== undefined && t.due < parsed),
    )
    printList(tasks, false)
    return
  }
  if (command === 'block') {
    const parsed = parseBlock(rest)
    if ('usage' in parsed) {
      writeOut(BLOCK_USAGE)
      process.exitCode = 5
      return
    }
    const loaded = await loadStore()
    if (!loaded.ok) {
      process.exitCode = loaded.code
      return
    }
    const { store } = loaded
    const task = store.tasks.find(t => t.id === parsed.id)
    const on = store.tasks.find(t => t.id === parsed.on)
    if (task === undefined || on === undefined) {
      process.exitCode = 1
      return
    }
    if (wouldCycle(store.tasks, parsed.id, parsed.on)) {
      writeOut('cycle\n')
      process.exitCode = 4
      return
    }
    store.history.push(cloneTasks(store.tasks))
    if (!task.blockedOn.includes(parsed.on)) task.blockedOn.push(parsed.on)
    await saveStore(store)
    writeOut(`blocked ${parsed.id} on ${parsed.on}\n`)
    return
  }
  writeOut(USAGE)
  process.exitCode = 5
}

await main()
