import { access, readFile, writeFile } from 'node:fs/promises'

type Entry = {
  id: string
  account: string
  amount: number
  date?: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseEntry(v: unknown, seen: Set<string>): Entry | undefined {
  if (!isRecord(v)) return undefined
  const id = v['id']
  const account = v['account']
  const amount = v['amount']
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof account !== 'string' || account.length === 0) return undefined
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return undefined
  if (seen.has(id)) return undefined
  seen.add(id)
  const date = v['date']
  if (date === undefined) return { id, account, amount }
  if (typeof date !== 'string') return undefined
  return { id, account, amount, date }
}

function parseEntries(v: unknown): Entry[] | undefined {
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

function writeOut(text: string): void {
  process.stdout.write(text)
}

function formatAmount(n: number): string {
  const x = n === 0 ? 0 : n
  if (Number.isInteger(x)) return String(x)
  return x.toFixed(2)
}

function flagValues(args: string[], name: string): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) {
      const next = args[i + 1]
      if (next === undefined) return values
      values.push(next)
      i += 1
    }
  }
  return values
}

function flagPresent(args: string[], name: string): boolean {
  return args.includes(name)
}

function positional(args: string[], flagsWithValue: Set<string>): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === undefined) break
    if (flagsWithValue.has(a)) {
      i += 1
      continue
    }
    if (a.startsWith('--')) continue
    out.push(a)
  }
  return out
}

const VALUE_FLAGS = new Set(['--account', '--from', '--to', '--month'])

type LoadOk = { ok: true; entries: Entry[] }
type LoadErr = { ok: false; code: number }

async function loadLedger(path: string): Promise<LoadOk | LoadErr> {
  try {
    await access(path)
  } catch {
    return { ok: false, code: 1 }
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { ok: false, code: 1 }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, code: 2 }
  }
  const entries = parseEntries(parsed)
  if (entries === undefined) return { ok: false, code: 3 }
  return { ok: true, entries }
}

function inDateRange(entry: Entry, from: string | undefined, to: string | undefined): boolean {
  const ranged = from !== undefined || to !== undefined
  if (!ranged) return true
  if (entry.date === undefined) return false
  if (from !== undefined && entry.date < from) return false
  if (to !== undefined && entry.date > to) return false
  return true
}

function sumsFor(entries: Entry[], account: string | undefined, from: string | undefined, to: string | undefined): Map<string, number> {
  const sums = new Map<string, number>()
  for (const entry of entries) {
    if (account !== undefined && entry.account !== account) continue
    if (!inDateRange(entry, from, to)) continue
    sums.set(entry.account, (sums.get(entry.account) ?? 0) + entry.amount)
  }
  return sums
}

function printBalances(entries: Entry[], args: string[]): void {
  const account = flagValues(args, '--account')[0]
  const from = flagValues(args, '--from')[0]
  const to = flagValues(args, '--to')[0]
  const sums = sumsFor(entries, account, from, to)
  if (account !== undefined) {
    writeOut(`${account} ${formatAmount(sums.get(account) ?? 0)}\n`)
    return
  }
  const names = [...sums.keys()].sort()
  if (names.length === 0) {
    writeOut('0 accounts\n')
    return
  }
  for (const name of names) {
    writeOut(`${name} ${formatAmount(sums.get(name) ?? 0)}\n`)
  }
}

function printReport(entries: Entry[], month: string): void {
  const sums = new Map<string, number>()
  for (const entry of entries) {
    if (entry.date === undefined) continue
    if (!entry.date.startsWith(month)) continue
    sums.set(entry.account, (sums.get(entry.account) ?? 0) + entry.amount)
  }
  const names = [...sums.keys()].sort()
  const accounts: Record<string, number> = {}
  let total = 0
  for (const name of names) {
    const n = sums.get(name)
    if (n === undefined) continue
    accounts[name] = n
    total += n
  }
  writeOut(`${JSON.stringify({ month, accounts, total })}\n`)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseCsvAmount(s: string): number | undefined {
  if (s.length === 0 || /\s/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n)) return undefined
  return n
}

type CsvRow = { id: string; account: string; amount: number; date: string }

function parseCsv(text: string): CsvRow[] | undefined {
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

function stored(entry: Entry): Entry {
  if (entry.date === undefined) return { id: entry.id, account: entry.account, amount: entry.amount }
  return { id: entry.id, account: entry.account, amount: entry.amount, date: entry.date }
}

async function cmdImport(ledgerPath: string, rowsPath: string): Promise<number> {
  const loaded = await loadLedger(ledgerPath)
  if (!loaded.ok) return loaded.code
  let csvText: string
  try {
    await access(rowsPath)
    csvText = await readFile(rowsPath, 'utf8')
  } catch {
    return 1
  }
  const rows = parseCsv(csvText)
  if (rows === undefined) return 4
  const ids = new Set(loaded.entries.map(e => e.id))
  const next = loaded.entries.map(stored)
  let imported = 0
  let skipped = 0
  for (const row of rows) {
    if (ids.has(row.id)) {
      skipped += 1
      continue
    }
    ids.add(row.id)
    next.push({ id: row.id, account: row.account, amount: row.amount, date: row.date })
    imported += 1
  }
  await writeFile(ledgerPath, `${JSON.stringify(next, null, 2)}\n`)
  writeOut(`imported ${imported} skipped ${skipped}\n`)
  return 0
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const pos = positional(argv, VALUE_FLAGS)
  const command = pos[0]
  if (command === 'balances') {
    const file = pos[1]
    if (file === undefined) {
      process.exitCode = 5
      return
    }
    const loaded = await loadLedger(file)
    if (!loaded.ok) {
      process.exitCode = loaded.code
      return
    }
    printBalances(loaded.entries, argv)
    return
  }
  if (command === 'report') {
    const file = pos[1]
    const month = flagValues(argv, '--month')[0]
    if (month === undefined || !flagPresent(argv, '--month')) {
      writeOut('usage: report --month YYYY-MM\n')
      process.exitCode = 5
      return
    }
    if (file === undefined) {
      process.exitCode = 5
      return
    }
    const loaded = await loadLedger(file)
    if (!loaded.ok) {
      process.exitCode = loaded.code
      return
    }
    printReport(loaded.entries, month)
    return
  }
  if (command === 'import') {
    const ledgerPath = pos[1]
    const rowsPath = pos[2]
    if (ledgerPath === undefined || rowsPath === undefined) {
      process.exitCode = 5
      return
    }
    process.exitCode = await cmdImport(ledgerPath, rowsPath)
    return
  }
  process.exitCode = 5
}

await main()
