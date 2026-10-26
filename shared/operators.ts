import { csv } from '../backend/parser.ts'

export interface OperatorNetwork { plmn: string; names: string[]; technologies: string[]; status: number }
export interface OperatorState { mode: number; operator: string; plmn: string; registered: boolean; registration: number | null; sampled_at: number }
export interface OperatorResult { status: 'ok' | 'error' | 'deferred'; message?: string; busy?: boolean; refreshing?: boolean; job_id?: string; state?: OperatorState; data?: { raw: string; sampled_at: number } }
const technologies: Record<string, string> = { '0': 'GSM', '2': 'UMTS', '7': 'LTE', '9': 'NB-IoT', '10': 'LTE/5GC', '11': 'NR', '12': 'NR', '13': 'LTE/NR' }
export function parseOperators(raw: string): OperatorNetwork[] {
  if (!/^\s*OK\s*$/m.test(raw) || /^\s*(ERROR|\+CME ERROR:)/m.test(raw)) throw new Error('运营商扫描未完整结束')
  const found = new Map<string, OperatorNetwork>()
  // Quoted names may contain commas or parentheses; capability ranges are ignored.
  const tuples = raw.matchAll(/\(((?:"(?:[^"]|"")*"|[^()"])+)\)/g)
  for (const tuple of tuples) {
    const fields = csv(tuple[1])
    if (fields.length < 4 || !/^[0-3]$/.test(fields[0]) || !/^\d{5,6}$/.test(fields[3])) continue
    const plmn = fields[3], status = Number(fields[0])
    const row = found.get(plmn) ?? { plmn, names: [], technologies: [], status }
    for (const name of fields.slice(1, 3)) if (name && name !== plmn && !row.names.includes(name)) row.names.push(name)
    const rat = technologies[fields[4]] ?? (fields[4] ? `AcT ${fields[4]}` : '')
    if (rat && !row.technologies.includes(rat)) row.technologies.push(rat)
    // Current > available > forbidden > unknown, across multiple RAT entries.
    if ([0, 3, 1, 2].indexOf(status) > [0, 3, 1, 2].indexOf(row.status)) row.status = status
    found.set(plmn, row)
  }
  return [...found.values()].sort((a, b) => Number(b.status === 2) - Number(a.status === 2) || a.plmn.localeCompare(b.plmn))
}
