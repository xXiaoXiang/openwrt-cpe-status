import { useEffect, useState } from 'react'
import { Alert, Box, Typography } from '@mui/material'
import { request } from '../api/request'
import { usesSnapshotTransport } from '../api/transport'
import { modemActivity } from '../api/modemActivity'
import type { ApiResponse } from '../api/types'

export default function AutoApnStatus() {
  const [state, setState] = useState<{ status: string; message: string; apn?: string; carrier?: string }>()
  useEffect(() => {
    if (!usesSnapshotTransport()) return
    let stopped = false
    const read = async () => {
      if (modemActivity.isPaused()) return
      try {
        const value = await request<ApiResponse<NonNullable<typeof state>>>('/wwan-management')
        if (!stopped && value.status === 'ok') setState(value.data)
      } catch { /* Keep the last known management state. */ }
    }
    void read(); const timer = window.setInterval(() => { void read() }, 5000)
    return () => { stopped = true; clearInterval(timer) }
  }, [])
  if (!state) return null
  return <Box sx={{ mt: 1 }}>
    {state.status === 'ready' ? <Typography variant="caption" color="text.secondary">APN：{state.apn} · {state.carrier}</Typography>
      : <Alert severity={state.status === 'error' || state.status === 'unmatched' ? 'warning' : 'info'} sx={{ py: 0 }}>{state.message}</Alert>}
  </Box>
}
