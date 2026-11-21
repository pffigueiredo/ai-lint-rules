export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const CODE_RE = /^[A-Z]{3}$/
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export type Posted = {
  kind: 'posted'
  id: string
  account: string
  amount: number
  raw: Record<string, unknown>
  date?: string
  currency?: string
  category?: string
}

export type Template = {
  kind: 'template'
  id: string
  account: string
  amount: number
  raw: Record<string, unknown>
  date: string
  day: number
  currency?: string
  category?: string
}

export type Entry = Posted | Template

export type Rate = {
  date: string
  from: string
  to: string
  rate: number
}

export type Limits = Record<string, number>

export function roundHalfEven(x: number): number {
  const sign = x < 0 ? -1 : 1
  const abs = Math.abs(x)
  const ip = Math.floor(abs)
  const frac = abs - ip
  if (frac < 0.5) return sign * ip
  if (frac > 0.5) return sign * (ip + 1)
  return sign * (ip % 2 === 0 ? ip : ip + 1)
}

export function formatAmount(n: number): string {
  const x = n === 0 ? 0 : n
  if (Number.isInteger(x)) return String(x)
  return x.toFixed(2)
}

export function formatBase(minor: number): string {
  const n = minor === 0 ? 0 : minor
  const neg = n < 0
  const abs = Math.abs(n)
  const ip = Math.trunc(abs / 100)
  const cents = abs % 100
  const body = `${ip}.${String(cents).padStart(2, '0')}`
  return neg ? `-${body}` : body
}

export function majorNumber(minor: number): number {
  const n = minor === 0 ? 0 : minor
  return n / 100
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

export function monthBounds(month: string): { from: string; to: string } | undefined {
  if (!MONTH_RE.test(month)) return undefined
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return { from: `${month}-01`, to: clampYmd(y, m, 31) }
}

export function eachMonth(from: string, to: string): { y: number; m: number }[] {
  const a = dateParts(from)
  const b = dateParts(to)
  if (!Number.isInteger(a.y) || !Number.isInteger(a.m) || !Number.isInteger(b.y) || !Number.isInteger(b.m)) {
    return []
  }
  if (a.m < 1 || a.m > 12 || b.m < 1 || b.m > 12) return []
  const out: { y: number; m: number }[] = []
  let y = a.y
  let m = a.m
  for (let n = 0; n < 12_000; n += 1) {
    if (y > b.y || (y === b.y && m > b.m)) break
    out.push({ y, m })
    m += 1
    if (m === 13) {
      m = 1
      y += 1
    }
  }
  return out
}

function setOptional(
  target: { currency?: string; category?: string },
  currency: string | undefined,
  category: string | undefined,
): void {
  if (currency !== undefined) target.currency = currency
  if (category !== undefined) target.category = category
}

function parseMoneyFields(
  v: Record<string, unknown>,
): { currency: string | undefined; category: string | undefined } | undefined {
  const currencyRaw = v['currency']
  let currency: string | undefined
  if (currencyRaw !== undefined) {
    if (typeof currencyRaw !== 'string' || !CODE_RE.test(currencyRaw)) return undefined
    currency = currencyRaw
  }
  const categoryRaw = v['category']
  let category: string | undefined
  if (categoryRaw !== undefined) {
    if (typeof categoryRaw !== 'string' || categoryRaw.length === 0) return undefined
    category = categoryRaw
  }
  return { currency, category }
}

export function parseEntry(v: unknown, seen: Set<string>): Entry | undefined {
  if (!isRecord(v)) return undefined
  const id = v['id']
  const account = v['account']
  const amount = v['amount']
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof account !== 'string' || account.length === 0) return undefined
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return undefined
  if (seen.has(id)) return undefined
  const money = parseMoneyFields(v)
  if (money === undefined) return undefined
  if (money.currency !== undefined && !Number.isInteger(amount)) return undefined
  const dateRaw = v['date']
  let date: string | undefined
  if (dateRaw !== undefined) {
    if (typeof dateRaw !== 'string' || !DATE_RE.test(dateRaw)) return undefined
    date = dateRaw
  }
  const everyRaw = v['every']
  const dayRaw = v['day']
  if (everyRaw !== undefined || dayRaw !== undefined) {
    if (everyRaw !== 'month') return undefined
    if (typeof dayRaw !== 'number' || !Number.isInteger(dayRaw) || dayRaw < 1 || dayRaw > 31) return undefined
    if (date === undefined) return undefined
    seen.add(id)
    const t: Template = {
      kind: 'template',
      id,
      account,
      amount,
      raw: v,
      date,
      day: dayRaw,
    }
    setOptional(t, money.currency, money.category)
    return t
  }
  seen.add(id)
  const p: Posted = { kind: 'posted', id, account, amount, raw: v }
  if (date !== undefined) p.date = date
  setOptional(p, money.currency, money.category)
  return p
}

