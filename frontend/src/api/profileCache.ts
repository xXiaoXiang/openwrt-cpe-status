import type { ModemProfile } from '../../../shared/modem-profile.ts'
import type { StatusSnapshot } from '../../../shared/status-snapshot.ts'

export interface ProfileReply { status: string; data?: ModemProfile; profile_key?: string; message?: string }
export function createProfileCache() {
  let current: ProfileReply | undefined
  let pending: Promise<ProfileReply> | undefined
  const listeners = new Set<() => void>()
  async function get(load: () => Promise<ProfileReply>, expectedKey?: string): Promise<ProfileReply> {
    if (current?.data && (!expectedKey || current.profile_key === expectedKey)) return current
    if (!pending) {
      pending = load().then(value => {
        if (value.status === 'ok' && value.data?.schemaVersion !== 1) throw new Error('无效的模块适配规则')
        const changed = current !== undefined && current.profile_key !== value.profile_key
        current = value
        if (changed) listeners.forEach(listener => listener())
        return value
      }).finally(() => { pending = undefined })
    }
    const result = await pending
    if (expectedKey && (result.status !== 'ok' || result.profile_key !== expectedKey)) {
      throw new Error('ModemReadDeferred: 模块适配规则已变化，等待匹配的状态快照')
    }
    return result
  }
  return {
    get,
    peek: () => current?.data,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async hydrate(snapshot: StatusSnapshot, load: () => Promise<ProfileReply>): Promise<StatusSnapshot> {
      if (snapshot.error || snapshot.adapter) return snapshot
      const info = await get(load, snapshot.profile_key)
      return { ...snapshot, adapter: info.data }
    },
  }
}
export const modemProfiles = createProfileCache()
