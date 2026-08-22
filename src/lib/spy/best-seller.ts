export function rankDelta(rank: number, prevRank: number | null | undefined): number | null {
  if (prevRank == null) return null
  return prevRank - rank
}
