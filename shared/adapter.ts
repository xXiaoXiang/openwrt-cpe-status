export type Scalar = string | number | boolean | null
export interface FieldRule {
  index: number
  type?: 'string' | 'number' | 'hex' | 'boolean'
  scale?: number
  offset?: number
  map?: Record<string, Scalar>
  min?: number
  max?: number
  optional?: boolean
  unknown?: string[]
  pattern?: string
}
export interface ReplyRule {
  regex: string
  format: 'csv' | 'captures'
  fields: Record<string, FieldRule>
  constants?: Record<string, Scalar>
  minimumFields?: number
  segments?: string
  repeat?: { start: number; stride: number; countIndex: number; maximum: number }
}
export interface CommandDefinition {
  command: string
  kind: 'read' | 'write'
  ttlMs: number
  staleMs?: number
  timeoutMs: number
  optional?: boolean
  requiresValidation?: boolean
  rules: ReplyRule[]
  allowEmpty?: boolean
  parameters?: Record<string, string>
  parameterValues?: Record<string, string[]>
  invalidates?: string[]
  example?: string
  reference: string
  note?: string
  output?: string
}
export interface ModemAdapter {
  schemaVersion: 1
  id: string
  manufacturer: string
  modelPattern: string
  firmwareBaseline: string
  transport: { baudRate: number; preferredUsbInterface: string; note: string }
  documents: { title: string; url: string; scope: string }[]
  commands: Record<string, CommandDefinition>
  unsupportedOperations?: Record<string, string>
}
export interface Reading {
  values: Record<string, Scalar>[]
  sampledAt: number
  stale: boolean
  warning?: string
}
export interface ApiResponse<T = unknown> {
  status: 'ok' | 'deferred' | 'unsupported' | 'error'
  message: string
  data?: T
  retry_after_ms?: number
  job_id?: string
  refreshing?: boolean
  queue_state?: 'queued' | 'running' | 'finished'
  stale?: boolean
  sampled_at?: number
  display?: string
  reason?: string
}
