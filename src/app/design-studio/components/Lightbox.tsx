'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { copyText, type LightboxImage } from './model'
import { Icon } from './ui'

type LightboxApi = { open: (url: string, fallback?: LightboxImage) => void }

const LightboxContext = createContext<LightboxApi | null>(null)

export function useLightbox(): LightboxApi | null {
  return useContext(LightboxContext)
}

const ctrl = 'inline-flex items-center gap-xs rounded-lg px-sm py-xs text-label-sm font-semibold text-white bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed'

export function Lightbox({ images, index, onIndex, onClose }: { images: LightboxImage[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const [actual, setActual] = useState(false)
  const [copied, setCopied] = useState('')
  const closeRef = useRef<HTMLButtonElement>(null)
  const image = images[index]
  const many = images.length > 1
  const go = useCallback((d: number) => { if (many) onIndex((index + d + images.length) % images.length) }, [many, index, images.length, onIndex])

  useEffect(() => { setActual(false); setCopied('') }, [index])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => {
      document.body.style.overflow = overflow
      previous?.focus?.()
    }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, onClose])

  if (!image) return null
  const openUrl = image.openUrl ?? image.url

  async function copy() {
    const link = new URL(image.copyUrl ?? openUrl, window.location.origin).href
    setCopied(await copyText(link) ? 'Đã copy link' : 'Không copy được link')
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={`Xem ảnh: ${image.label}`} className="fixed inset-0 z-[100] flex flex-col bg-black/85">
      <div className="flex items-center gap-sm px-md py-sm text-white">
        <span className="text-body-sm font-semibold truncate">{image.label}</span>
        {many && <span className="text-label-sm text-white/70 whitespace-nowrap">{index + 1} / {images.length}</span>}
        <span role="status" aria-live="polite" className="text-label-sm text-white/80">{copied}</span>
        <span className="ml-auto flex items-center gap-xs">
          <button type="button" onClick={() => setActual(!actual)} aria-pressed={actual} className={ctrl}>
            <Icon name={actual ? 'fit_screen' : 'zoom_in'} className="text-[18px]" />{actual ? 'Vừa khung' : '100%'}
          </button>
          <a href={openUrl} target="_blank" rel="noreferrer" className={ctrl}>
            <Icon name="open_in_new" className="text-[18px]" />Mở file gốc
          </a>
          <button type="button" onClick={copy} className={ctrl}>
            <Icon name="link" className="text-[18px]" />Copy link
          </button>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Đóng" title="Đóng (Esc)" className={`${ctrl} px-xs`}>
            <Icon name="close" className="text-[22px]" />
          </button>
        </span>
      </div>
      <div className="relative flex-1 min-h-0">
        <div onClick={e => { if (e.target === e.currentTarget) onClose() }}
          className={`absolute inset-0 ${actual ? 'overflow-auto' : 'grid place-items-center overflow-hidden'} px-3xl pb-md`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.url} alt={image.label} onClick={() => setActual(!actual)}
            className={actual ? 'max-w-none m-auto block cursor-zoom-out' : 'max-w-full max-h-full object-contain cursor-zoom-in'} />
        </div>
        {many && (
          <>
            <button type="button" onClick={() => go(-1)} aria-label="Ảnh trước" title="Ảnh trước (←)"
              className="absolute left-sm top-1/2 -translate-y-1/2 grid place-items-center w-10 h-10 rounded-full bg-white/15 text-white hover:bg-white/30">
              <Icon name="chevron_left" className="text-[28px]" />
            </button>
            <button type="button" onClick={() => go(1)} aria-label="Ảnh sau" title="Ảnh sau (→)"
              className="absolute right-sm top-1/2 -translate-y-1/2 grid place-items-center w-10 h-10 rounded-full bg-white/15 text-white hover:bg-white/30">
              <Icon name="chevron_right" className="text-[28px]" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export function LightboxProvider({ images, children }: { images: LightboxImage[]; children: ReactNode }) {
  const [state, setState] = useState<{ list: LightboxImage[]; index: number } | null>(null)
  const open = useCallback((url: string, fallback?: LightboxImage) => {
    const i = images.findIndex(m => m.url === url)
    if (i >= 0) setState({ list: images, index: i })
    else setState({ list: [fallback ?? { url, label: url.split('/').pop() || 'Ảnh' }, ...images], index: 0 })
  }, [images])
  const api = useMemo(() => ({ open }), [open])
  return (
    <LightboxContext.Provider value={api}>
      {children}
      {state && (
        <Lightbox images={state.list} index={state.index} onIndex={index => setState({ ...state, index })} onClose={() => setState(null)} />
      )}
    </LightboxContext.Provider>
  )
}
