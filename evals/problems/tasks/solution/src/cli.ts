import { access, readFile, writeFile } from 'node:fs/promises'

type Status = 'open' | 'done'

type Task = {
  id: number
  title: string
  status: Status
  priority: number
  tags: string[]
}

type Store = {
  tasks: Task[]
  history: Task[][]
}

const FILE = 'tasks.json'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function writeOut(text: string): void {
  process.stdout.write(text)
}

function cloneTasks(tasks: Task[]): Task[] {
  return tasks.map(t => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    tags: [...t.tags],
  }))
}

function parseTask(v: unknown, seen: Set<number>): Task | undefined {
  if (!isRecord(v)) return undefined
  const id = v['id']
  const title = v['title']
  const status = v['status']
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) return undefined
  if (typeof title !== 'string') return undefined
  if (status !== 'open' && status !== 'done') return undefined
  if (seen.has(id)) return undefined
  seen.add(id)
  const priorityRaw = v['priority']
  let priority = 0
  if (priorityRaw !== undefined) {
    if (typeof priorityRaw !== 'number' || !Number.isInteger(priorityRaw)) return undefined
    priority = priorityRaw
  }
  const tagsRaw = v['tags']
  const tags: string[] = []
  if (tagsRaw !== undefined) {
    if (!Array.isArray(tagsRaw) || tagsRaw.some(t => typeof t !== 'string')) return undefined
    for (const t of tagsRaw) {
      if (typeof t !== 'string') return undefined
      if (!tags.includes(t)) tags.push(t)
    }
  }
  return { id, title, status, priority, tags }
}

function parseStore(v: unknown): Store | undefined {
  if (!isRecord(v)) return undefined
  const tasksRaw = v['tasks']
  if (!Array.isArray(tasksRaw)) return undefined
  const seen = new Set<number>()
  const tasks: Task[] = []
  for (const item of tasksRaw) {
    const task = parseTask(item, seen)
    if (task === undefined) return undefined
    tasks.push(task)
  }
  const historyRaw = v['history']
  const history: Task[][] = []
  if (historyRaw !== undefined) {
    if (!Array.isArray(historyRaw)) return undefined
    for (const snap of historyRaw) {
      if (!Array.isArray(snap)) return undefined
      const snapSeen = new Set<number>()
      const cloned: Task[] = []
      for (const item of snap) {
        const task = parseTask(item, snapSeen)
        if (task === undefined) return undefined
        cloned.push(task)
      }
      history.push(cloned)
    }
  }
  return { tasks, history }
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

function nextId(tasks: Task[]): number {
  let max = 0
  for (const t of tasks) {
    if (t.id > max) max = t.id
  }
  return max + 1
}

function sortTasks(tasks: Task[]): Task[] {
  return tasks.slice().sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    return a.id - b.id
  })
}

function formatLine(t: Task): string {
  return `${t.id} [${t.status}] ${t.title}`
}

function parseAdd(args: string[]): { title: string; tags: string[]; priority: number } | undefined {
  const titleParts: string[] = []
  const tags: string[] = []
  let priority = 0
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === undefined) break
    if (a === '--tag') {
      const v = args[i + 1]
      if (v === undefined || v.length === 0 || v.startsWith('--')) return undefined
      if (!tags.includes(v)) tags.push(v)
      i += 1
      continue
    }
    if (a === '--priority') {
      const v = args[i + 1]
      if (v === undefined || !/^-?\d+$/.test(v)) return undefined
      priority = Number(v)
      i += 1
      continue
    }
    titleParts.push(a)
  }
  const title = titleParts.join(' ')
  if (title.length === 0) return undefined
  return { title, tags, priority }
}

function parseList(args: string[]): { json: boolean; tag: string | undefined } | undefined {
  let json = false
  let tag: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === undefined) break
    if (a === '--json') {
      json = true
      continue
    }
    if (a === '--tag') {
      const v = args[i + 1]
      if (v === undefined || v.length === 0 || v.startsWith('--')) return undefined
      tag = v
      i += 1
      continue
    }
    return undefined
  }
  return { json, tag }
}

function printList(tasks: Task[], json: boolean): void {
  if (json) {
    const payload = tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      tags: t.tags,
    }))
    writeOut(`${JSON.stringify(payload)}\n`)
    return
  }
  if (tasks.length === 0) {
    writeOut('0 tasks\n')
    return
  }
  writeOut(`${tasks.map(formatLine).join('\n')}\n`)
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
    store.tasks.push({
      id,
      title: parsed.title,
      status: 'open',
      priority: parsed.priority,
      tags: parsed.tags,
    })
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
    let tasks = sortTasks(loaded.store.tasks)
    const tag = parsed.tag
    if (tag !== undefined) tasks = tasks.filter(t => t.tags.includes(tag))
    printList(tasks, parsed.json)
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
    store.history.push(cloneTasks(store.tasks))
    task.status = 'done'
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
  writeOut('usage: add|list|done|undo|stats\n')
  process.exitCode = 5
}

await main()
