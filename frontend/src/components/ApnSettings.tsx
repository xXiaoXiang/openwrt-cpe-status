import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Divider, MenuItem, Stack, TextField, Typography } from '@mui/material'
import { SimCard } from '@mui/icons-material'
import { request } from '../api/request'
import { useCapabilities } from '../contexts/CapabilitiesContext'
import { validateApnSettings, type ApnSettings as Settings, type ApnStatus } from '../../../shared/apn-settings.ts'
import type { ApiResponse } from '../../../shared/adapter.ts'

export default function ApnSettings() {
  const writable = useCapabilities()?.writes_enabled === true
  const [status, setStatus] = useState<ApnStatus>()
  const [form, setForm] = useState<Settings>()
  const [saving, setSaving] = useState(false), [reading, setReading] = useState(false)
  const [notice, setNotice] = useState<{ severity: 'error' | 'info' | 'success'; text: string }>()
  const active = useRef(true), pending = useRef(false), dirty = useRef(false), writing = useRef(false)
  const read = useCallback(async (refresh = false) => {
    if (pending.current) return
    pending.current = true
    if (refresh) setReading(true)
    try {
      const result = await request<ApiResponse<ApnStatus> & { refreshing?: boolean }>(refresh ? '/apn/refresh' : '/apn')
      if (!active.current) return
      if (result.data) {
        setStatus(result.data)
        if (!dirty.current && !writing.current) setForm(result.data.settings)
      }
      if (result.status === 'error') setNotice({ severity: 'error', text: result.message })
      return result.refreshing
    } catch (error) { if (active.current) setNotice({ severity: 'error', text: String(error) }) }
    finally { pending.current = false; if (active.current) setReading(false) }
  }, [])
  const reload = useCallback(async () => {
    let refreshing = await read(true)
    for (let i = 0; i < 8 && refreshing && active.current; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      if (active.current) refreshing = await read()
    }
  }, [read])
  useEffect(() => {
    active.current = true
    if (writable) void reload()
    return () => { active.current = false }
  }, [reload, writable])
  useEffect(() => {
    if (!saving) return
    const timer = setInterval(() => void read(), 1500)
    return () => clearInterval(timer)
  }, [saving, read])
  const update = (key: keyof Settings, value: string) => {
    dirty.current = true
    setForm(current => current ? { ...current, [key]: value } : current)
  }
  const save = async () => {
    if (!form || writing.current || !writable) return
    let target: Settings
    try { target = validateApnSettings(form) } catch (error) { setNotice({ severity: 'error', text: String(error) }); return }
    writing.current = true; setSaving(true); setNotice(undefined)
    try {
      const result = await request<ApiResponse<ApnStatus>>('/apn', { method: 'POST', body: JSON.stringify(target) })
      if (!active.current) return
      if (result.data) setStatus(result.data)
      if (result.status === 'ok') dirty.current = false
      setNotice({ severity: result.status === 'ok' ? 'success' : result.status === 'deferred' ? 'info' : 'error', text: result.message })
    } catch (error) { if (active.current) setNotice({ severity: 'error', text: String(error) }) }
    finally { writing.current = false; if (active.current) { setSaving(false); void reload() } }
  }
  return <Card variant="outlined" data-apn-settings><CardContent><Stack spacing={2.5}>
    <Box display="flex" alignItems="center" gap={1}><SimCard color="primary" /><Typography variant="h6" flex={1}>APN 配置</Typography><Button disabled={!writable || saving || reading} onClick={() => { dirty.current = false; void reload() }}>读取配置</Button></Box>
    <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center" data-active-apn>
      <Typography variant="body2">当前APN</Typography>
      {status?.sampled_at ? <Chip size="small" label={status.active ? '已激活' : '未激活'} color={status.active ? 'success' : 'default'} /> : <CircularProgress size={16} aria-label="读取APN" />}
      {status?.active && <><Chip size="small" variant="outlined" label={`APN: ${status.active_apn || '—'}`} /><Chip size="small" variant="outlined" label={`协议: ${{ IP: 'IPv4', IPV6: 'IPv6', IPV4V6: 'IPv4/IPv6' }[status.active_protocol?.toUpperCase() || ''] || status.active_protocol || '—'}`} /></>}
    </Stack>
    <Divider />
    {notice && <Alert severity={notice.severity} onClose={() => setNotice(undefined)}>{notice.text}</Alert>}
    {form && <>
      <TextField label="APN 名称" value={form.apn} fullWidth disabled={saving} onChange={event => update('apn', event.target.value)} helperText="运营商提供的接入点名称" />
      <TextField select label="IP 协议" value={form.pdptype} fullWidth disabled={saving} onChange={event => update('pdptype', event.target.value)}><MenuItem value="ipv4">IPv4</MenuItem><MenuItem value="ipv6">IPv6</MenuItem><MenuItem value="ipv4v6">IPv4v6（双栈）</MenuItem></TextField>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
        <TextField label="用户名" value={form.username} fullWidth disabled={saving} onChange={event => update('username', event.target.value)} placeholder="可选" autoComplete="off" />
        <TextField label="密码" type="password" value={form.password} fullWidth disabled={saving} onChange={event => update('password', event.target.value)} placeholder="可选" autoComplete="new-password" />
      </Box>
      <TextField select label="认证方式" value={form.auth} fullWidth disabled={saving} onChange={event => update('auth', event.target.value)}><MenuItem value="none">无</MenuItem><MenuItem value="pap">PAP</MenuItem><MenuItem value="chap">CHAP</MenuItem><MenuItem value="both">PAP / CHAP</MenuItem></TextField>
      <Button variant="contained" size="large" disabled={!writable || saving || !form.apn} onClick={() => void save()} startIcon={saving ? <CircularProgress size={18} /> : undefined}>保存APN</Button>
    </>}
    {!!status?.logs?.length && <Box data-apn-logs><Typography variant="subtitle2" mb={1}>拨号日志</Typography><Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto', fontSize: '0.8rem' }}>{status.logs.join('\n')}</Box></Box>}
  </Stack></CardContent></Card>
}
