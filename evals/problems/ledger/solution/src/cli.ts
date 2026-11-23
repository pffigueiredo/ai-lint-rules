import { access, readFile, writeFile } from 'node:fs/promises'
import {
  CODE_RE,
  type Entry,
  type Limits,
  type Rate,
  budgetPayload,
  formatAmount,
  formatBase,
  majorNumber,
  parseCsv,
  parseEntries,
  parseLimits,
  parseRates,
  selectMonth,
  selectPosted,
  spendByCategory,
  spendByCategoryBase,
  sumBase,
  sumRaw,
} from './lib.ts'

function writeOut(text: string): void {
  process.stdout.write(text)
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

const VALUE_FLAGS = new Set(['--account', '--from', '--to', '--month', '--base', '--rates', '--limits'])

type LoadOk<T> = { ok: true; value: T }
type LoadErr = { ok: false; code: number }

async function readExisting(path: string): Promise<LoadOk<string> | LoadErr> {
  try {
    await access(path)
  } catch {
    return { ok: false, code: 1 }
  }
  try {
    return { ok: true, value: await readFile(path, 'utf8') }
  } catch {
    return { ok: false, code: 1 }
  }
}

function parseJson(text: string): { ok: true; value: unknown } | LoadErr {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, code: 2 }
  }
}

async function loadLedger(path: string): Promise<LoadOk<Entry[]> | LoadErr> {
  const text = await readExisting(path)
  if (!text.ok) return text
  const json = parseJson(text.value)
  if (!json.ok) return json
  const entries = parseEntries(json.value)
  if (entries === undefined) return { ok: false, code: 3 }
  return { ok: true, value: entries }
}

async function loadRates(path: string): Promise<LoadOk<Rate[]> | LoadErr> {
  const text = await readExisting(path)
  if (!text.ok) return text
  const json = parseJson(text.value)
  if (!json.ok) return json
  const rates = parseRates(json.value)
  if (rates === undefined) return { ok: false, code: 3 }
  return { ok: true, value: rates }
}

async function loadLimits(path: string): Promise<LoadOk<Limits> | LoadErr> {
  const text = await readExisting(path)
  if (!text.ok) return text
  const json = parseJson(text.value)
  if (!json.ok) return json
  const limits = parseLimits(json.value)
  if (limits === undefined) return { ok: false, code: 4 }
  return { ok: true, value: limits }
}

type BasePair = { base: string; ratesPath: string }

function parseBaseFlags(args: string[], usage: string): { ok: true; pair: BasePair | undefined } | { ok: false } {
  const hasBase = flagPresent(args, '--base')
  const hasRates = flagPresent(args, '--rates')
  const base = flagValues(args, '--base')[0]
  const ratesPath = flagValues(args, '--rates')[0]
  if (!hasBase && !hasRates) return { ok: true, pair: undefined }
  if (!hasBase || !hasRates || base === undefined || ratesPath === undefined || !CODE_RE.test(base)) {
    writeOut(usage)
    return { ok: false }
  }
  return { ok: true, pair: { base, ratesPath } }
}

