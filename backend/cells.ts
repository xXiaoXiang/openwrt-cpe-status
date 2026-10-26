import type { Scalar } from '../shared/adapter.ts'

const lteRanges = [[1, 0, 599], [2, 600, 1199], [3, 1200, 1949], [4, 1950, 2399], [5, 2400, 2649], [7, 2750, 3449], [8, 3450, 3799], [12, 5010, 5179], [13, 5180, 5279], [20, 6150, 6449], [28, 9210, 9659], [38, 37750, 38249], [39, 38250, 38649], [40, 38650, 39649], [41, 39650, 41589]]
export function normalizeCells(serving: Record<string, Scalar>[], neighbors: Record<string, Scalar>[], carriers: Record<string, Scalar>[] = []) {
  const state = serving.find(row => row.state)?.state
  const valid = serving.filter(row => row.tech && (!row.is_secondary || (Number(row.arfcn) > 0 && Number(row.band_number) > 0 && row.rsrp !== null && Number(row.rsrp) < 0 && Number(row.rsrp) > -160)))
  const primary = valid.find(row => !row.is_secondary)
  const combined = valid.map(row => ({ ...row }))
  let secondaryIndex = 0
  for (const row of carriers) {
    if (row.arfcn == null || Number(row.arfcn) < 0 || row.pci == null) continue
    const match = combined.find(cell => cell.tech === row.tech && cell.arfcn === row.arfcn && cell.pci === row.pci)
    const bandNumber = row.band_number
    const role = row.carrier_role === 'PCC' ? 'PCC' : `SCC${++secondaryIndex}`
    if (match) {
      match.carrier_role = role
      if (row.tech === 'lte' || match.bandwidth_mhz == null) {
        if (row.bandwidth_mhz != null) {
          match.bandwidth_mhz = row.bandwidth_mhz
          if (row.bandwidth_code != null) match.bandwidth_code = row.bandwidth_code
        }
      }
      if (row.rssnr != null) match.rssnr = row.rssnr
    }
    else if (row.tech === 'lte') combined.push({ ...row, band_number: bandNumber ?? null, is_serving: true, is_secondary: role !== 'PCC', carrier_role: role })
  }
  for (const row of neighbors) {
    if (row.pci == null || row.arfcn == null || combined.some(cell => cell.tech === row.tech && cell.arfcn === row.arfcn && cell.pci === row.pci)) continue
    const band = row.band_number ?? (row.tech === 'lte' ? lteRanges.find(([, min, max]) => Number(row.arfcn) >= min && Number(row.arfcn) <= max)?.[0] : undefined)
    combined.push({ ...row, band_number: band ?? null })
  }
  // Keep the actual primary first, followed by secondary carriers in numeric
  // band order, then neighbors. A lower SCC band must never displace the PCC.
  const roleOrder = (row: Record<string, Scalar>) => row.is_serving ? row.is_secondary ? 1 : 0 : 2
  const bandOrder = (row: Record<string, Scalar>) => Number(row.band_number) > 0 ? Number(row.band_number) : Infinity
  combined.sort((a, b) => roleOrder(a) - roleOrder(b)
    || (a.is_serving && b.is_serving ? bandOrder(a) - bandOrder(b) : 0))
  const cells = combined.map((row): Record<string, Scalar | undefined> => ({
    ...row,
    band: row.band_number ? `${row.tech === 'nr' ? 'n' : 'B'}${row.band_number}` : undefined,
    // R13 reports NR width even with NOCONN. Preserve the reported value,
    // while explicitly distinguishing it from a current connected measurement.
    bandwidth_mhz: row.bandwidth_mhz,
    bandwidth_current: row.tech === 'nr' && row.bandwidth_mhz != null ? state === 'CONNECT' : undefined,
    rrc_state: row.is_serving ? state : undefined,
    // Original dashboard consumes measurements in hundredths. Keep the public
    // contract while the adapter itself always extracts physical dBm/dB units.
    ...Object.fromEntries(['rsrp', 'rsrq', 'rssi', 'sinr', 'rssnr'].map(key => [key, row[key] === null || row[key] === undefined ? undefined : Number(row[key]) * 100])),
    nrarfcn: row.tech === 'nr' ? row.arfcn : undefined,
  }))
  return {
    serving_cell: primary ? { tech: primary.tech, cell_id: primary.cell_id, tac: primary.tac } : null,
    cells,
    technology: primary?.tech === 'nr' ? 'NR' : valid.some(row => row.is_secondary) ? 'ENDC' : primary?.tech === 'lte' ? (secondaryIndex ? 'LTE-A' : 'LTE') : undefined,
  }
}
