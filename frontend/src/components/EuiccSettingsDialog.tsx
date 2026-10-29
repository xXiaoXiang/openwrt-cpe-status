import { useEffect, useState } from 'react'
import { Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material'
import { backendFetch } from '../api/transport'

interface Settings {
  apdu: 'auto' | 'at' | 'at_csim' | 'uqmi' | 'qmi' | 'mbim' | 'stdio'
  http: 'auto' | 'curl' | 'stdio'
  at_device: string
  wdm_device: string
  slot: number
  tls_verify?: boolean
  effective_apdu?: string
  effective_http?: string
  ports?: { at: string[]; wdm: string[] }
}
const apduOptions = [['auto', '自动'], ['at', 'AT'], ['at_csim', 'AT+CSIM'], ['uqmi', 'UQMI'], ['qmi', 'QMI'], ['mbim', 'MBIM'], ['stdio', 'STDIO（AT Bridge）']]
export default function EuiccSettingsDialog({ open, canWrite, onClose, onSaved }: { open: boolean; canWrite: boolean; onClose: () => void; onSaved: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true); setError(null)
    void backendFetch('/api/euicc/settings').then(response => response.json()).then((response: { status: string; data?: Settings; message?: string }) => {
      if (cancelled) return
      if (response.status !== 'ok' || !response.data) throw new Error(response.message || '读取通信设置失败')
      setSettings(response.data)
    }).catch(reason => { if (!cancelled) setError(String(reason)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])
  const save = async () => {
    if (!settings || saving) return
    setSaving(true); setError(null)
    try {
      const { apdu, http, at_device, wdm_device, slot, tls_verify = true } = settings
      const response = await backendFetch('/api/euicc/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apdu, http, at_device, wdm_device, slot, tls_verify }) }).then(value => value.json()) as { status: string; message?: string }
      if (response.status !== 'ok') throw new Error(response.message || '保存通信设置失败')
      onClose(); onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSaving(false) }
  }
  const selected = settings?.apdu === 'auto' ? settings.effective_apdu : settings?.apdu
  const isAt = ['at', 'at_csim', 'stdio'].includes(selected || '')
  const key = isAt ? 'at_device' : 'wdm_device'
  const ports = [...new Set([settings?.[key] || (isAt ? '/dev/ttyUSB2' : '/dev/cdc-wdm0'), ...(settings?.ports?.[isAt ? 'at' : 'wdm'] || [])])]
  return <Dialog open={open} onClose={() => !saving && onClose()} fullWidth maxWidth="xs">
    <DialogTitle>卡片通信设置</DialogTitle>
    <DialogContent>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading ? <Stack alignItems="center" p={3}><CircularProgress size={24} /></Stack> : settings && <Stack spacing={2} sx={{ pt: 1 }}>
        <TextField select label="卡片通信模式" value={settings.apdu} onChange={event => setSettings({ ...settings, apdu: event.target.value as Settings['apdu'] })} disabled={saving}>
          {apduOptions.map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
        </TextField>
        <TextField select label="通信端口" value={settings[key]} onChange={event => setSettings({ ...settings, [key]: event.target.value })} disabled={saving}>
          {ports.map(port => <MenuItem key={port} value={port}>{port}</MenuItem>)}
        </TextField>
        {!isAt && <TextField select label="SIM 卡槽" value={settings.slot} onChange={event => setSettings({ ...settings, slot: Number(event.target.value) })} disabled={saving}>
          {[1, 2, 3, 4, 5].map(slot => <MenuItem key={slot} value={slot}>{slot}</MenuItem>)}
        </TextField>}
        <TextField select label="HTTP 方法" value={settings.http} onChange={event => setSettings({ ...settings, http: event.target.value as Settings['http'] })} disabled={saving}>
          <MenuItem value="auto">自动</MenuItem><MenuItem value="curl">Curl</MenuItem><MenuItem value="stdio">STDIO（Bridge）</MenuItem>
        </TextField>
        <Typography variant="caption" color="text.secondary">STDIO HTTP 由路由器连接下载服务器，可与 UQMI、MBIM 或 AT 搭配。</Typography>
        {(settings.http === 'stdio' || settings.http === 'auto' && settings.effective_http === 'stdio') && <>
          <TextField select label="HTTPS 证书校验" value={settings.tls_verify === false ? 'off' : 'on'} onChange={event => setSettings({ ...settings, tls_verify: event.target.value === 'on' })} disabled={saving}>
            <MenuItem value="on">开启（默认）</MenuItem><MenuItem value="off">关闭（兼容测试服务器）</MenuItem>
          </TextField>
          {settings.tls_verify === false && <Alert severity="warning">关闭后不校验下载服务器的 TLS 证书，仅在确认服务器可信时使用。</Alert>}
        </>}
      </Stack>}
    </DialogContent>
    <DialogActions><Button onClick={onClose} disabled={saving}>取消</Button><Button variant="contained" disabled={loading || saving || !settings || !canWrite} onClick={() => void save()} startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}>保存</Button></DialogActions>
  </Dialog>
}
