import type { ModemProfile } from './modem-profile.ts'
import { renderCommand } from '../backend/parser.ts'

export const networkModes = [
  { value: 'AUTO', label: '自动（3G / LTE / 5G）' },
  { value: 'LTE:NR5G', label: 'LTE & 5G NR' },
  { value: 'LTE', label: 'LTE Only（仅 4G）' },
  { value: 'NR5G', label: '5G Only（仅 SA）' },
  { value: 'WCDMA:LTE', label: '3G & LTE' },
  { value: 'WCDMA', label: '3G Only（WCDMA）' },
] as const
// netifd qmi.sh applies this after network-register, which otherwise resets
// RM500Q mode_pref to AUTO. Keep the allowed RATs consistent with the AT mode.
export const qmiNetworkModes = {
  AUTO: 'umts,lte,5gnr', 'LTE:NR5G': 'lte,5gnr', LTE: 'lte', NR5G: '5gnr',
  'WCDMA:LTE': 'umts,lte', WCDMA: 'umts',
} as const
export interface CellTarget { rat: 'lte' | 'nr'; arfcn: number; pci: number; band?: number; scs_khz?: number }
export interface LockResult { status: 'ok' | 'error'; count?: number; cells: CellTarget[]; raw: string; message?: string; previous?: LockResult }
export interface CellLockState { lte: LockResult; nr: LockResult; sampled_at: number; stale?: boolean }
export interface CellLockRequest { action: 'lock' | 'unlock'; rat: 'lte' | 'nr'; cell?: CellTarget }
const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
export function cellTarget(value: { tech?: string; arfcn?: string | number; pci?: string | number; band?: string; scs?: number | null; scs_khz?: number }): CellTarget | undefined {
  const rat = value.tech === 'lte' ? 'lte' : value.tech === 'nr' ? 'nr' : undefined
  const arfcn = Number(value.arfcn), pci = Number(value.pci), band = Number(value.band?.replace(/^[Bn]/, ''))
  if (!rat || value.arfcn == null || value.pci == null || !integer(arfcn, rat === 'lte' ? 0 : 1, rat === 'lte' ? 262143 : 3279165) || !integer(pci, 0, rat === 'lte' ? 503 : 1007)) return undefined
  const scs = value.scs_khz ?? (value.scs != null && integer(value.scs, 0, 4) ? 15 * 2 ** value.scs : undefined)
  return { rat, arfcn, pci, ...(rat === 'nr' && integer(band, 1, 1024) ? { band } : {}), ...(rat === 'nr' && scs != null ? { scs_khz: scs } : {}) }
}
export function cellLockCommand(profile: ModemProfile, body: CellLockRequest): string {
  const name = body.rat === 'lte' ? body.action === 'unlock' ? 'lteCellUnlock' : 'lteCellLockSet' : body.action === 'unlock' ? 'nrCellUnlock' : 'nrCellLockSet'
  const definition = profile.commands[name]
  if (!definition) throw new Error('模块适配未提供此锁定操作')
  return renderCommand(definition, { arfcn: String(body.cell?.arfcn), pci: String(body.cell?.pci), band: String(body.cell?.band), scs: String(body.cell?.scs_khz) })
}
export function cellLockParams(body: CellLockRequest, profile?: ModemProfile): string[] {
  if (!['lte', 'nr'].includes(body.rat) || !['lock', 'unlock'].includes(body.action)) throw new Error('无效的锁小区操作')
  if (profile) cellLockCommand(profile, body)
  if (body.action === 'unlock') return ['cell', body.rat, 'unlock']
  const cell = body.cell
  if (!cell || cell.rat !== body.rat || !integer(cell.arfcn, cell.rat === 'lte' ? 0 : 1, cell.rat === 'lte' ? 262143 : 3279165) || !integer(cell.pci, 0, cell.rat === 'lte' ? 503 : 1007)) throw new Error('小区频点或 PCI 无效')
  if (cell.rat === 'nr' && (!integer(cell.band, 1, 1024) || ![15,30,60,120,240].includes(cell.scs_khz ?? 0))) throw new Error('NR 锁定需要有效 Band 与 SCS')
  return ['cell', cell.rat, 'lock', String(cell.arfcn), String(cell.pci), ...(cell.rat === 'nr' ? [String(cell.band), String(cell.scs_khz)] : [])]
}
export function lockMatches(state: CellLockState | undefined, body: CellLockRequest) {
  const actual = state?.[body.rat]
  if (actual?.status !== 'ok') return false
  if (body.action === 'unlock') return actual.count === 0
  return actual.count === 1 && actual.cells.some(cell => cell.arfcn === body.cell?.arfcn && cell.pci === body.cell?.pci
    && (body.rat === 'lte' || (cell.band === body.cell?.band && cell.scs_khz === body.cell?.scs_khz)))
}