function printRawBalances(sums: Map<string, number>, account: string | undefined): void {
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

function printBaseBalances(sums: Map<string, number>, account: string | undefined): void {
  if (account !== undefined) {
    writeOut(`${account} ${formatBase(sums.get(account) ?? 0)}\n`)
    return
  }
  const names = [...sums.keys()].sort()
  if (names.length === 0) {
    writeOut('0 accounts\n')
    return
  }
  for (const name of names) {
    writeOut(`${name} ${formatBase(sums.get(name) ?? 0)}\n`)
  }
}

function reportObject(month: string, sums: Map<string, number>, toJson: (n: number) => number): unknown {
  const names = [...sums.keys()].sort()
  const accounts: Record<string, number> = {}
  let total = 0
  for (const name of names) {
    const n = sums.get(name)
    if (n === undefined) continue
    const v = toJson(n)
    accounts[name] = v
    total += v
  }
  return { month, accounts, total }
}

function cmdBalances(entries: Entry[], args: string[], pair: BasePair | undefined, rates: Rate[] | undefined): number {
  const account = flagValues(args, '--account')[0]
  const from = flagValues(args, '--from')[0]
  const to = flagValues(args, '--to')[0]
  const posted = selectPosted(entries, from, to)
  if (pair === undefined) {
    printRawBalances(sumRaw(posted, account), account)
    return 0
  }
  if (rates === undefined) return 1
  const sums = sumBase(posted, account, pair.base, rates)
  if (sums === undefined) return 6
  printBaseBalances(sums, account)
  return 0
}

function cmdReport(
  entries: Entry[],
  month: string,
  pair: BasePair | undefined,
  rates: Rate[] | undefined,
): number {
  const posted = selectMonth(entries, month)
  if (pair === undefined) {
    writeOut(`${JSON.stringify(reportObject(month, sumRaw(posted, undefined), n => n))}\n`)
    return 0
  }
  if (rates === undefined) return 1
  const sums = sumBase(posted, undefined, pair.base, rates)
  if (sums === undefined) return 6
  writeOut(`${JSON.stringify(reportObject(month, sums, majorNumber))}\n`)
  return 0
}

function cmdBudget(
  entries: Entry[],
  month: string,
  limits: Limits,
  pair: BasePair | undefined,
  rates: Rate[] | undefined,
): number {
  const posted = selectMonth(entries, month)
  if (pair === undefined) {
    writeOut(`${JSON.stringify(budgetPayload(month, limits, spendByCategory(posted), 1))}\n`)
    return 0
  }
  if (rates === undefined) return 1
  const spent = spendByCategoryBase(posted, pair.base, rates)
  if (spent === undefined) return 6
  writeOut(`${JSON.stringify(budgetPayload(month, limits, spent, 100))}\n`)
  return 0
}

async function cmdImport(ledgerPath: string, rowsPath: string): Promise<number> {
  const loaded = await loadLedger(ledgerPath)
  if (!loaded.ok) return loaded.code
  const csvText = await readExisting(rowsPath)
  if (!csvText.ok) return csvText.code
  const rows = parseCsv(csvText.value)
  if (rows === undefined) return 4
  const ids = new Set(loaded.value.map(e => e.id))
  const next: unknown[] = loaded.value.map(e => e.raw)
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

async function loadPair(pair: BasePair | undefined): Promise<LoadOk<Rate[] | undefined> | LoadErr> {
  if (pair === undefined) return { ok: true, value: undefined }
  const rates = await loadRates(pair.ratesPath)
  if (!rates.ok) return rates
  return { ok: true, value: rates.value }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const pos = positional(argv, VALUE_FLAGS)
  const command = pos[0]
  if (command === 'balances') {
    const file = pos[1]
    const parsed = parseBaseFlags(argv, 'usage: balances --base CODE --rates FILE\n')
    if (!parsed.ok) {
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
    const rates = await loadPair(parsed.pair)
    if (!rates.ok) {
      process.exitCode = rates.code
      return
    }
    process.exitCode = cmdBalances(loaded.value, argv, parsed.pair, rates.value)
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
    const parsed = parseBaseFlags(argv, 'usage: report --base CODE --rates FILE\n')
    if (!parsed.ok) {
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
    const rates = await loadPair(parsed.pair)
    if (!rates.ok) {
      process.exitCode = rates.code
      return
    }
    process.exitCode = cmdReport(loaded.value, month, parsed.pair, rates.value)
    return
  }
  if (command === 'budget') {
    const file = pos[1]
    const month = flagValues(argv, '--month')[0]
    const limitsPath = flagValues(argv, '--limits')[0]
    if (month === undefined || limitsPath === undefined || !flagPresent(argv, '--month') || !flagPresent(argv, '--limits')) {
      writeOut('usage: budget --month YYYY-MM --limits FILE\n')
      process.exitCode = 5
      return
    }
    const parsed = parseBaseFlags(argv, 'usage: budget --base CODE --rates FILE\n')
    if (!parsed.ok) {
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
    const limits = await loadLimits(limitsPath)
    if (!limits.ok) {
      process.exitCode = limits.code
      return
    }
    const rates = await loadPair(parsed.pair)
    if (!rates.ok) {
      process.exitCode = rates.code
      return
    }
    process.exitCode = cmdBudget(loaded.value, month, limits.value, parsed.pair, rates.value)
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