export function parseEntries(v: unknown): Entry[] | undefined {
  if (!Array.isArray(v)) return undefined
  const seen = new Set<string>()
  const entries: Entry[] = []
  for (const item of v) {
    const entry = parseEntry(item, seen)
    if (entry === undefined) return undefined
    entries.push(entry)
  }
  return entries
}

export function parseRates(v: unknown): Rate[] | undefined {
  if (!Array.isArray(v)) return undefined
  const seen = new Set<string>()
  const rates: Rate[] = []
  for (const item of v) {
    if (!isRecord(item)) return undefined
    const date = item['date']
    const from = item['from']
    const to = item['to']
    const rate = item['rate']
    if (typeof date !== 'string' || !DATE_RE.test(date)) return undefined
    if (typeof from !== 'string' || !CODE_RE.test(from)) return undefined
    if (typeof to !== 'string' || !CODE_RE.test(to)) return undefined
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return undefined
    const key = `${date}\0${from}\0${to}`
    if (seen.has(key)) return undefined
    seen.add(key)
    rates.push({ date, from, to, rate })
  }
  return rates
}

export function parseLimits(v: unknown): Limits | undefined {
  if (!isRecord(v)) return undefined
  const limits: Limits = {}
  for (const [k, raw] of Object.entries(v)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined
    limits[k] = raw
  }
  return limits
}

type CsvRow = { id: string; account: string; amount: number; date: string }

function parseCsvAmount(s: string): number | undefined {
  if (s.length === 0 || /\s/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n)) return undefined
  return n
}

export function parseCsv(text: string): CsvRow[] | undefined {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const header = lines[0]
  if (header !== 'id,account,amount,date') return undefined
  const rows: CsvRow[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined) return undefined
    const fields = line.split(',')
    if (fields.length !== 4) return undefined
    const id = fields[0]
    const account = fields[1]
    const amountRaw = fields[2]
    const date = fields[3]
    if (id === undefined || account === undefined || amountRaw === undefined || date === undefined) return undefined
    if (id.length === 0 || account.length === 0) return undefined
    const amount = parseCsvAmount(amountRaw)
    if (amount === undefined) return undefined
    if (!DATE_RE.test(date)) return undefined
    rows.push({ id, account, amount, date })
  }
  return rows
}

export function inDateRange(entry: Posted, from: string | undefined, to: string | undefined): boolean {
  const ranged = from !== undefined || to !== undefined
  if (!ranged) return true
  if (entry.date === undefined) return false
  if (from !== undefined && entry.date < from) return false
  if (to !== undefined && entry.date > to) return false
  return true
}

function virtualPosted(t: Template, date: string): Posted {
  const p: Posted = {
    kind: 'posted',
    id: t.id,
    account: t.account,
    amount: t.amount,
    raw: t.raw,
    date,
  }
  setOptional(p, t.currency, t.category)
  return p
}

export function expandTemplate(t: Template, from: string, to: string): Posted[] {
  const out: Posted[] = []
  for (const { y, m } of eachMonth(from, to)) {
    const occ = clampYmd(y, m, t.day)
    if (occ < from || occ > to || occ < t.date) continue
    out.push(virtualPosted(t, occ))
  }
  return out
}

