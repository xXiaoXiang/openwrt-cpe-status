import type { ModemProfile } from '../../../shared/modem-profile.ts'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Alert, Box } from '@mui/material'
import { backendFetch, usesSnapshotTransport } from '@/api/transport'
import { modemProfiles } from '@/api/profileCache'
import { modemActivity } from '@/api/modemActivity'
import { useModemDownloadPause } from '@/hooks/useAdaptivePolling'

interface Capabilities { modem_profile?: ModemProfile; id: string; demo: boolean; status_only?: boolean; writes_enabled: boolean; lpac_enabled: boolean; data_control: boolean; airplane_control?: boolean; roaming_policy: boolean; roaming_scope?: string; ims: boolean }
const Context = createContext<Capabilities | null>(null)
export const useCapabilities = () => useContext(Context)
export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [euiccAvailable, setEuiccAvailable] = useState(false)
  const downloadPaused = useModemDownloadPause()
  useEffect(() => {
    if (!usesSnapshotTransport()) return
    let stopped = false, pending = false
    const inspect = async () => {
      if (pending) return
      pending = true
      try {
        const result = await backendFetch('/api/euicc/activity').then(response => response.json()) as { status: string; data?: { active: boolean } }
        if (!stopped && result.status === 'ok' && typeof result.data?.active === 'boolean') modemActivity.setRemote(result.data.active)
      } catch { /* Preserve the last activity state until the backend answers. */ }
      finally { pending = false }
    }
    void inspect()
    const timer = window.setInterval(() => { void inspect() }, 1000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    if (!usesSnapshotTransport()) return
    let cancelled = false, pending = false
    const probe = async () => {
      if (pending || document.hidden || modemActivity.isPaused()) return
      pending = true
      try {
        const result = await backendFetch('/api/euicc/capability').then(response => response.json()) as { available?: boolean; status: string }
        if (!cancelled && (result.status === 'ok' || result.status === 'unsupported' || result.available === true)) {
          const available = result.available === true
          setEuiccAvailable(available)
          window.parent.postMessage({ type: 'cpe-status-euicc', available }, window.location.origin)
        }
      } catch { /* A transient RPC failure does not prove the card is absent. */ }
      finally { pending = false }
    }
    void probe()
    const timer = window.setInterval(() => { void probe() }, 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    let cancelled = false
    const load = () => { void backendFetch('/api/adaptation').then(response => response.json()).then((response: { status: string; data?: Capabilities; message: string }) => {
      if (cancelled) return
      if (response.status !== 'ok' || !response.data) throw new Error(response.message)
      setCapabilities(response.data)
      setError(null)
    }).catch(reason => { if (!cancelled) setError(String(reason)) }) }
    load()
    const unsubscribe = modemProfiles.subscribe(load)
    return () => { cancelled = true; unsubscribe() }
  }, [])
  const value = capabilities && usesSnapshotTransport() ? { ...capabilities, lpac_enabled: euiccAvailable, writes_enabled: capabilities.writes_enabled && !downloadPaused } : capabilities
  return <Context.Provider value={value}>
    {error && <Alert severity="error">无法读取模块能力：{error}</Alert>}
    {capabilities?.demo && <Box p={1}><Alert severity="warning">演示模式：Modem 数据由测试样本提供，控制操作不会访问真实硬件。系统资源为本机数据。</Alert></Box>}
    {children}
  </Context.Provider>
}
