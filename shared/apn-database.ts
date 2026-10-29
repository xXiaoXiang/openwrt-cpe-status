import type { ApnEntry } from './apn.ts'

export interface ProviderApnDatabase {
  schema_version: 1
  version: string
  source: string
  count: number
  entries: ApnEntry[]
}

// Mirrors the router's compileProviders validation and field mapping.
export function compileProviderDatabase(raw: string): ProviderApnDatabase {
  if (!/# database-format: 2(\r?\n)/.test(raw)) throw new Error('Unsupported APN database format')
  const version = raw.match(/# database-version: (\d{4}\.\d{2}\.\d{2})(\r?\n)/)?.[1]
  if (!version) throw new Error('Missing APN database version')
  const optional = (value: string) => ['', '-', '*'].includes(value) ? '' : value
  const entries: ApnEntry[] = []
  for (const line of raw.split('\n').map(value => value.replace(/\r$/, ''))) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const col = line.split('\t')
    if (col.length !== 12 || col.some(value => /[\x00-\x1f\x7f]/.test(value))) throw new Error('Invalid APN database row')
    const [plmn, imsi, iccid, gid, spn] = col.slice(0, 5).map(optional)
    if (plmn && !/^\d{5,6}$/.test(plmn) || imsi && !/^[\dxX]{5,16}$/.test(imsi) ||
      iccid && !/^[\dxX]{1,22}$/.test(iccid) || gid && !/^[a-fA-F\d]+$/.test(gid) ||
      ![plmn, imsi, iccid, gid, spn].some(Boolean)) throw new Error('Invalid APN subscriber filter')
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/.test(col[6]) || !/^\d{1,6}$/.test(col[7]) ||
      col[5].length > 256 || col[8].length > 128 || col[9].length > 128) throw new Error('Invalid APN parameters')
    const auth = optional(col[10]), protocol = optional(col[11])
    if (!['', 'none', 'pap', 'chap', 'pap-or-chap'].includes(auth) ||
      !['', 'ipv4', 'ipv6', 'ipv4v6'].includes(protocol)) throw new Error('Invalid APN authentication or protocol')
    entries.push({
      carrier: col[5], mcc: plmn ? plmn.slice(0, 3) : '*', mnc: plmn ? plmn.slice(3) : '', apn: col[6], priority: +col[7],
      ...(imsi ? { imsi_pattern: imsi } : {}), ...(iccid ? { iccid_pattern: iccid } : {}),
      ...(gid ? { gid1: gid } : {}), ...(spn ? { spn } : {}),
      ...(optional(col[8]) ? { user: col[8] } : {}), ...(optional(col[9]) ? { password: col[9] } : {}),
      ...(auth ? { authtype: ({ none: '0', pap: '1', chap: '2', 'pap-or-chap': '3' } as Record<string, string>)[auth] } : {}),
      ...(protocol ? { protocol: protocol === 'ipv4' ? 'IP' : protocol.toUpperCase() } : {}),
    })
  }
  if (entries.length < 500 || entries.length > 30000) throw new Error('Unexpected APN database entry count')
  return { schema_version: 1, version, source: 'GNOME MBPI + AOSP', count: entries.length, entries }
}
