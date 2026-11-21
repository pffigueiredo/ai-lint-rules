/** Gets the user. */
export function getUser(id: string): string {
  console.log('Entering getUser')
  // Step 1: Initialize the list
  const results: string[] = []
  results.push(id)
  console.log('Done.')
  return results[0] ?? ''
}
