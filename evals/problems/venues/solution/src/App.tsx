import type { ChangeEvent } from 'react'
import { useFavorite } from './lib/use-favorite'
import { useSearchParams } from './lib/use-search-params'
import { useVenue } from './lib/use-venue'
import { useVenues } from './lib/use-venues'
import { visibleVenues } from './lib/visible'

function writeParam(params: URLSearchParams, key: string, value: string | null): URLSearchParams {
  const next = new URLSearchParams(params)
  if (value === null || value === '') next.delete(key)
  else next.set(key, value)
  return next
}

function Details({ venueId }: { venueId: string }) {
  const query = useVenue(venueId)
  const save = useFavorite()
  const saved = save.isSuccess && save.variables === venueId
  if (query.isPending) {
    return (
      <section aria-label="Venue details">
        Loading venue
      </section>
    )
  }
  if (query.isError || query.data === undefined) {
    return <div role="alert">Could not load venue</div>
  }
  const venue = query.data
  return (
    <section aria-label="Venue details">
      <h2>{venue.name}</h2>
      <p>{venue.description}</p>
      <p>{venue.hours}</p>
      {saved ? (
        <p>Saved</p>
      ) : (
        <button type="button" onClick={() => save.mutate(venueId)}>
          Save
        </button>
      )}
      {save.isError ? <div role="alert">Could not save</div> : null}
    </section>
  )
}

export default function App() {
  const venues = useVenues()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const openOnly = params.get('open') === '1'
  const sort = params.get('sort') === 'city' ? 'city' : 'name'
  const venueId = params.get('venue')
  const selected = venueId !== null && venueId.length > 0 ? venueId : undefined

  function onSearch(e: ChangeEvent<HTMLInputElement>): void {
    setParams(writeParam(params, 'q', e.target.value))
  }
  function onOpen(e: ChangeEvent<HTMLInputElement>): void {
    setParams(writeParam(params, 'open', e.target.checked ? '1' : null))
  }
  function onSort(e: ChangeEvent<HTMLSelectElement>): void {
    setParams(writeParam(params, 'sort', e.target.value === 'city' ? 'city' : 'name'))
  }
  function onSelect(id: string): void {
    setParams(writeParam(params, 'venue', id))
  }

  if (venues.isPending) return <p>Loading venues</p>
  if (venues.isError) return <div role="alert">Could not load venues</div>
  const rows = visibleVenues(venues.data ?? [], q, openOnly, sort)

  return (
    <div>
      <label htmlFor="search">Search</label>
      <input id="search" value={q} onChange={onSearch} />
      <label htmlFor="open-now">Open now</label>
      <input id="open-now" type="checkbox" checked={openOnly} onChange={onOpen} />
      <label htmlFor="sort">Sort</label>
      <select id="sort" value={sort} onChange={onSort}>
        <option value="name">Name</option>
        <option value="city">City</option>
      </select>
      {rows.length === 0 ? (
        <p>No venues</p>
      ) : (
        <ul>
          {rows.map(v => (
            <li key={v.id}>
              <button type="button" onClick={() => onSelect(v.id)}>
                {v.name}
              </button>
              <span>{v.city}</span>
            </li>
          ))}
        </ul>
      )}
      {selected !== undefined ? <Details venueId={selected} /> : null}
    </div>
  )
}
