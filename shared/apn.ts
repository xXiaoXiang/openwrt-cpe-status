export interface ApnEntry {
  carrier: string; mcc: string; mnc: string; apn: string; protocol?: string
  user?: string; password?: string; authtype?: string; mvno_type?: string; mvno_match_data?: string
}
export interface SimIdentity { imsi: string; iccid?: string; mncLength?: number; spn?: string; gid?: string }
const entity = (value: string) => value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, key: string) => {
  if (key[0] === '#') return String.fromCodePoint(parseInt(key.slice(key[1].toLowerCase() === 'x' ? 2 : 1), key[1].toLowerCase() === 'x' ? 16 : 10))
  return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[key]
})
export function compileApns(xml: string): ApnEntry[] {
  const result: ApnEntry[] = []
  for (const match of xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<apn\s+([\s\S]*?)\/>/g)) {
    const row = Object.fromEntries([...match[1].matchAll(/([\w_]+)\s*=\s*"([^"]*)"/g)].map(value => [value[1], entity(value[2])]))
    if (!/^\d{3}$/.test(row.mcc) || !/^\d{2,3}$/.test(row.mnc) || !/^[\w.-]{1,100}$/.test(row.apn ?? '') || row.carrier_enabled === 'false' || row.proxy) continue
    if (!row.type?.split(',').some(value => ['default', '*'].includes(value.trim()))) continue
    const fields = ['carrier', 'mcc', 'mnc', 'apn', 'protocol', 'user', 'password', 'authtype', 'mvno_type', 'mvno_match_data']
    result.push(Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]])) as unknown as ApnEntry)
  }
  if (!result.length) throw new Error('APN database has no usable default entries')
  return result
}
export function selectApn(entries: ApnEntry[], sim: SimIdentity, current = ''): ApnEntry | undefined {
  if (!/^\d{14,16}$/.test(sim.imsi)) return undefined
  const candidates = entries.filter(row => sim.imsi.startsWith(row.mcc + row.mnc) && (!sim.mncLength || row.mnc.length === sim.mncLength))
  const lengths = new Set(candidates.map(row => row.mnc.length))
  // Ambiguous 2-/3-digit home MNC must be resolved by EF_AD, never guessed.
  if (lengths.size > 1) return undefined
  const matches = (row: ApnEntry) => {
    const pattern = row.mvno_match_data ?? ''
    switch (row.mvno_type?.toLowerCase()) {
      case undefined: case '': return true
      case 'imsi': return pattern.length > 0 && pattern.length <= sim.imsi.length && [...pattern].every((char, i) => /[xX]/.test(char) || char === sim.imsi[i])
      case 'iccid': return pattern.split(',').some(prefix => prefix.length > 0 && sim.iccid?.startsWith(prefix))
      case 'gid': return !!sim.gid && sim.gid.toLowerCase().startsWith(pattern.toLowerCase()) && !!pattern
      case 'spn': return !!sim.spn && sim.spn.toLowerCase() === pattern.toLowerCase()
      default: return false
    }
  }
  const valid = candidates.filter(matches)
  return valid.sort((a, b) => Number(!!b.mvno_type) - Number(!!a.mvno_type) || Number(b.apn === current) - Number(a.apn === current))[0]
}
