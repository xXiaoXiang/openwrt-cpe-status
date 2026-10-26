import type { CellsResponse, CellInfo } from '../frontend/src/api/types.ts'

export interface CellScanReading { raw: string; sampled_at: number }
export interface CellScanResponse {
  status: 'ok' | 'deferred' | 'error'
  message: string
  scanning?: boolean
  job_id?: string
  data?: CellScanReading
}

// QSCAN extended CSV: RAT,MCC,MNC,ARFCN,PCI,RSRP,RSRQ,SRXLEV,
// SCS (NR) / SQUAL (LTE),CellID,TAC,bandwidth,Band,... .
// Only consume documented positions: bandwidth here is not a QENG enum.
export function parseCellScan(raw: string): CellsResponse {
  if (!/^\s*OK\s*$/m.test(raw) || /^\s*(?:ERROR|\+CME ERROR:)/m.test(raw)) throw new Error('小区扫描未完整结束，保留原列表')
  const cells: CellInfo[] = []
  const seen = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*\+QSCAN:\s*(.*)$/.exec(line)
    if (!match) continue
    const fields = match[1].split(',').map(value => value.trim().replace(/^"|"$/g, ''))
    const tech = fields[0] === 'LTE' ? 'lte' : fields[0] === 'NR5G' ? 'nr' : undefined
    const number = (index: number) => /^-?\d+(?:\.\d+)?$/.test(fields[index] ?? '') ? Number(fields[index]) : undefined
    const arfcn = number(3), pci = number(4), band = number(12)
    if (!tech || !/^\d{3}$/.test(fields[1]) || !/^\d{2,3}$/.test(fields[2]) || arfcn == null || pci == null
      || !Number.isInteger(arfcn) || !Number.isInteger(pci) || arfcn < 0 || arfcn > (tech === 'lte' ? 262143 : 3279165) || pci < 0 || pci > (tech === 'lte' ? 503 : 1007)) continue
    const key = [tech, fields[1], fields[2], arfcn, pci].join(':')
    if (seen.has(key)) continue
    seen.add(key)
    const signal = (index: number) => { const value = number(index); return value != null && value < 0 && value > -200 ? value * 100 : undefined }
    const scs = tech === 'nr' ? number(8) : undefined
    cells.push({ tech, arfcn, pci, mcc: fields[1], mnc: fields[2], is_serving: false,
      band: band != null && Number.isInteger(band) && band > 0 && band <= 1024 ? (tech === 'lte' ? 'B' : 'n') + band : undefined,
      rsrp: signal(5), rsrq: signal(6), scs: scs != null && [0, 1, 2, 3, 4].includes(scs) ? scs : undefined })
  }
  if (/^\s*\+QSCAN:/m.test(raw) && !cells.length) throw new Error('模块返回的小区扫描格式无法识别，保留原列表')
  cells.sort((a, b) => (a.tech === b.tech ? 0 : a.tech === 'lte' ? -1 : 1)
    || Number(a.band?.slice(1) || 0) - Number(b.band?.slice(1) || 0) || Number(a.arfcn) - Number(b.arfcn) || Number(a.pci) - Number(b.pci))
  return { serving_cell: null, cells }
}
