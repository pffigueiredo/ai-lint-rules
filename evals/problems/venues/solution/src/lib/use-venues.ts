import { useQuery } from '@tanstack/react-query'
import { parseVenueList } from './parse'

async function fetchVenues() {
  const res = await fetch('/api/venues')
  if (!res.ok) throw new Error('load')
  return parseVenueList(await res.json())
}

export function useVenues() {
  return useQuery({ queryKey: ['venues'], queryFn: fetchVenues })
}
