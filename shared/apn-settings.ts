export interface ApnSettings {
  apn: string
  pdptype: 'ipv4' | 'ipv6' | 'ipv4v6'
  auth: 'none' | 'pap' | 'chap' | 'both'
  username: string
  password: string
}
export interface ApnStatus {
  settings: ApnSettings
  preferred?: ApnSettings
  iccid?: string
  choices?: ApnChoice[]
  database?: ApnDatabaseInfo
  protocol_fallback?: { mcc: string; mnc: string; apn: string; pdptype: 'ipv4'; confirmed: boolean; testing: boolean; user_override: boolean } | null
  active?: boolean
  active_supported?: boolean
  active_apn?: string
  active_protocol?: string
  sampled_at?: number
  logs?: string[]
}
export interface ApnChoice {
  id: string
  source: 'custom' | 'local' | 'database'
  carrier: string
  settings: ApnSettings
}
export interface ApnDeleteRequest { iccid: string; settings: ApnSettings }
export interface ApnDatabaseInfo {
  version: string
  count: number
  source: string
}
export interface ApnDatabaseReply {
  status: 'ok' | 'pending' | 'protected' | 'error' | 'deferred'
  message?: string
  job_id?: string
  data?: ApnDatabaseInfo & { updated?: boolean; modified?: boolean }
}
export function validateApnSettings(value: ApnSettings): ApnSettings {
  if (!value || typeof value.apn !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/.test(value.apn)) throw new Error('APN 名称格式无效')
  if (!['ipv4', 'ipv6', 'ipv4v6'].includes(value.pdptype) || !['none', 'pap', 'chap', 'both'].includes(value.auth)) throw new Error('IP 协议或认证方式无效')
  for (const field of ['username', 'password'] as const) if (typeof value[field] !== 'string' || value[field].length > 128 || /[\x00-\x1f\x7f]/.test(value[field])) throw new Error('用户名或密码格式无效')
  return { apn: value.apn, pdptype: value.pdptype, auth: value.auth, username: value.username, password: value.password }
}
export function validateApnDelete(value: ApnDeleteRequest): ApnDeleteRequest {
  if (!value || typeof value.iccid !== 'string' || !/^[0-9]{18,22}$/.test(value.iccid)) throw new Error('无效 ICCID，请重新读取 APN')
  return { iccid: value.iccid, settings: validateApnSettings(value.settings) }
}
