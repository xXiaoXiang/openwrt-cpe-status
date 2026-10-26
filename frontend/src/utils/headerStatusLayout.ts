// Prefer the window center. On narrow screens keep the row inside the space
// reserved after the page title, scaling it to avoid overlap or wrapping.
export function getHeaderStatusLayout(container: HTMLElement, width: number, height: number) {
  const bounds = container.getBoundingClientRect()
  const scale = Math.min(1, bounds.width / width, bounds.height / height)
  const renderedWidth = width * scale
  const preferredLeft = window.innerWidth / 2 - bounds.left - renderedWidth / 2
  return {
    scale,
    left: Math.max(0, Math.min(preferredLeft, bounds.width - renderedWidth)),
    top: (bounds.height - height * scale) / 2,
  }
}
