export const speedSelectionKey = 'cpe-status-speed-interfaces'
export const defaultSpeedInterfaces = ['br-lan', 'wwan']

export function readSpeedSelection(stored: string | null): string[] {
  try {
    const parsed: unknown = stored === null ? null : JSON.parse(stored)
    if (Array.isArray(parsed) && parsed.every(value => typeof value === 'string')) return [...new Set(parsed)]
  } catch { /* Keep the default if browser storage is unavailable or invalid. */ }
  return [...defaultSpeedInterfaces]
}

export function speedInterfaceSelected(iface: { interface: string; logical_interfaces?: string[] }, selected: string[]): boolean {
  return [iface.interface, ...(iface.logical_interfaces ?? [])].some(name => selected.includes(name))
}
