import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { getHeaderStatusLayout } from '@/utils/headerStatusLayout'

// Move one portal between its reserved dashboard space and the header, so the
// same status badges stay visible while their data updates independently.
export function useScrollDock(target: HTMLDivElement | null) {
  const homeElement = useRef<HTMLDivElement | null>(null)
  const hostElement = useRef<HTMLDivElement | null>(null)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const homeRef = useCallback((element: HTMLDivElement | null) => {
    homeElement.current = element
    if (element && !hostElement.current) {
      const portal = document.createElement('div')
      portal.dataset.networkStatusDock = ''
      Object.assign(portal.style, {
        position: 'absolute', left: '0', top: '0', width: 'max-content',
        transformOrigin: '0 0', whiteSpace: 'nowrap',
      })
      hostElement.current = portal
      setHost(portal)
    }
  }, [])

  useLayoutEffect(() => {
    const home = homeElement.current
    const portal = hostElement.current
    if (!home || !portal || !host) return
    let frame = 0
    let docked = false
    let animation: Animation | undefined
    const update = () => {
      frame = 0
      const header = target?.closest('header')
      const shouldDock = !!target && !!header && home.getBoundingClientRect().top < header.getBoundingClientRect().bottom
      const destination = shouldDock ? target : home
      const moving = portal.parentElement !== destination
      const before = moving && portal.isConnected ? portal.getBoundingClientRect() : null
      if (moving) {
        animation?.cancel()
        destination.appendChild(portal)
      }
      const width = Number.parseFloat(getComputedStyle(portal).width) || portal.offsetWidth
      const height = portal.offsetHeight
      if (!width || !height) return
      // Preserve the dashboard height even when the row is inside the header.
      const reservedHeight = `${height * Math.min(1, home.clientWidth / width)}px`
      if (home.style.height !== reservedHeight) home.style.height = reservedHeight
      const { scale, left, top } = shouldDock
        ? getHeaderStatusLayout(destination, width, height)
        : { scale: Math.min(1, destination.clientWidth / width), left: 0, top: 0 }
      portal.style.left = `${left}px`
      portal.style.top = `${top}px`
      portal.style.transform = `scale(${scale})`
      portal.dataset.docked = String(shouldDock)
      if (before && docked !== shouldDock && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const after = portal.getBoundingClientRect()
        const fromTop = shouldDock && header ? Math.max(before.top, header.getBoundingClientRect().bottom) : before.top
        animation = portal.animate([
          { transform: `translate(${before.left - after.left}px, ${fromTop - after.top}px) scale(${before.width / width}, ${before.height / height})` },
          { transform: `scale(${scale})` },
        ], { duration: 280, easing: 'cubic-bezier(0.2, 0, 0, 1)' })
      }
      docked = shouldDock
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    const observer = new ResizeObserver(update)
    observer.observe(home)
    observer.observe(portal)
    if (target) observer.observe(target)
    window.addEventListener('scroll', schedule, { passive: true, capture: true })
    window.addEventListener('resize', schedule)
    update()
    return () => {
      cancelAnimationFrame(frame)
      animation?.cancel()
      observer.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      portal.remove()
    }
  }, [host, target])

  return { homeRef, host }
}
