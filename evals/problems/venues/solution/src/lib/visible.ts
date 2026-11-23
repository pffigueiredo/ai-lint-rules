import type { Venue } from './parse'

export function visibleVenues(venues: Venue[], openOnly: boolean, sort: 'name' | 'city'): Venue[] {
  const rows = openOnly ? venues.filter(v => v.open) : venues.slice()
  return rows.sort((a, b) => {
    const av = sort === 'name' ? a.name : a.city
    const bv = sort === 'name' ? b.name : b.city
    if (av < bv) return -1
    if (av > bv) return 1
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })
}
