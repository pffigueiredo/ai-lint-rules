import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { parseVenuePage } from './parse'

async function fetchVenuePage(q: string, page: number) {
  const params = new URLSearchParams()
  params.set('page', String(page))
  if (q !== '') params.set('q', q)
  const res = await fetch(`/api/venues?${params.toString()}`)
  if (!res.ok) throw new Error('load')
  return parseVenuePage(await res.json())
}

export function useVenues(q: string) {
  return useInfiniteQuery({
    queryKey: ['venues', q],
    queryFn: ctx => fetchVenuePage(q, ctx.pageParam),
    initialPageParam: 1,
    getNextPageParam: last => last.nextPage,
    placeholderData: keepPreviousData,
  })
}
