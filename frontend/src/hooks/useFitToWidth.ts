import { useLayoutEffect, useRef } from 'react'
import { getHeaderStatusLayout } from '@/utils/headerStatusLayout'

export function useFitToWidth(alignment: 'window' | 'start' = 'window') {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) return
    const fit = () => {
      const width = Number.parseFloat(getComputedStyle(content).width)
      const height = content.offsetHeight
      if (!width || !height) return
      const scaleToFit = Math.min(1, container.clientWidth / width, container.clientHeight / height)
      const { scale, left, top } = alignment === 'start'
        ? { scale: scaleToFit, left: 0, top: (container.clientHeight - height * scaleToFit) / 2 }
        : getHeaderStatusLayout(container, width, height)
      content.style.transform = `scale(${scale})`
      content.style.left = `${left}px`
      content.style.top = `${top}px`
    }
    const observer = new ResizeObserver(fit)
    observer.observe(container)
    observer.observe(content)
    window.addEventListener('resize', fit)
    fit()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', fit)
    }
  }, [alignment])

  return { containerRef, contentRef }
}
