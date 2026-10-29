import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField, Typography } from '@mui/material'
import { request } from '../api/request'
import { useCapabilities } from '../contexts/CapabilitiesContext'
import { networkModes } from '../../../shared/radio-settings.ts'
import type { ApiResponse } from '../../../shared/adapter.ts'
import { SettingsInputAntenna } from '@mui/icons-material'
import { operationSupported, parameterSupported } from '../../../shared/availability.ts'
import { modemActivity } from '../api/modemActivity'

export default function NetworkModeControl() {
  const capabilities = useCapabilities()
  const profile = capabilities?.modem_profile
  const unavailable = !!profile && !operationSupported(profile, 'mode')
  const writable = !profile || operationSupported(profile, 'modeSet')
  const [current, setCurrent] = useState('')
  const [selection, setSelection] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ status: string; message: string }>()
  const active = useRef(true), writing = useRef(false), reading = useRef(false), revision = useRef(0)
  const read = useCallback(async () => {
    if (writing.current || reading.current || modemActivity.isPaused()) return
    reading.current = true
    const started = revision.current
    try {
      const result = await request<ApiResponse<{ mode: string }>>('/network-mode')
      if (active.current && started === revision.current && result.status === 'ok' && result.data?.mode) setCurrent(result.data.mode)
    } catch { /* Preserve last confirmed value during a reconnect. */ }
    finally { reading.current = false }
  }, [])
  useEffect(() => {
    active.current = true
    if (unavailable) return () => { active.current = false }
    void read()
    const timer = window.setInterval(() => { if (!document.hidden) void read() }, 2000)
    return () => { active.current = false; window.clearInterval(timer) }
  }, [read, unavailable])
  const apply = async () => {
    if (!selection || writing.current || (profile && !parameterSupported(profile, 'modeSet', 'mode', selection))) return
    const mode = selection
    setSelection(undefined); setBusy(true); writing.current = true; revision.current++; setNotice(undefined)
    try {
      const result = await request<ApiResponse<{ mode: string }>>('/network-mode', { method: 'POST', body: JSON.stringify({ mode }) })
      if (!active.current) return
      if (result.data?.mode) setCurrent(result.data.mode)
      if (result.status !== 'ok') setNotice({ status: result.status, message: result.message })
    } catch (error) { if (active.current) setNotice({ status: 'error', message: String(error) }) }
    finally { writing.current = false; if (active.current) setBusy(false) }
  }
  return <Box data-network-mode sx={{ minWidth: 0 }}>
    <Box display="flex" alignItems="center" justifyContent="space-between" gap={1} minHeight={30}>
    <Box display="flex" alignItems="center" gap={1} flexShrink={0}><SettingsInputAntenna color="primary" /><Typography variant="body2">网络模式</Typography></Box>
    <Box display="flex" alignItems="center" gap={0.75} flexShrink={0}>
    {busy && <Box component="span" display="flex" alignItems="center" justifyContent="center" sx={{ width: 16, height: 16, flexShrink: 0 }}>
      <CircularProgress size={15} aria-label="正在切换网络模式" sx={{ flexShrink: 0 }} />
    </Box>}
    <TextField select size="small" value={unavailable ? '-' : current} disabled={unavailable || !writable || !current || busy || capabilities?.writes_enabled !== true}
      sx={{ width: 100, minWidth: 76, '& .MuiSelect-select': { fontSize: '0.7rem', py: 0.75, pl: 1, pr: '24px !important' } }}
      onChange={event => { if (event.target.value !== current) setSelection(event.target.value) }}
      slotProps={{ select: { native: false, inputProps: { 'aria-label': '网络模式' }, renderValue: value => ({ AUTO: 'Auto', 'LTE:NR5G': 'LTE/5G NR', LTE: 'LTE Only', NR5G: '5G Only', 'WCDMA:LTE': '3G/LTE', WCDMA: '3G Only' }[String(value)] || String(value)) } }}>
      {unavailable && <MenuItem value="-">-</MenuItem>}
      {!unavailable && !current && <MenuItem value="">读取中…</MenuItem>}
      {current && !networkModes.some(mode => mode.value === current) && <MenuItem value={current}>{current}</MenuItem>}
      {networkModes.map(mode => {
        const supported = !profile || parameterSupported(profile, 'modeSet', 'mode', mode.value)
        return <MenuItem key={mode.value} value={mode.value} disabled={!supported}>{mode.label}{!supported && ' · -'}</MenuItem>
      })}
    </TextField>
    </Box>
    </Box>
    {notice && <Alert severity={notice.status === 'ok' ? 'success' : notice.status === 'deferred' ? 'info' : 'error'} sx={{ mt: 1 }} onClose={() => setNotice(undefined)}>{notice.message}</Alert>}
    <Dialog open={selection !== undefined} onClose={() => !busy && setSelection(undefined)} fullWidth maxWidth="sm">
      <DialogTitle>确认切换网络模式？</DialogTitle>
      <DialogContent><Typography>将设置为 {networkModes.find(mode => mode.value === selection)?.label}，网络可能断开并重新注册。</Typography>
        {selection === 'NR5G' && <Alert severity="warning" sx={{ mt: 2 }}>5G Only 需要运营商及 SIM 支持 SA。NSA 依赖 LTE 锚点，应使用自动或 LTE/5G NR。</Alert>}
        <Typography variant="caption" display="block" mt={1}>保留现有频段、小区锁定设置，不自动重启模块。</Typography>
      </DialogContent>
      <DialogActions><Button onClick={() => setSelection(undefined)}>取消</Button><Button variant="contained" onClick={() => void apply()}>确认切换</Button></DialogActions>
    </Dialog>
  </Box>
}
