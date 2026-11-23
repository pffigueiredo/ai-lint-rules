import type { ChangeEvent } from 'react'
import { useFavorites, useToggleFavorite } from './lib/use-favorites'
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
  const favorites = useFavorites()
  const toggle = useToggleFavorite()
  const saved = (favorites.data?.ids ?? []).includes(venueId)
  const fail = favorites.data?.errorFor === venueId ? favorites.data.error : 'none'
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
      <button
        type="button"
        onClick={() => toggle.mutate({ id: venueId, next: saved ? 'unsaved' : 'saved' })}
      >
        {saved ? 'Unsave' : 'Save'}
      </button>
      {fail === 'save' ? <div role="alert">Could not save</div> : null}
      {fail === 'unsave' ? <div role="alert">Could not unsave</div> : null}
    </section>
  )
}

export default function App() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const openOnly = params.get('open') === '1'
  const sort = params.get('sort') === 'city' ? 'city' : 'name'
  const venueId = params.get('venue')
  const selected = venueId !== null && venueId.length > 0 ? venueId : undefined
  const venues = useVenues(q)
  const favorites = useFavorites()
  const ids = favorites.data?.ids ?? []
  const rows = visibleVenues(venues.data?.pages.flatMap(p => p.venues) ?? [], openOnly, sort)
  const showLoadMore = venues.hasNextPage === true && venues.isPlaceholderData !== true

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
  function onLoadMore(): void {
    if (venues.isFetchingNextPage) return
    void venues.fetchNextPage()
  }

  if (venues.data === undefined && venues.isPending) {
    return <p>Loading venues</p>
  }

  const listError = venues.isError && venues.isFetchNextPageError !== true

  return (
    <div>
      <header>
        <p>{`Saved: ${ids.length}`}</p>
      </header>
      <label htmlFor="search">Search</label>
      <input id="search" value={q} onChange={onSearch} />
      <label htmlFor="open-now">Open now</label>
      <input id="open-now" type="checkbox" checked={openOnly} onChange={onOpen} />
      <label htmlFor="sort">Sort</label>
      <select id="sort" value={sort} onChange={onSort}>
        <option value="name">Name</option>
        <option value="city">City</option>
      </select>
      {listError ? (
        <div role="alert">Could not load venues</div>
      ) : rows.length === 0 ? (
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
      {listError ? null : showLoadMore ? (
        <button type="button" onClick={onLoadMore}>
          Load more
        </button>
      ) : null}
      {venues.isFetchNextPageError ? <div role="alert">Could not load more</div> : null}
      {selected !== undefined ? <Details venueId={selected} /> : null}
    </div>
  )
}
