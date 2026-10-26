import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Tooltip, Typography, Tabs, Tab, IconButton } from '@mui/material'
import { Lock, LockOpen, Refresh } from '@mui/icons-material'
import { parseCellScan, type CellScanResponse } from '../../../shared/cell-scan.ts'
import { useRefreshInterval } from '../contexts/RefreshContext'
import { useAdaptivePolling } from '../hooks/useAdaptivePolling'
import { request } from '../api/request'
import { useCapabilities } from '../contexts/CapabilitiesContext'
import { CellInfo } from '../pages/Dashboard/components/CellInfo'
import { cellTarget, cellLockParams, cellLockCommand, type CellLockRequest, type CellLockState } from '../../../shared/radio-settings.ts'
import type { ApiResponse } from '../../../shared/adapter.ts'
import type { CellsResponse } from '../api/types'

export default function CellLockPanel({ onBusy, disabled = false }: { onBusy?: (busy: boolean) => void; disabled?: boolean }) {
  const { refreshInterval, refreshKey } = useRefreshInterval()
  const [view, setView] = useState(0)
  const [scanCells, setScanCells] = useState<CellsResponse | null>(null)
  const capabilities = useCapabilities()
  const [cells, setCells] = useState<CellsResponse | null>(null)
  const [locks, setLocks] = useState<CellLockState>()
  const [confirmation, setConfirmation] = useState<CellLockRequest>()
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [notice, setNotice] = useState<{ severity: 'info' | 'error' | 'success'; text: string }>()
  const active = useRef(true), reading = useRef(false), writing = useRef(false), revision = useRef(0)
  const writable = capabilities?.writes_enabled === true
  const readLocks = useCallback(async (force = false) => {
    const started = revision.current
    for (let attempt = 0; attempt < 12 && active.current; attempt++) {
      const result = await request<ApiResponse<CellLockState>>(force && attempt === 0 ? '/cell-lock/refresh' : '/cell-lock')
      if (!active.current || started !== revision.current) return
      if (result.data) setLocks(result.data)
      if (result.status === 'error' || (result.status === 'ok' && result.data && !result.data.stale)) return result
      await new Promise(resolve => window.setTimeout(resolve, 2000))
    }
  }, [])
  const readScan = useCallback(async (restore = true) => {
    const started = revision.current
    const result = await request<CellScanResponse>('/cell-scan')
    if (!active.current || started !== revision.current) return result
    // While a new job runs, data is the previous scan's successful result.
    // Do not present that old list as the result of the pending scan.
    if (result.data && restore && !result.scanning && result.status === 'ok') { setScanCells(parseCellScan(result.data.raw, result.data.records)) }
    setScanning(result.scanning === true)
    if (result.message && (restore || result.scanning)) setNotice({ severity: result.status === 'ok' ? 'success' : result.status === 'error' ? 'error' : 'info', text: result.message })
    return result
  }, [])
  const read = useCallback(async () => {
    if (reading.current || writing.current) return
    reading.current = true
    const started = revision.current
    try {
    const readDefault = async () => {
      let running = false
      try { running = (await readScan(false)).scanning === true } catch { /* File polling must not block the shared snapshot. */ }
      if (!running) {
        // Default to the shared dashboard snapshot, even when an older full
        // scan exists. Resume only an actually running scan across navigation.
        for (let attempt = 0; attempt < 12 && active.current && started === revision.current; attempt++) {
          const live = await request<ApiResponse<CellsResponse>>('/cells')
          if (!active.current || started !== revision.current) break
          if (live.data) { setCells(live.data) }
          if (live.status === 'ok' && live.data) break
          if (live.status === 'error') { setNotice({ severity: 'error', text: live.message }); break }
          await new Promise(resolve => window.setTimeout(resolve, 2000))
        }
      }
    }
    const results = await Promise.allSettled([readDefault(), readLocks()])
    for (const result of results) if (result.status === 'rejected' && active.current && started === revision.current) setNotice({ severity: 'error', text: String(result.reason) })
    } catch (error) { if (active.current) setNotice({ severity: 'error', text: String(error) }) }
    finally { reading.current = false }
  }, [readScan, readLocks])
  useEffect(() => {
    active.current = true; void read()
    return () => { active.current = false }
  }, [read])
  useEffect(() => { onBusy?.(busy || scanning) }, [busy, scanning, onBusy])
  useEffect(() => {
    if (!scanning) return
    // Poll only the active job's result file; never refresh the cell list via
    // QENG or resubmit QSCAN. Stop as soon as the job has finished.
    let pending = false
    const timer = window.setInterval(async () => {
      if (pending) return
      pending = true
      try { await readScan() } catch (error) { if (active.current) { setScanning(false); setNotice({ severity: 'error', text: String(error) }) } }
      finally { pending = false }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [scanning, readScan])
  const scan = async () => {
    if (!writable || busy || scanning || disabled) return
    revision.current++; setScanning(true); setNotice(undefined)
    try {
      const result = await request<CellScanResponse>('/cell-scan', { method: 'POST', body: '{}' })
      if (!active.current) return
      setScanning(result.scanning === true)
      setNotice({ severity: result.scanning || result.status === 'deferred' ? 'info' : result.status === 'ok' ? 'success' : 'error', text: result.message || '正在扫描 LTE / NR 小区，保留当前列表' })
    } catch (error) { if (active.current) { setScanning(false); setNotice({ severity: 'error', text: String(error) }) } }
  }
  const readCurrent = async () => {
    if (reading.current || busy || scanning || disabled) return
    reading.current = true
    const started = revision.current
    try {
      const result = await request<ApiResponse<CellsResponse>>('/cells')
      if (!active.current || started !== revision.current) return
      if (result.data) { setCells(result.data) }
      if (result.status !== 'ok') setNotice({ severity: result.status === 'error' ? 'error' : 'info', text: result.message || '模块暂忙，请稍后重试' })
    } catch (error) { if (active.current) setNotice({ severity: 'error', text: String(error) }) }
    finally { reading.current = false }
  }
  useAdaptivePolling({ refreshInterval: view === 0 && !busy && !scanning && !disabled ? refreshInterval : 0, refreshKey, onTick: () => view === 0 ? readCurrent() : undefined })
  const apply = async () => {
    if (!confirmation || writing.current || !writable || disabled || scanning) return
    const target = structuredClone(confirmation)
    try { cellLockParams(target, capabilities?.modem_profile) } catch (error) { setNotice({ severity: 'error', text: String(error) }); return }
    setConfirmation(undefined); writing.current = true; revision.current++; setBusy(true); setNotice(undefined)
    try {
      const result = await request<ApiResponse<CellLockState>>('/cell-lock', { method: 'POST', body: JSON.stringify(target) })
      if (!active.current) return
      if (result.data) setLocks(result.data)
      setNotice({ severity: result.status === 'ok' ? 'success' : result.status === 'deferred' ? 'info' : 'error', text: result.message })
    } catch (error) { if (active.current) setNotice({ severity: 'error', text: String(error) }) }
    finally { writing.current = false; if (active.current) setBusy(false) }
  }
  const target = confirmation?.cell
  let command = ''
  if (confirmation && capabilities?.modem_profile) { try { command = cellLockCommand(capabilities.modem_profile, confirmation) } catch { /* Missing parameters remain in the dialog. */ } }
  const scsPattern = capabilities?.modem_profile?.commands.nrCellLockSet?.parameters?.scs
  const scsChoices = [15,30,60,120,240].filter(value => !scsPattern || new RegExp(`^(${scsPattern})$`).test(String(value)))
  let valid = false
  if (confirmation) { try { cellLockParams(confirmation, capabilities?.modem_profile); valid = true } catch { /* Dialog collects missing NR parameters. */ } }
  // Keep the last confirmed presentation while reads refresh or fail. Write
  // confirmation still requires fresh, exact readback in the API transport.
  const displayedLock = (rat: 'lte' | 'nr') => locks?.[rat]?.status === 'ok' ? locks[rat] : locks?.[rat]?.previous
  return <Stack spacing={1.5} data-cell-lock-panel>
    <Typography variant="h6">小区锁定</Typography>
    <Box data-cell-toolbar display="flex" gap={1} alignItems="center" flexWrap="wrap">
      {(['lte', 'nr'] as const).map(rat => {
        const displayed = displayedLock(rat)
        return <Box key={rat} display="flex" alignItems="center" gap={1} sx={{ mr: { xs: 1, sm: 4 } }}>
          <Chip size="small" color={displayed ? displayed.count ? 'warning' : 'success' : 'default'} label={`${rat.toUpperCase()}：${displayed ? displayed.count ? displayed.cells.map(cell => `${cell.arfcn}/${cell.pci}`).join(' · ') : '未锁定' : '状态未知'}`} />
          <Button size="small" startIcon={busy ? <CircularProgress size={14} /> : <LockOpen />} disabled={!writable || busy || scanning || disabled} onClick={() => setConfirmation({ action: 'unlock', rat })}>解除{rat.toUpperCase()}锁定</Button>
        </Box>
      })}
      <Button size="small" disabled={busy || scanning || disabled} onClick={() => void readLocks(true)}>读取锁定</Button>
    <Tabs value={view} onChange={(_, next: number) => setView(next)} sx={{ ml: 'auto', minHeight: 36, borderBottom: 1, borderColor: 'divider', '& .MuiTab-root': { minHeight: 36, py: 0.75, border: '1px solid', borderColor: 'divider', borderRadius: '8px 8px 0 0', ml: 0.5 }, '& .Mui-selected': { bgcolor: 'action.selected' } }}>
      <Tab label="当前及邻区" />
      <Tab label="全部小区信息" />
    </Tabs>
    </Box>
    {notice && <Alert severity={notice.severity} onClose={() => setNotice(undefined)}>{notice.text}</Alert>}
    <CellInfo cellsInfo={view === 0 ? cells : scanCells} showPlmn={view === 1} headerAction={<Tooltip title="刷新小区信息"><span><IconButton aria-label="刷新小区信息" size="small" disabled={busy || scanning || disabled || (view === 1 && !writable)} onClick={() => void (view === 0 ? readCurrent() : scan())}>{scanning ? <CircularProgress size={18} /> : <Refresh fontSize="small" />}</IconButton></span></Tooltip>} renderAction={cell => {
      const selected = cellTarget(cell)
      if (!selected) return <Typography variant="caption" color="text.secondary">参数缺失</Typography>
      const locked = displayedLock(selected.rat)?.cells.some(target => target.arfcn === selected.arfcn && target.pci === selected.pci)
      if (locked) {
        const label = `当前已锁定此小区：${selected.rat.toUpperCase()} 频点 ${selected.arfcn}，PCI ${selected.pci}`
        return <Tooltip title={label}><Box component="span" role="img" aria-label={label} tabIndex={0} data-cell-locked sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', verticalAlign: 'middle', px: 1, py: 0.5 }}><Lock color="primary" fontSize="small" /></Box></Tooltip>
      }
      const label = `锁定 ${cell.band ?? selected.rat.toUpperCase()} 小区：频点 ${selected.arfcn}，PCI ${selected.pci}`
      return <Tooltip title={label}><span><IconButton aria-label={label} size="small" disabled={!writable || busy || scanning || disabled} data-cell-lock-action onClick={() => setConfirmation({ action: 'lock', rat: selected.rat, cell: selected })}><LockOpen fontSize="small" /></IconButton></span></Tooltip>
    }} />
    <Dialog open={!!confirmation} onClose={() => setConfirmation(undefined)} fullWidth maxWidth="sm">
      <DialogTitle>{confirmation?.action === 'unlock' ? '确认解除小区锁定？' : '确认锁定这个小区？'}</DialogTitle>
      <DialogContent>
        <Typography>此操作可能导致网络断开。仅在模块回读与请求一致时显示成功。</Typography>
        {target?.rat === 'nr' && <>
          <Alert severity="info" sx={{ my: 2 }}>NR 锁定需要 Band 和 SCS；5G 锁定通常用于 SA。当前处于 NSA 也可提交，以模块回读确认结果。</Alert>
          <Box display="flex" gap={1} my={2}>
            <TextField size="small" label="NR Band" type="number" value={target.band ?? ''} onChange={event => setConfirmation({ ...confirmation!, cell: { ...target, band: Number(event.target.value) } })} />
            <TextField size="small" select fullWidth label="SCS（kHz）" value={target.scs_khz ?? ''} onChange={event => setConfirmation({ ...confirmation!, cell: { ...target, scs_khz: Number(event.target.value) } })}>
              {scsChoices.map(value => <MenuItem key={value} value={value}>{value} kHz</MenuItem>)}
            </TextField>
          </Box>
        </>}
        <Typography variant="body2" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere', mt: 2 }}>{command}</Typography>
        {target?.rat === 'nr' && target.pci === 0 && <Alert severity="warning" sx={{ mt: 1 }}>此固件 PCI=0 表示解除锁定，不能用该指令锁定 PCI 0。</Alert>}
      </DialogContent>
      <DialogActions><Button onClick={() => setConfirmation(undefined)}>取消</Button><Button variant="contained" disabled={!valid} onClick={() => void apply()}>确认执行</Button></DialogActions>
    </Dialog>
  </Stack>
}
