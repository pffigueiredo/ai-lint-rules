import { useQuery } from '@tanstack/react-query'
import { parseVenueDetails } from './parse'

async function fetchVenue(id: string) {
  const res = await fetch(`/api/venues/${id}`)
  if (!res.ok) throw new Error('load')
  return parseVenueDetails(await res.json())
}

export function useVenue(id: string | undefined) {
  return useQuery({
    queryKey: ['venue', id],
    queryFn: () => fetchVenue(id ?? ''),
    enabled: id !== undefined && id.length > 0,
  })
}
