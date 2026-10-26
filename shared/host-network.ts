export interface NetifdStatus {
  interface?: string
  up?: boolean
  pending?: boolean
  dynamic?: boolean
  proto?: string
  l3_device?: string
  device?: string
  uptime?: number
  'ipv4-address'?: { address: string; mask: number }[]
  'ipv6-address'?: { address: string; mask: number }[]
  'ipv6-prefix'?: { address: string; mask: number }[]
}

export interface HostNetwork {
  net: NetifdStatus
  network_interface?: string
  networks?: NetifdStatus[]
  device_addresses?: string
}

// WAN display uses global unicast space, excluding link-local and ULA.
export const isPublicIpv6 = (address: string) => /^[23][0-9a-f]{3}:/i.test(address)

export function connectionFromHost(host: HostNetwork) {
  const parent = host.net ?? {}, name = host.network_interface ?? 'wwan'
  const children = (host.networks ?? []).filter(row => row.interface === `${name}_4` || row.interface === `${name}_6`
    || (row.dynamic && row.interface?.startsWith(`${name}_`) && row.l3_device === parent.l3_device))
  const active = [parent, ...children].filter(row => row.up === true)
  const device = parent.l3_device || active.find(row => row.l3_device)?.l3_device
  const addresses = (key: 'ipv4-address' | 'ipv6-address' | 'ipv6-prefix') => [...new Set(active.flatMap(row => row[key] ?? [])
    .filter(row => row.address && Number.isInteger(row.mask)
      && (key === 'ipv4-address' || isPublicIpv6(row.address))).map(row => `${row.address}/${row.mask}`))]
  const ipv4 = addresses('ipv4-address'), ipv6 = addresses('ipv6-address')
  // The kernel fallback belongs only to the selected modem device. Link-local
  // IPv6 is not a usable WAN address; an address subnet is not a delegated prefix.
  const fallback = { ipv4: [] as string[], ipv6: [] as string[] }
  if (active.length) for (const line of (host.device_addresses ?? '').split('\n')) {
    const match = /\binet(6)?\s+([\da-f:.]+)\/(\d+).*?\bscope\s+(\S+)/i.exec(line)
    if (!match || match[4] !== 'global' || /\b(tentative|dadfailed)\b/.test(line)) continue
    const family = match[1] ? 'ipv6' : 'ipv4'
    if (family === 'ipv6' && !isPublicIpv6(match[2])) continue
    const mask = Number(match[3])
    if (mask <= (match[1] ? 128 : 32)) fallback[family].push(`${match[2]}/${mask}`)
  }
  return {
    active: active.length > 0, protocol: String(parent.proto ?? '').toUpperCase(), interface: device,
    uptime_seconds: parent.uptime ?? active.find(row => row.uptime !== undefined)?.uptime,
    ipv4: ipv4.length ? ipv4 : [...new Set(fallback.ipv4)],
    ipv6: ipv6.length ? ipv6 : [...new Set(fallback.ipv6)],
    ipv6_prefix: addresses('ipv6-prefix'),
  }
}

export function interfaceAliases(host: HostNetwork, device: string): string[] {
  const parent = { ...host.net, interface: host.network_interface ?? 'wwan' }
  return [...new Set([parent, ...(host.networks ?? [])].filter(row => (row.l3_device || row.device) === device)
    .flatMap(row => row.interface ? [row.interface] : []))]
}
