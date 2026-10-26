import { useEffect, useState } from 'react'
import { Alert, Box, Button, TextField } from '@mui/material'
import { request } from '../api/request'
import type { ApiResponse } from '../api/types'
import { useCapabilities } from '../contexts/CapabilitiesContext'

export default function SmsStorage() {
  const capability = useCapabilities()
  const [path, setPath] = useState('/etc/cpe-status/sms'), [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string }>()
  useEffect(() => {
    if (capability?.id !== 'quectel-status-lite') return
    void request<ApiResponse<{ path: string }>>('/sms/storage').then(value => { if (value.data?.path) setPath(value.data.path) }).catch(() => {})
  }, [capability?.id])
  if (capability?.id !== 'quectel-status-lite') return null
  const save = async () => {
    setBusy(true); setNotice(undefined)
    try {
      const value = await request<ApiResponse<{ path: string }>>('/sms/storage', { method: 'POST', body: JSON.stringify({ path }) })
      if (value.status !== 'ok') throw new Error(value.message)
      setPath(value.data!.path); setNotice({ error: false, text: '存储路径已保存，现有历史已复制到新目录' })
    } catch (reason) { setNotice({ error: true, text: String(reason) }) }
    finally { setBusy(false) }
  }
  return <Box sx={{ mb: 2 }}>
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <TextField size="small" label="短信历史存储目录" value={path} onChange={event => setPath(event.target.value)} disabled={busy}
        helperText="支持挂载磁盘，原历史保留。" sx={{ flex: 1, minWidth: 240 }} />
      <Button variant="outlined" disabled={busy || !capability.writes_enabled || !path} onClick={() => void save()}>{busy ? '保存中…' : '保存路径'}</Button>
    </Box>
    {notice && <Alert severity={notice.error ? 'error' : 'success'} onClose={() => setNotice(undefined)}>{notice.text}</Alert>}
  </Box>
}
