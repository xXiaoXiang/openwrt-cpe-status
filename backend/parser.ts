import type { CommandDefinition, FieldRule, Scalar } from '../shared/adapter.ts'

// AT CSV includes empty columns and quoted commas. Do not split on commas.
export function csv(text: string): string[] {
  const result: string[] = []
  let current = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { current += '"'; i++ }
      else quoted = !quoted
    } else if (char === ',' && !quoted) { result.push(current.trim()); current = '' }
    else current += char
  }
  if (quoted) throw new Error('Unterminated quoted AT field')
  result.push(current.trim())
  return result
}

function extract(raw: string | undefined, rule: FieldRule): Scalar {
  if (raw !== undefined && rule.pattern) raw = new RegExp(rule.pattern).exec(raw)?.[1]
  if (raw === undefined || raw === '' || rule.unknown?.includes(raw)) {
    if (rule.optional) return null
    throw new Error(`Missing AT field ${rule.index}`)
  }
  if (rule.map) {
    if (!(raw in rule.map)) throw new Error(`Unknown enum ${raw} at field ${rule.index}`)
    return rule.map[raw]
  }
  if (rule.type === 'number' || rule.type === 'hex') {
    if (!(rule.type === 'hex' ? /^[\da-f]+$/i : /^-?\d+(?:\.\d+)?$/).test(raw)) throw new Error(`Invalid numeric AT field ${rule.index}`)
    const value = (rule.type === 'hex' ? Number.parseInt(raw, 16) : Number(raw)) * (rule.scale ?? 1) + (rule.offset ?? 0)
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || (rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max)) throw new Error(`AT field ${rule.index} is out of range`)
    return value
  }
  if (rule.type === 'boolean') {
    if (raw !== '0' && raw !== '1') throw new Error('Expected AT boolean 0/1')
    return raw === '1'
  }
  return raw
}

export function parseReply(definition: CommandDefinition, reply: string): Record<string, Scalar>[] {
  const records: Record<string, Scalar>[] = []
  for (const line of reply.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
    for (const rule of definition.rules) {
      const match = new RegExp(rule.regex).exec(line)
      if (!match) continue
      const pieces = rule.segments ? [...match[1].matchAll(new RegExp(rule.segments, 'g'))].map(value => value[1]) : [match[1]]
      for (const piece of pieces) {
        const fields = rule.format === 'csv' ? csv(piece) : match.slice(1)
        if (rule.minimumFields && fields.length < rule.minimumFields) throw new Error('AT reply layout does not match the adapter')
        const repeat = rule.repeat, count = repeat ? Number(fields[repeat.countIndex]) : 1
        if (!Number.isInteger(count) || count < 0 || (repeat && (count > repeat.maximum || fields.length !== repeat.start + count * repeat.stride))) throw new Error('Invalid repeated AT fields')
        for (let n = 0; n < count; n++) {
          const values = repeat ? fields.slice(repeat.start + n * repeat.stride) : fields
          const record: Record<string, Scalar> = { ...rule.constants }
          for (const [key, field] of Object.entries(rule.fields)) record[key] = extract(values[field.index], field)
          records.push(record)
        }
      }
      break
    }
  }
  if (!records.length && !definition.allowEmpty) throw new Error(`No matching data in ${definition.command} reply`)
  return records
}

export function renderCommand(definition: CommandDefinition, parameters: Record<string, unknown> = {}): string {
  const command = definition.command.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const value = parameters[name]
    const pattern = definition.parameters?.[name]
    if (!pattern || typeof value !== 'string' || !new RegExp(`^(?:${pattern})$`).test(value)) throw new Error(`Invalid parameter: ${name}`)
    return value
  })
  if (/[\r\n\x00-\x1f\x7f]/.test(command) || command.length > 1024 || !command.startsWith('AT')) throw new Error('Invalid AT command')
  return command
}
