import { useCapabilities } from '@/contexts/CapabilitiesContext'
/*
 * @Author: 1orz cloudorzi@gmail.com
 * @Date: 2025-12-10 10:16:54
 * @LastEditors: 1orz cloudorzi@gmail.com
 * @LastEditTime: 2025-12-13 12:44:28
 * @FilePath: /udx710-backend/frontend/src/pages/Dashboard/components/QuickControls.tsx
 * @Description:
 *
 * Copyright (c) 2025 by 1orz, All Rights Reserved.
 */
import { useState } from 'react'
import { Box, Typography, Switch, Chip, CircularProgress, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Button } from '@mui/material'
import NetworkModeControl from '@/components/NetworkModeControl'
import { NetworkCheck, FlightTakeoff, TravelExplore, Tune } from '@mui/icons-material'
import type { AirplaneModeResponse, RoamingResponse } from '@/api/types'
import type { PendingControl } from '../hooks/useDashboardData'

interface QuickControlsProps {
  dataStatus: boolean | null
  airplaneMode: AirplaneModeResponse | null
  roaming: RoamingResponse | null
  pendingControl: PendingControl | null
  onToggleData: (target: boolean) => void
  onToggleAirplaneMode: (target: boolean) => void
  onToggleRoaming: (target: boolean) => void
}

export function QuickControls({
  dataStatus,
  airplaneMode,
  roaming,
  pendingControl,
  onToggleData,
  onToggleAirplaneMode,
  onToggleRoaming,
}: QuickControlsProps) {
  const capabilities = useCapabilities()
  const registrationRoaming = capabilities?.roaming_scope === 'registration'
  const roamingLabel = registrationRoaming ? '网络漫游' : '数据漫游'
  const [confirmation, setConfirmation] = useState<PendingControl | null>(null)
  const action = confirmation?.target ? '开启' : '关闭'
  const confirmationMessage = confirmation?.control === 'data'
    ? `确认是否${action}数据连接？`
    : confirmation?.control === 'roaming'
      ? registrationRoaming
        ? `要${action}漫游吗？${confirmation.target ? '这将允许任意网络漫游，可能产生漫游费用！' : '关闭后仅允许归属网络，可能断开当前漫游连接！'}设置会自动保存。`
        : `要${action}漫游吗？${confirmation.target ? '这可能会造成漫游费用！' : '这会断开数据漫游连接！'}`
      : `确认${action}飞行模式？`
  const confirm = () => {
    if (!confirmation || pendingControl) return
    const { control, target } = confirmation
    setConfirmation(null)
    if (control === 'data') onToggleData(target)
    else if (control === 'roaming') onToggleRoaming(target)
    else onToggleAirplaneMode(target)
  }
  const progress = (control: PendingControl['control']) => pendingControl?.control === control && (
    <Box role="status" aria-label="正在处理" display="flex" alignItems="center">
      <CircularProgress size={14} aria-label="正在处理" />
    </Box>
  )
  return (
    <>
      <Box sx={{ containerType: 'inline-size' }}>
        <Box display="flex" alignItems="center" gap={1} mb={1}>
          <Tune color="primary" />
          <Typography variant="subtitle2" color="text.secondary">
            快捷控制
          </Typography>
          {capabilities?.status_only && !capabilities.writes_enabled && <Chip size="small" variant="outlined" label="只读状态" />}
        </Box>
        <Box data-quick-controls-grid sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', columnGap: 1.5, rowGap: 1.5, '& .MuiTypography-body2': { fontSize: '0.8rem' }, '& .MuiSvgIcon-root': { fontSize: 20 }, '@container (min-width: 390px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } }}>
          <Box data-quick-control="data" aria-busy={pendingControl?.control === 'data'} display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={0.5}>
            <Box display="flex" alignItems="center" gap={1}>
              <NetworkCheck color={dataStatus ? 'success' : 'disabled'} />
              <Typography variant="body2">数据连接</Typography>
            </Box>
            <Box display="flex" alignItems="center" gap={0.5} sx={{ ml: 'auto', flexShrink: 0 }}>
              {progress('data')}
              {capabilities?.status_only && !capabilities.data_control ? <Typography color="text.secondary">-</Typography> :
              <Switch
                slotProps={{ input: { 'aria-label': '数据连接' } }}
                checked={dataStatus ?? false}
                onChange={(_, target) => setConfirmation({ control: 'data', target })}
                color="success"
                size="small"
                disabled={!capabilities?.data_control || !capabilities?.writes_enabled || dataStatus === null || airplaneMode?.enabled === true || !!pendingControl || !!confirmation}
              />
              }
            </Box>
          </Box>

          <Box data-quick-control="roaming" aria-busy={pendingControl?.control === 'roaming'} display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={0.5}>
            <Box display="flex" alignItems="center" gap={1}>
              <TravelExplore color={roaming?.roaming_allowed ? 'info' : 'disabled'} />
              <Typography variant="body2">{roamingLabel}</Typography>
              {roaming?.roam_pref === 3 && <Chip size="small" variant="outlined" label="仅附属网络" />}
              {roaming?.is_roaming && (
                <Chip label="漫游中" size="small" color="warning" sx={{ height: 18, fontSize: '0.65rem' }} />
              )}
            </Box>
            <Box display="flex" alignItems="center" gap={0.5} sx={{ ml: 'auto', flexShrink: 0 }}>
              {progress('roaming')}
              {capabilities?.status_only && !capabilities.roaming_policy ? <Typography color="text.secondary">-</Typography> :
              <Switch
                slotProps={{ input: { 'aria-label': roamingLabel } }}
                checked={roaming?.roaming_allowed ?? false}
                onChange={(_, target) => setConfirmation({ control: 'roaming', target })}
                color="info"
                size="small"
                disabled={!capabilities?.roaming_policy || !capabilities?.writes_enabled || typeof roaming?.roaming_allowed !== 'boolean' || !!pendingControl || !!confirmation}
              />
              }
            </Box>
          </Box>

          <Box data-quick-control="airplane" aria-busy={pendingControl?.control === 'airplane'} display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={0.5}>
            <Box display="flex" alignItems="center" gap={1}>
              <FlightTakeoff color={airplaneMode?.enabled ? 'warning' : 'disabled'} />
              <Typography variant="body2">飞行模式</Typography>
            </Box>
            <Box display="flex" alignItems="center" gap={0.5} sx={{ ml: 'auto', flexShrink: 0 }}>
              {progress('airplane')}
              {capabilities?.status_only && !capabilities.airplane_control ? <Typography color="text.secondary">-</Typography> :
              <Switch
                slotProps={{ input: { 'aria-label': '飞行模式' } }}
                checked={airplaneMode?.enabled ?? false}
                onChange={(_, target) => setConfirmation({ control: 'airplane', target })}
                color="warning"
                size="small"
                disabled={!capabilities?.writes_enabled || capabilities?.airplane_control === false || !airplaneMode || !!pendingControl || !!confirmation}
              />
              }
            </Box>
          </Box>
          <NetworkModeControl />
        </Box>
      </Box>
      <Dialog open={confirmation !== null} onClose={() => setConfirmation(null)}
        aria-labelledby="quick-control-confirm-title" aria-describedby="quick-control-confirm-message">
        <DialogTitle id="quick-control-confirm-title">操作确认</DialogTitle>
        <DialogContent>
          <DialogContentText id="quick-control-confirm-message">{confirmationMessage}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button aria-label="取消快捷控制操作" onClick={() => setConfirmation(null)} autoFocus>取消</Button>
          <Button aria-label="确认快捷控制操作" onClick={confirm} disabled={!!pendingControl}>确认</Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
