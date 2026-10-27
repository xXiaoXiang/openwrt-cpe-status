import { readdir, readFile } from 'node:fs/promises'
import type { CommandDefinition, ModemAdapter, Reading } from '../shared/adapter.ts'
import { ReadCache } from './cache.ts'
import { parseReply, renderCommand } from './parser.ts'
import type { AtTransport } from './transport.ts'
import { requireOperation } from '../shared/availability.ts'

export class Engine {
  readonly cache = new ReadCache()
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0
  writing = false
  constructor(readonly adapter: ModemAdapter, readonly transport: AtTransport, readonly allowWrites = false, private validated = new Set<string>()) {}
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.queued >= 32) throw new Error('ModemReadDeferred: AT queue is full')
    this.queued++
    const next = this.tail.then(work)
    this.tail = next.catch(() => {})
    try { return await next } finally { this.queued-- }
  }
  definition(name: string): CommandDefinition {
    requireOperation(this.adapter, name)
    const definition = this.adapter.commands[name]
    if (!definition || (definition.requiresValidation && !this.validated.has(name))) throw new Error(`Unsupported: ${name} is not enabled for this adapter`)
    return definition
  }
  async read(name: string): Promise<Reading> {
    const definition = this.definition(name)
    if (definition.kind !== 'read') throw new Error('Cannot cache a write command')
    return this.cache.get(name, definition.ttlMs, definition.staleMs ?? 0, async () => {
      if (this.writing) throw new Error('ModemReadDeferred: configuration change in progress')
      return this.exclusive(async () => {
        const reply = await this.transport.exchange(renderCommand(definition), definition.timeoutMs)
        return { values: parseReply(definition, reply), sampledAt: Date.now(), stale: false }
      })
    })
  }
  async write(name: string, parameters: Record<string, unknown> = {}) {
    const definition = this.definition(name)
    if (!this.allowWrites) throw new Error('Unsupported: hardware writes are disabled in service configuration')
    if (definition.kind !== 'write') throw new Error('Expected write operation')
    const command = renderCommand(definition, parameters)
    return this.exclusive(async () => {
      this.writing = true
      try {
        const result = await this.transport.exchange(command, definition.timeoutMs)
        parseReply(definition, result)
        return result
      } finally { this.cache.invalidate(definition.invalidates); this.writing = false }
    })
  }
  async fresh(name: string, timeoutMs?: number) {
    // For callers already holding the exclusive queue (e.g. confirmation reads).
    const definition = this.definition(name)
    return parseReply(definition, await this.transport.exchange(renderCommand(definition), Math.max(1, Math.min(timeoutMs ?? definition.timeoutMs, definition.timeoutMs))))
  }
}

export async function loadAdapters(directory: string): Promise<ModemAdapter[]> {
  const adapters: ModemAdapter[] = []
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.json'))) {
    const candidate: unknown = JSON.parse(await readFile(`${directory}/${file}`, 'utf8'))
    validateAdapter(candidate)
    adapters.push(candidate)
  }
  if (!adapters.length) throw new Error('No adapters found')
  return adapters
}

export function validateAdapter(value: unknown): asserts value is ModemAdapter {
  const adapter = value as ModemAdapter
  if (!adapter || adapter.schemaVersion !== 1 || typeof adapter.id !== 'string' || typeof adapter.modelPattern !== 'string' || !adapter.commands || typeof adapter.commands !== 'object') throw new Error('Invalid adapter header')
  new RegExp(adapter.modelPattern)
  for (const [name, reason] of Object.entries(adapter.unsupportedOperations ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name) || typeof reason !== 'string' || !reason.length || reason.length > 512) throw new Error('Invalid unsupported operation declaration')
  }
  for (const definition of Object.values(adapter.commands)) {
    if (typeof definition.command !== 'string' || !definition.command.startsWith('AT') || /[\r\n\x00-\x1f]/.test(definition.command) || !['read', 'write'].includes(definition.kind) || !Number.isFinite(definition.ttlMs) || definition.ttlMs < 0 || !Number.isFinite(definition.timeoutMs) || definition.timeoutMs <= 0 || definition.timeoutMs > 240_000 || !Array.isArray(definition.rules)) throw new Error('Invalid AT definition')
    for (const rule of definition.rules) {
      if (!['csv', 'captures'].includes(rule.format) || typeof rule.fields !== 'object') throw new Error('Invalid extraction rule')
      new RegExp(rule.regex)
      for (const field of Object.values(rule.fields)) if (!Number.isInteger(field.index) || field.index < 0) throw new Error('Invalid field index')
    }
    for (const [key, values] of Object.entries(definition.parameterValues ?? {})) {
      const pattern = definition.parameters?.[key]
      if (!pattern || !Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !new RegExp(`^(?:${pattern})$`).test(value))) throw new Error('Invalid supported parameter values')
    }
  }
}

export async function identify(transport: AtTransport, adapters: ModemAdapter[]) {
  const modelReply = await transport.exchange('AT+CGMM', 5000)
  const model = modelReply.split(/[\r\n]+/).map(line => line.trim()).find(line => adapters.some(adapter => new RegExp(adapter.modelPattern, 'i').test(line)))
  const matching = adapters.filter(adapter => model && new RegExp(adapter.modelPattern, 'i').test(model))
  if (matching.length !== 1) throw new Error('Unknown or ambiguous module model; no adapter selected')
  const revision = await transport.exchange('AT+CGMR', 5000)
  return { adapter: matching[0], revision }
}
