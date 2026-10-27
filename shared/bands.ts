export const bandGroups = [
  { key: 'lte', command: 'lte_band', label: '首选 LTE 频段', prefix: 'B' },
  { key: 'sa', command: 'nr5g_band', label: '首选 5G SA 频段', prefix: 'n' },
  { key: 'nsa', command: 'nsa_nr5g_band', label: '首选 5G NSA 频段', prefix: 'n' },
] as const
export type BandKey = typeof bandGroups[number]['key']
export type BandSelection = Record<BandKey, number[]>
export interface BandState {
  model: string
  supported: BandSelection
  enabled: BandSelection
  sampled_at: number
  stale?: boolean
  unavailable?: Partial<Record<BandKey, string>>
}
export function normalizeBands(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 128
    || value.some(band => !Number.isInteger(band) || band < 1 || band > 1024)) throw new Error('每组须选择至少一个有效频段')
  return [...new Set(value as number[])].sort((a, b) => a - b)
}
