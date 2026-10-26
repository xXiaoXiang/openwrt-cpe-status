import type { CellsResponse } from '../api/types.ts'

export function getCellTechnologyLabel(snapshot: CellsResponse | null): string {
  const reported = snapshot?.serving_cell?.tech?.trim().toUpperCase() || '-'
  const primary = reported === 'ENDC' || reported === 'EN-DC' ? 'LTE' : reported
  const hasNrSecondary = snapshot?.cells.some(cell =>
    cell.is_serving && cell.is_secondary && cell.tech?.toLowerCase() === 'nr')
  return primary === 'LTE' && hasNrSecondary ? 'LTE/NR' : primary
}

export function getCellFrequencyLabel(snapshot: CellsResponse | null): string {
  if (!snapshot?.serving_cell) {
    const hasNr = snapshot?.cells.some(cell => cell.tech === 'nr')
    const hasLte = snapshot?.cells.some(cell => cell.tech === 'lte')
    return hasNr ? hasLte ? '(NR) ARFCN' : 'NRARFCN' : 'ARFCN'
  }
  const technology = getCellTechnologyLabel(snapshot)
  return technology === 'LTE/NR' ? '(NR) ARFCN' : technology === 'NR' ? 'NRARFCN' : 'ARFCN'
}

export function formatCellBandwidth(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? `${value} MHz` : '-'
}