export function selectPosted(
  entries: Entry[],
  from: string | undefined,
  to: string | undefined,
): Posted[] {
  const both = from !== undefined && to !== undefined
  const out: Posted[] = []
  for (const e of entries) {
    if (e.kind === 'template') {
      if (!both || from === undefined || to === undefined) continue
      out.push(...expandTemplate(e, from, to))
      continue
    }
    if (!inDateRange(e, from, to)) continue
    out.push(e)
  }
  return out
}

export function selectMonth(entries: Entry[], month: string): Posted[] {
  const bounds = monthBounds(month)
  const out: Posted[] = []
  for (const e of entries) {
    if (e.kind === 'template') {
      if (bounds === undefined) continue
      out.push(...expandTemplate(e, bounds.from, bounds.to))
      continue
    }
    if (e.date === undefined) continue
    if (!e.date.startsWith(month)) continue
    out.push(e)
  }
  return out
}

export function findRate(rates: Rate[], from: string, to: string, date: string): number | undefined {
  let bestDate: string | undefined
  let bestRate: number | undefined
  for (const r of rates) {
    if (r.from !== from || r.to !== to) continue
    if (r.date > date) continue
    if (bestDate === undefined || r.date > bestDate) {
      bestDate = r.date
      bestRate = r.rate
    }
  }
  return bestRate
}

export function toBaseMinor(entry: Posted, base: string, rates: Rate[]): number | undefined {
  const currency = entry.currency
  if (currency === undefined) return roundHalfEven(entry.amount * 100)
  if (currency === base) return entry.amount
  if (entry.date === undefined) return undefined
  const rate = findRate(rates, currency, base, entry.date)
  if (rate === undefined) return undefined
  return roundHalfEven(entry.amount * rate)
}

export function sumRaw(entries: Posted[], account: string | undefined): Map<string, number> {
  const sums = new Map<string, number>()
  for (const entry of entries) {
    if (account !== undefined && entry.account !== account) continue
    sums.set(entry.account, (sums.get(entry.account) ?? 0) + entry.amount)
  }
  return sums
}

export function sumBase(
  entries: Posted[],
  account: string | undefined,
  base: string,
  rates: Rate[],
): Map<string, number> | undefined {
  const sums = new Map<string, number>()
  for (const entry of entries) {
    if (account !== undefined && entry.account !== account) continue
    const minor = toBaseMinor(entry, base, rates)
    if (minor === undefined) return undefined
    sums.set(entry.account, (sums.get(entry.account) ?? 0) + minor)
  }
  return sums
}

export function spendByCategory(entries: Posted[]): Map<string, number> {
  const spent = new Map<string, number>()
  for (const entry of entries) {
    const cat = entry.category
    if (cat === undefined) continue
    if (entry.amount >= 0) continue
    spent.set(cat, (spent.get(cat) ?? 0) + -entry.amount)
  }
  return spent
}

export function spendByCategoryBase(entries: Posted[], base: string, rates: Rate[]): Map<string, number> | undefined {
  const spent = new Map<string, number>()
  for (const entry of entries) {
    const cat = entry.category
    if (cat === undefined) continue
    const minor = toBaseMinor(entry, base, rates)
    if (minor === undefined) return undefined
    if (minor >= 0) continue
    spent.set(cat, (spent.get(cat) ?? 0) + -minor)
  }
  return spent
}

export function budgetPayload(
  month: string,
  limits: Limits,
  spent: Map<string, number>,
  scale: number,
): { month: string; categories: Record<string, { spent: number; limit: number; ok: boolean }> } {
  const names = Object.keys(limits).sort()
  const categories: Record<string, { spent: number; limit: number; ok: boolean }> = {}
  for (const name of names) {
    const limit = limits[name]
    if (limit === undefined) continue
    const raw = spent.get(name) ?? 0
    const value = raw / scale
    categories[name] = { spent: value, limit, ok: value <= limit }
  }
  return { month, categories }
}
