'use client'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Icon } from './ui'

/** Closes a popover on a click outside `ref` or on Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) close.current() }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close.current() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, ref])
}

export function PopoverHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center">
      <span className="text-body-md font-semibold text-on-surface">{title}</span>
      <button type="button" onClick={onClose} aria-label="Đóng" className="ml-auto inline-grid place-items-center w-8 h-8 rounded-lg text-on-surface-variant hover:bg-surface-container-low">
        <Icon name="close" className="text-[20px]" />
      </button>
    </div>
  )
}

type Toast = { id: number; msg: string; tone: 'ok' | 'bad' }
type ToastApi = { say: (msg: string, tone?: 'ok' | 'bad') => void }

const ToastContext = createContext<ToastApi>({ say: () => {} })

export function useToast(): ToastApi {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = useCallback((msg: string, tone: 'ok' | 'bad' = 'ok') => {
    if (!msg) return
    if (timer.current) clearTimeout(timer.current)
    setToast({ id: Date.now(), msg, tone })
    timer.current = setTimeout(() => setToast(null), tone === 'bad' ? 8000 : 3500)
  }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return (
    <ToastContext.Provider value={{ say }}>
      {children}
      {toast && (
        <div role={toast.tone === 'bad' ? 'alert' : 'status'} className="fixed left-1/2 bottom-lg -translate-x-1/2 z-[120] flex items-center gap-sm max-w-[640px] rounded-lg bg-on-surface text-surface px-md py-sm shadow-overlay text-body-sm">
          <Icon name={toast.tone === 'bad' ? 'error' : 'check_circle'} className={`text-[20px] ${toast.tone === 'bad' ? 'text-error-container' : 'text-on-tertiary-container'}`} />
          <span className="min-w-0 break-words">{toast.msg}</span>
          <button type="button" onClick={() => setToast(null)} aria-label="Đóng thông báo" className="inline-grid place-items-center w-7 h-7 rounded-lg hover:bg-white/10 shrink-0">
            <Icon name="close" className="text-[18px]" />
          </button>
        </div>
      )}
    </ToastContext.Provider>
  )
}
