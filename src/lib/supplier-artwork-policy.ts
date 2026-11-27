/** Gỗ 3D accepts approved artwork without a mockup or prescribed template geometry. */
export function acceptsApprovedArtwork(supplier: { code: string } | null | undefined): boolean {
  return supplier?.code === '3'
}
