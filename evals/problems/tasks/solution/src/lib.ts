export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const REL_DUE_RE = /^\+(\d+)([dw])$/
export const POS_INT_RE = /^[1-9]\d*$/

export type Status = 'open' | 'done'
export type Every = 'week' | 'month'

export type Task = {
  id: number
  title: string
  status: Status
  priority: number
  tags: string[]
  blockedOn: number[]
  due?: string
  every?: Every
  dueDay?: number
}

export type Store = {
  tasks: Task[]
  history: Task[][]
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

export function lastDay(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30
  return 31
}

export function dateParts(iso: string): { y: number; m: number; d: number } {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) }
}

export function clampYmd(year: number, month: number, day: number): string {
  const last = lastDay(year, month)
  const d = day > last ? last : day
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(d)}`
}

export function isRealDate(iso: string): boolean {
  if (!DATE_RE.test(iso)) return false
  const { y, m, d } = dateParts(iso)
  if (m < 1 || m > 12) return false
  if (d < 1 || d > lastDay(y, m)) return false
  return true
}

export function addDays(iso: string, n: number): string {
  const { y, m, d } = dateParts(iso)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

export function nextMonthDue(iso: string, dayN: number): string {
  const p = dateParts(iso)
  let y = p.y
  let m = p.m + 1
  if (m === 13) {
    m = 1
    y += 1
  }
  return clampYmd(y, m, dayN)
}

export function cloneTasks(tasks: Task[]): Task[] {
  return tasks.map(t => {
    const copy: Task = {
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      tags: [...t.tags],
      blockedOn: [...t.blockedOn],
    }
    if (t.due !== undefined) copy.due = t.due
    if (t.every !== undefined) copy.every = t.every
    if (t.dueDay !== undefined) copy.dueDay = t.dueDay
    return copy
  })
}

function parseTags(v: unknown): string[] | undefined {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some(t => typeof t !== 'string')) return undefined
  const tags: string[] = []
  for (const t of v) {
    if (typeof t !== 'string') return undefined
    if (!tags.includes(t)) tags.push(t)
  }
  return tags
}

function parseBlockedOn(v: unknown): number[] | undefined {
  if (v === undefined) return []
  if (!Array.isArray(v)) return undefined
  const ids: number[] = []
  for (const item of v) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1) return undefined
    if (!ids.includes(item)) ids.push(item)
  }
  return ids
}

function parseEvery(v: unknown): Every | undefined | 'bad' {
  if (v === undefined) return undefined
  if (v === 'week' || v === 'month') return v
  return 'bad'
}

export function parseTask(v: unknown, seen: Set<number>): Task | undefined {
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
  const tags = parseTags(v['tags'])
  if (tags === undefined) return undefined
  const blockedOn = parseBlockedOn(v['blockedOn'])
  if (blockedOn === undefined) return undefined
  const dueRaw = v['due']
  let due: string | undefined
  if (dueRaw !== undefined) {
    if (typeof dueRaw !== 'string' || !isRealDate(dueRaw)) return undefined
    due = dueRaw
  }
  const every = parseEvery(v['every'])
  if (every === 'bad') return undefined
  const dueDayRaw = v['dueDay']
  let dueDay: number | undefined
  if (dueDayRaw !== undefined) {
    if (typeof dueDayRaw !== 'number' || !Number.isInteger(dueDayRaw) || dueDayRaw < 1 || dueDayRaw > 31) {
      return undefined
    }
    dueDay = dueDayRaw
  }
  if (every === 'month' && dueDay === undefined && due !== undefined) dueDay = dateParts(due).d
  const task: Task = { id, title, status, priority, tags, blockedOn }
  if (due !== undefined) task.due = due
  if (every !== undefined) task.every = every
  if (dueDay !== undefined) task.dueDay = dueDay
  return task
}

export function parseStore(v: unknown): Store | undefined {
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

export function nextId(tasks: Task[]): number {
  let max = 0
  for (const t of tasks) {
    if (t.id > max) max = t.id
  }
  return max + 1
}

export function sortList(tasks: Task[]): Task[] {
  return tasks.slice().sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    return a.id - b.id
  })
}

export function sortOverdue(tasks: Task[]): Task[] {
  return tasks.slice().sort((a, b) => {
    const da = a.due
    const db = b.due
    if (da !== undefined && db !== undefined && da !== db) return da < db ? -1 : 1
    if (b.priority !== a.priority) return b.priority - a.priority
    return a.id - b.id
  })
}

export function formatLine(t: Task): string {
  return `${t.id} [${t.status}] ${t.title}`
}

export function jsonTask(t: Task): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    tags: t.tags,
  }
  if (t.due !== undefined) o['due'] = t.due
  if (t.every !== undefined) o['every'] = t.every
  if (t.blockedOn.length > 0) o['blockedOn'] = t.blockedOn
  return o
}

export function isBlocked(tasks: Task[], t: Task): boolean {
  const byId = new Map(tasks.map(x => [x.id, x]))
  for (const id of t.blockedOn) {
    const b = byId.get(id)
    if (b !== undefined && b.status === 'open') return true
  }
  return false
}

export function canReach(tasks: Task[], fromId: number, target: number): boolean {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const seen = new Set<number>()
  const stack = [fromId]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined) break
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    const t = byId.get(id)
    if (t === undefined) continue
    for (const b of t.blockedOn) stack.push(b)
  }
  return false
}

export function wouldCycle(tasks: Task[], id: number, on: number): boolean {
  if (id === on) return true
  return canReach(tasks, on, id)
}

export function nextDue(t: Task): string | undefined {
  if (t.due === undefined || t.every === undefined) return undefined
  if (t.every === 'week') return addDays(t.due, 7)
  const n = t.dueDay ?? dateParts(t.due).d
  return nextMonthDue(t.due, n)
}

export function resolveDue(dueRaw: string, today: string | undefined): string | undefined {
  const rel = REL_DUE_RE.exec(dueRaw)
  if (rel !== null) {
    const nRaw = rel[1]
    const unit = rel[2]
    if (nRaw === undefined || unit === undefined) return undefined
    const n = Number(nRaw)
    if (n < 1) return undefined
    if (today === undefined || !isRealDate(today)) return undefined
    const days = unit === 'w' ? n * 7 : n
    return addDays(today, days)
  }
  if (!isRealDate(dueRaw)) return undefined
  return dueRaw
}

export type AddOpts = {
  title: string
  tags: string[]
  priority: number
  due: string | undefined
  every: Every | undefined
  dueDay: number | undefined
}

export function parseAdd(args: string[]): AddOpts | undefined {
  const titleParts: string[] = []
  const tags: string[] = []
  let priority = 0
  let dueRaw: string | undefined
  let today: string | undefined
  let every: Every | undefined
  let sawToday = false
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
    if (a === '--due') {
      const v = args[i + 1]
      if (v === undefined || v.startsWith('--')) return undefined
      dueRaw = v
      i += 1
      continue
    }
    if (a === '--today') {
      const v = args[i + 1]
      if (v === undefined || v.startsWith('--')) return undefined
      today = v
      sawToday = true
      i += 1
      continue
    }
    if (a === '--every') {
      const v = args[i + 1]
      if (v !== 'week' && v !== 'month') return undefined
      every = v
      i += 1
      continue
    }
    titleParts.push(a)
  }
  const title = titleParts.join(' ')
  if (title.length === 0) return undefined
  if (sawToday && (today === undefined || !isRealDate(today))) return undefined
  let due: string | undefined
  if (dueRaw !== undefined) {
    due = resolveDue(dueRaw, today)
    if (due === undefined) return undefined
  }
  if (every !== undefined && due === undefined) return undefined
  let dueDay: number | undefined
  if (every === 'month' && due !== undefined) dueDay = dateParts(due).d
  return { title, tags, priority, due, every, dueDay }
}

export type ListOpts = { json: boolean; tag: string | undefined; ready: boolean }

export function parseList(args: string[]): ListOpts | undefined {
  let json = false
  let tag: string | undefined
  let ready = false
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === undefined) break
    if (a === '--json') {
      json = true
      continue
    }
    if (a === '--ready') {
      ready = true
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
  return { json, tag, ready }
}

export type BlockOpts = { id: number; on: number }

export function parseBlock(args: string[]): BlockOpts | { usage: true } {
  let on: number | undefined
  const pos: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === undefined) break
    if (a === '--on') {
      const v = args[i + 1]
      if (v === undefined || !POS_INT_RE.test(v)) return { usage: true }
      on = Number(v)
      i += 1
      continue
    }
    pos.push(a)
  }
  const idRaw = pos[0]
  if (idRaw === undefined || on === undefined || !POS_INT_RE.test(idRaw) || pos.length !== 1) {
    return { usage: true }
  }
  return { id: Number(idRaw), on }
}

export function parseOverdue(args: string[]): string | { usage: true } {
  let today: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === undefined) break
    if (a === '--today') {
      const v = args[i + 1]
      if (v === undefined) return { usage: true }
      today = v
      i += 1
      continue
    }
    return { usage: true }
  }
  if (today === undefined || !isRealDate(today)) return { usage: true }
  return today
}

export function spawnFrom(t: Task, id: number): Task | undefined {
  const due = nextDue(t)
  if (due === undefined) return undefined
  const next: Task = {
    id,
    title: t.title,
    status: 'open',
    priority: t.priority,
    tags: [...t.tags],
    blockedOn: [],
    due,
  }
  if (t.every !== undefined) next.every = t.every
  if (t.dueDay !== undefined) next.dueDay = t.dueDay
  return next
}
