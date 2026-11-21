import { useQuery } from '@tanstack/react-query'
import { parseAvailability } from './parse'
import { useDebouncedValue } from './use-debounced-value'

async function fetchAvailability(username: string) {
  const res = await fetch(`/api/username?u=${encodeURIComponent(username)}`)
  if (!res.ok) throw new Error('check')
  return parseAvailability(await res.json())
}

export function useUsernameAvailability(username: string) {
  const debounced = useDebouncedValue(username, 300)
  const query = useQuery({
    queryKey: ['username', debounced],
    queryFn: () => fetchAvailability(debounced),
    enabled: debounced.length > 0,
  })
  const waiting = username.length > 0 && (username !== debounced || query.isFetching)
  const taken = !waiting && query.data?.available === 'no'
  const available = !waiting && query.data?.available === 'yes'
  const failed = !waiting && query.isError
  return { waiting, taken, available, failed }
}
