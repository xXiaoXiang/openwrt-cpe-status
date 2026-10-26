import type { ModemAdapter } from './adapter.ts'

export interface ModemProfile extends ModemAdapter {
  usbIds: string[]
  _comment: string[]
  contracts: Record<string, string>
  groups: Record<string, { ttl: number; names: string[]; required?: string[] }>
  bandOperations: Record<string, { read: string; write: string }>
  simAbsentPattern: string
  simReadyValue: string
  radioStates: { online: number; flight: number; off: number[] }
  sms: { transport: 'sms-tool-3gpp'; memories: string[]; receiveTimeout: number; sendTimeout: number; sentPattern: string; errorPattern: string; comment: string }
  console: { shortcuts: { label: string; operation: string; desc: string }[]; imeiRead: string; imeiWrite: string }
}
