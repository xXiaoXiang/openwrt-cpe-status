import type { ModemProfile } from '../../../shared/modem-profile.ts'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Alert, Box } from '@mui/material'
import { backendFetch } from '@/api/transport'

interface Capabilities { modem_profile?: ModemProfile; id: string; demo: boolean; status_only?: boolean; writes_enabled: boolean; lpac_enabled: boolean; data_control: boolean; airplane_control?: boolean; roaming_policy: boolean; roaming_scope?: string; ims: boolean }
const Context = createContext<Capabilities | null>(null)
export const useCapabilities = () => useContext(Context)
export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void backendFetch('/api/adaptation').then(response => response.json()).then((response: { status: string; data?: Capabilities; message: string }) => {
      if (cancelled) return
      if (response.status !== 'ok' || !response.data) throw new Error(response.message)
      setCapabilities(response.data)
    }).catch(reason => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true }
  }, [])
  return <Context.Provider value={capabilities}>
    {error && <Alert severity="error">无法读取模块能力：{error}</Alert>}
    {capabilities?.demo && <Box p={1}><Alert severity="warning">演示模式：Modem 数据由测试样本提供，控制操作不会访问真实硬件。系统资源为本机数据。</Alert></Box>}
    {children}
  </Context.Provider>
}
