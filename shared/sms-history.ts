export interface ArchivedSms {
  id: number; phone_number: string; direction: string; content: string; timestamp: string; status: string
  reference?: number; part?: number; total?: number; sim?: string
}
// Segments share a reference only for a limited time. Include SIM and day so a
// reused reference on another SIM/day never joins an unrelated conversation.
export function joinSmsSegments(records: ArchivedSms[]): ArchivedSms[] {
  const result: ArchivedSms[] = [], groups = new Map<string, ArchivedSms[]>()
  for (const row of records) {
    if (!row.total || row.total < 2 || !row.part || row.part > row.total || row.reference === undefined) { result.push(row); continue }
    const key = `${row.sim}:${row.phone_number}:${row.timestamp.slice(0, 10)}:${row.reference}:${row.total}`
    const group = groups.get(key) ?? []
    group.push(row); groups.set(key, group)
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.part! - b.part!)
    const parts = new Set(group.map(row => row.part)), first = group[0]
    if (parts.size === first.total && group.length === first.total) result.push({ ...first, content: group.map(row => row.content).join('') })
    else result.push(...group.map(row => ({ ...row, content: `[${row.part}/${row.total}] ${row.content}` })))
  }
  return result.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || b.id - a.id)
}
