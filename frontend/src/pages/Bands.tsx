import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Paper, Stack, Typography } from '@mui/material'
import { Refresh, SettingsInputAntenna } from '@mui/icons-material'
import { request } from '../api/request'
import { useCapabilities } from '../contexts/CapabilitiesContext'
import { bandGroups, type BandState, type BandSelection } from '../../../shared/bands.ts'
import type { ApiResponse } from '../../../shared/adapter.ts'
import CellLockPanel from '../components/CellLockPanel'
import { operationSupported } from '../../../shared/availability.ts'

export default function Bands() {
  const capabilities = useCapabilities()
  const profile = capabilities?.modem_profile
  const readableGroup = (key: string) => !profile || (operationSupported(profile, 'bandCapabilities') && operationSupported(profile, profile.bandOperations[key]?.read || ''))
  const writableGroup = (key: string) => readableGroup(key) && (!profile || operationSupported(profile, profile.bandOperations[key]?.write || ''))
  const [unavailable, setUnavailable] = useState(false)
  const [state, setState] = useState<BandState>()
  const [draft, setDraft] = useState<BandSelection>()
  const [busy, setBusy] = useState(false)
  const [cellBusy, setCellBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [notice, setNotice] = useState<{ severity: 'info' | 'error' | 'success'; text: string }>()
  const [reading, setReading] = useState(true)
  const mounted = useRef(true)
  const pending = useRef(false)
  const editing = useRef(false)
  const writing = useRef(false)
  const revision = useRef(0)
  const writable = capabilities?.writes_enabled === true

  const read = useCallback(async () => {
    if (pending.current || writing.current) return
    pending.current = true
    setReading(true)
    const started = revision.current
    try {
      // Finish this explicit read, including a cold asynchronous cache fill.
      // Once it succeeds there is no periodic band-preference polling.
      for (let attempt = 0; attempt < 15 && mounted.current; attempt++) {
      const result = await request<ApiResponse<BandState>>('/band-lock')
      if (!mounted.current || started !== revision.current) return
      if (result.status === 'unsupported') { setUnavailable(true); setNotice(undefined); break }
      if (result.data) {
        setState(result.data)
        // A manual read must not erase unsaved choices.
        if (!editing.current) setDraft(structuredClone(result.data.enabled))
      }
      if (result.status === 'ok' && result.data && !result.data.stale) { setNotice(previous => previous?.severity === 'info' ? undefined : previous); break }
      if (result.status === 'error') { setNotice({ severity: 'error', text: result.message || '读取频段失败' }); break }
      if (attempt === 14) { setNotice({ severity: 'info', text: '模块暂忙，可稍后手动读取频段设置' }); break }
      await new Promise(resolve => window.setTimeout(resolve, 2000))
      }
    } catch (error) { if (mounted.current) { setNotice({ severity: 'error', text: String(error) }); setReading(false) } }
    finally { pending.current = false; if (mounted.current) setReading(false) }
  }, [])

  useEffect(() => {
    mounted.current = true
    void read()
    return () => { mounted.current = false }
  }, [read])

  const changed = !!draft && !!state && bandGroups.some(group => writableGroup(group.key) && draft[group.key].join(':') !== state.enabled[group.key].join(':'))
  const valid = !!draft && !!state && bandGroups.every(group => !writableGroup(group.key) || (draft[group.key].length > 0 && draft[group.key].every(band => state.supported[group.key].includes(band))))
  const apply = async () => {
    if (!draft || !writable || busy) return
    const selected = structuredClone(draft)
    for (const group of bandGroups) if (!readableGroup(group.key)) selected[group.key] = []
    setConfirm(false); setBusy(true); writing.current = true; revision.current++; setNotice(undefined)
    try {
      const result = await request<ApiResponse<BandState>>('/band-lock', { method: 'POST', body: JSON.stringify(selected) })
      if (!mounted.current) return
      if (result.data) { setState(result.data); setDraft(structuredClone(result.data.enabled)); editing.current = false }
      setNotice({ severity: result.status === 'ok' ? 'success' : result.status === 'deferred' ? 'info' : 'error', text: result.message || '请重新读取模块确认频段状态' })
    } catch (error) { if (mounted.current) setNotice({ severity: 'error', text: String(error) }) }
    finally { writing.current = false; if (mounted.current) setBusy(false) }
  }

  return <Stack spacing={2} data-band-settings>
    <Box display="flex" alignItems="center" gap={1} flexWrap="wrap">
      <SettingsInputAntenna color="primary" /><Typography variant="h6" sx={{ flex: 1 }}>频段与小区设置</Typography>
      {state && <Chip size="small" label={state.model} />}
      <Button startIcon={reading ? <CircularProgress size={16} /> : <Refresh />} disabled={busy || reading || cellBusy} onClick={() => void read()}>读取设置</Button>
    </Box>
    <Typography variant="body2" color="text.secondary">选择模块允许使用的频段，可多选。选择全部表示取消该组频段限制。</Typography>
    {notice && <Alert severity={notice.severity}>{notice.text}</Alert>}
    {!writable && capabilities && <Alert severity="info">当前 LuCI 会话为只读，无法修改频段。</Alert>}
    {!state && !unavailable && <Box py={3} textAlign="center">{reading && <CircularProgress size={24} />}<Typography>等待读取模块频段</Typography></Box>}
    {(state && draft || unavailable) && bandGroups.map(group => !readableGroup(group.key) || !state || !draft ? <Paper key={group.key} sx={{ p: 2 }} variant="outlined" data-band-group={group.key}><Typography fontWeight={600}>{group.label}</Typography><Typography color="text.secondary">-</Typography></Paper> : <Paper key={group.key} sx={{ p: 2 }} variant="outlined" data-band-group={group.key}>
      <Box display="flex" alignItems="center" gap={1} flexWrap="wrap" mb={1}>
        <Typography fontWeight={600} sx={{ flex: { xs: '1 0 100%', sm: 1 } }}>{group.label}</Typography>
        <Typography variant="caption" color="text.secondary">已选 {draft[group.key].length} / {state.supported[group.key].length}</Typography>
        <Button size="small" disabled={!writable || busy || !writableGroup(group.key)} onClick={() => { editing.current = true; setDraft({ ...draft, [group.key]: [...state.supported[group.key]] }) }}>全选</Button>
        <Button size="small" disabled={!writable || busy || !writableGroup(group.key)} onClick={() => { editing.current = true; setDraft({ ...draft, [group.key]: [] }) }}>清空</Button>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>模块当前：{state.enabled[group.key].map(band => group.prefix + band).join(' · ')}</Typography>
      <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(82px, 1fr))" gap={0.25} mt={1}>
        {[...new Set([...state.supported[group.key], ...state.enabled[group.key]])].sort((a, b) => a - b).map(band => <FormControlLabel key={band} sx={{ m: 0 }} label={group.prefix + band} control={<Checkbox size="small" checked={draft[group.key].includes(band)} disabled={!writable || busy || !writableGroup(group.key) || !state.supported[group.key].includes(band)} onChange={(_, checked) => {
          editing.current = true
          setDraft({ ...draft, [group.key]: (checked ? [...draft[group.key], band] : draft[group.key].filter(value => value !== band)).sort((a, b) => a - b) })
        }} />} />)}
      </Box>
      {writableGroup(group.key) && !draft[group.key].length && <Typography color="error" variant="caption">至少保留一个频段</Typography>}
    </Paper>)}
    {state && <Box display="flex" gap={1} flexWrap="wrap" alignItems="center">
      <Button variant="contained" disabled={!writable || busy || cellBusy || !changed || !valid || !!state.stale} onClick={() => setConfirm(true)} startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>应用频段设置</Button>
      <Button disabled={busy || !changed} onClick={() => { editing.current = false; setDraft(structuredClone(state.enabled)) }}>取消修改</Button>
      <Typography variant="caption" color="text.secondary">{state.stale ? '保留上次结果，正在刷新模块状态…' : '模块回读时间：' + new Date(state.sampled_at * 1000).toLocaleTimeString()}</Typography>
    </Box>}
    <Dialog open={confirm} onClose={() => setConfirm(false)} fullWidth maxWidth="sm">
      <DialogTitle>确认应用频段设置？</DialogTitle>
      <DialogContent><Typography mb={2}>网络可能短暂断开并重新注册。仅在模块回读确认后更新当前设置。</Typography>
        {draft && bandGroups.map(group => <Typography key={group.key} variant="body2" mb={1} sx={{ overflowWrap: 'anywhere' }}>{group.label}：{draft[group.key].map(band => group.prefix + band).join('、')}</Typography>)}
      </DialogContent>
      <DialogActions><Button onClick={() => setConfirm(false)}>取消</Button><Button variant="contained" onClick={() => void apply()}>确认应用</Button></DialogActions>
    </Dialog>
    <CellLockPanel onBusy={setCellBusy} disabled={busy} />
  </Stack>
}
