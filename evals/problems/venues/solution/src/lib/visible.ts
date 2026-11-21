import type { Venue } from './parse'

export function visibleVenues(venues: Venue[], q: string, openOnly: boolean, sort: 'name' | 'city'): Venue[] {
  const needle = q.toLowerCase()
  const rows = venues.filter(v => {
    if (openOnly && !v.open) return false
    if (needle === '') return true
    return v.name.toLowerCase().includes(needle) || v.city.toLowerCase().includes(needle)
  })
  return rows.slice().sort((a, b) => {
    const av = sort === 'name' ? a.name : a.city
    const bv = sort === 'name' ? b.name : b.city
    if (av < bv) return -1
    if (av > bv) return 1
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })
}
