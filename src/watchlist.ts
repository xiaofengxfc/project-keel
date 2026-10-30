export const WATCHLIST_STORAGE_KEY = 'keel-watchlist'

export function parseWatchlist(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((symbol): symbol is string => typeof symbol === 'string' && /^[A-Z0-9]{3,20}$/.test(symbol)))]
  } catch {
    return []
  }
}

export function reorderWatchlist(symbols: string[], active: string, over: string): string[] {
  const from = symbols.indexOf(active)
  const to = symbols.indexOf(over)
  if (from < 0 || to < 0 || from === to) return symbols
  const reordered = [...symbols]
  reordered.splice(from, 1)
  reordered.splice(to, 0, active)
  return reordered
}
