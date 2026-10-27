import type { Scalar } from './adapter.ts'
import type { CellsResponse, CellInfo } from '../frontend/src/api/types.ts'

export interface CellScanReading { raw: string; records?: Record<string, Scalar>[]; sampled_at: number }
export interface CellScanResponse {
  status: 'ok' | 'deferred' | 'error' | 'unsupported'
  message: string
  scanning?: boolean
  job_id?: string
  data?: CellScanReading
}

// QSCAN extended CSV: RAT,MCC,MNC,ARFCN,PCI,RSRP,RSRQ,SRXLEV,
// SCS (NR) / SQUAL (LTE),CellID,TAC,bandwidth,Band,... .
// Only consume documented positions: bandwidth here is not a QENG enum.
export function parseCellScan(raw: string, records?: Record<string, Scalar>[]): CellsResponse {
  if (!/^\s*OK\s*$/m.test(raw) || /^\s*(?:ERROR|\+CME ERROR:)/m.test(raw)) throw new Error('小区扫描未完整结束，保留原列表')
  const cells: CellInfo[] = []
  const seen = new Set<string>()
  if (!records) throw new Error('模块返回的小区扫描格式无法识别，保留原列表')
  for (const row of records) {
    const tech = row.tech === 'lte' ? 'lte' : row.tech === 'nr' ? 'nr' : undefined
    const number = (key: string) => typeof row[key] === 'number' ? row[key] as number : undefined
    const arfcn = number('arfcn'), pci = number('pci'), band = number('band_number')
    const fields = ['', String(row.mcc ?? ''), String(row.mnc ?? '')]
    if (!tech || !/^\d{3}$/.test(fields[1]) || !/^\d{2,3}$/.test(fields[2]) || arfcn == null || pci == null
      || !Number.isInteger(arfcn) || !Number.isInteger(pci) || arfcn < 0 || arfcn > (tech === 'lte' ? 262143 : 3279165) || pci < 0 || pci > (tech === 'lte' ? 503 : 1007)) continue
    const key = [tech, fields[1], fields[2], arfcn, pci].join(':')
    if (seen.has(key)) continue
    seen.add(key)
    const signal = (key: string) => { const value = number(key); return value != null && value < 0 && value > -200 ? value * 100 : undefined }
    const scs = tech === 'nr' ? number('scs') : undefined
    cells.push({ tech, arfcn, pci, mcc: fields[1], mnc: fields[2], is_serving: false,
      band: band != null && Number.isInteger(band) && band > 0 && band <= 1024 ? (tech === 'lte' ? 'B' : 'n') + band : undefined,
      rsrp: signal('rsrp'), rsrq: signal('rsrq'), scs: scs != null && [0, 1, 2, 3, 4].includes(scs) ? scs : undefined })
  }
  if (records.length && !cells.length) throw new Error('模块返回的小区扫描格式无法识别，保留原列表')
  cells.sort((a, b) => (a.tech === b.tech ? 0 : a.tech === 'lte' ? -1 : 1)
    || Number(a.band?.slice(1) || 0) - Number(b.band?.slice(1) || 0) || Number(a.arfcn) - Number(b.arfcn) || Number(a.pci) - Number(b.pci))
  return { serving_cell: null, cells }
}
