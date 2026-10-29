'use client'
import { useEffect, useState, type ImgHTMLAttributes, type SVGProps } from 'react'
import type { ArtworkRow } from './types'
import { artSources } from './model'

/** Walks a list of picture sources; a source that fails to load hands over to the next one. */
export function useArtSrc(sources: string[]): { src: string | null; onError: () => void; exhausted: boolean } {
  const key = sources.join('\n')
  const [state, setState] = useState({ key, i: 0 })
  useEffect(() => { setState(s => (s.key === key ? s : { key, i: 0 })) }, [key])
  const i = state.key === key ? state.i : 0
  return {
    src: sources[i] ?? null,
    onError: () => setState(s => ({ key, i: (s.key === key ? s.i : 0) + 1 })),
    exhausted: i >= sources.length,
  }
}

type ArtImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> & {
  art: ArtworkRow
  /** The longest side the picture is shown at; Google resizes to it. */
  px: number
  /** Fall back to the original file when nothing smaller loads (canvas, compare), or give up (thumbnails). */
  full?: boolean
  fallback?: React.ReactNode
}

export function ArtImg({ art, px, full = false, fallback = null, alt = '', ...rest }: ArtImgProps) {
  const { src, onError, exhausted } = useArtSrc(artSources(art, px, full))
  if (!src || exhausted) return <>{fallback}</>
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} onError={onError} {...rest} />
}

type SvgArtImageProps = Omit<SVGProps<SVGImageElement>, 'href' | 'onError'> & { art: ArtworkRow; px: number }

/** The same for an SVG `<image>` on the template sheet; the original is the last resort there. */
export function SvgArtImage({ art, px, ...rest }: SvgArtImageProps) {
  const { src, onError } = useArtSrc(artSources(art, px, true))
  if (!src) return null
  return <image href={src} onError={onError} {...rest} />
}
