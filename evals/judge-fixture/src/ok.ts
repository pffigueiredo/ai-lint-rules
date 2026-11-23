export type Row = { id: string; amount: number }

export function isRow(v: unknown): v is Row {
  if (typeof v !== 'object' || v === null) return false
  if (!('id' in v) || !('amount' in v)) return false
  return typeof v.id === 'string' && typeof v.amount === 'number' && Number.isFinite(v.amount)
}

export function parseRows(raw: string): Row[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('expected array')
  const rows: Row[] = []
  for (const item of parsed) {
    if (!isRow(item)) throw new Error('invalid row')
    rows.push(item)
  }
  return rows
}

export function total(rows: Row[]): number {
  return rows.reduce((sum, row) => sum + row.amount, 0)
}
