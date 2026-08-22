export function extractAdMediaUrl(snapshot: any): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const videos = Array.isArray(snapshot.videos) ? snapshot.videos : []
  if (videos[0]?.video_preview_image_url) return videos[0].video_preview_image_url
  const images = Array.isArray(snapshot.images) ? snapshot.images : []
  if (images[0]?.resized_image_url) return images[0].resized_image_url
  if (images[0]?.original_image_url) return images[0].original_image_url
  const cards = Array.isArray(snapshot.cards) ? snapshot.cards : []
  const c = cards[0]
  if (c) return c.resized_image_url ?? c.video_preview_image_url ?? c.original_image_url ?? null
  return null
}
