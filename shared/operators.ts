import type { Scalar } from './adapter.ts'

export interface OperatorNetwork { plmn: string; names: string[]; technologies: string[]; status: number }
export interface OperatorState { mode: number; operator: string; plmn: string; registered: boolean; registration: number | null; sampled_at: number }
export interface OperatorResult { status: 'ok' | 'error' | 'deferred' | 'unsupported'; message?: string; busy?: boolean; refreshing?: boolean; job_id?: string; state?: OperatorState; data?: { raw: string; records?: Record<string, Scalar>[]; sampled_at: number } }
export function normalizeOperatorName(value: string) {
  let parts=value.trim().split(/\s+/)
  while (parts.length>1 && parts.length%2===0) {
    const middle=parts.length/2, first=parts.slice(0,middle)
    if (first.join(' ').toLowerCase()!==parts.slice(middle).join(' ').toLowerCase()) break
    parts=first
  }
  return parts.join(' ')
}
export function parseOperators(raw: string, records?: Record<string, Scalar>[]): OperatorNetwork[] {
  if (!/^\s*OK\s*$/m.test(raw) || /^\s*(ERROR|\+CME ERROR:)/m.test(raw)) throw new Error('运营商扫描未完整结束')
  const found = new Map<string, OperatorNetwork>()
  if (!records) throw new Error('运营商扫描格式无法识别')
  for (const record of records) {
    const plmn = String(record.plmn ?? ''), status = Number(record.status)
    if (!/^\d{5,6}$/.test(plmn) || ![0,1,2,3].includes(status)) continue
    const row = found.get(plmn) ?? { plmn, names: [], technologies: [], status }
    for (const name of [String(record.long_name ?? ''), String(record.short_name ?? '')]) if (name && name !== plmn && !row.names.includes(name)) row.names.push(name)
    const rat = String(record.technology ?? '')
    if (rat && !row.technologies.includes(rat)) row.technologies.push(rat)
    // Current > available > forbidden > unknown, across multiple RAT entries.
    if ([0, 3, 1, 2].indexOf(status) > [0, 3, 1, 2].indexOf(row.status)) row.status = status
    found.set(plmn, row)
  }
  return [...found.values()].sort((a, b) => Number(b.status === 2) - Number(a.status === 2) || a.plmn.localeCompare(b.plmn))
}
