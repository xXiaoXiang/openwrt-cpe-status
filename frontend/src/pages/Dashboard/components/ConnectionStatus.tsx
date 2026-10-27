/*
 * @Author: 1orz cloudorzi@gmail.com
 * @Date: 2025-12-10 10:18:32
 * @LastEditors: 1orz cloudorzi@gmail.com
 * @LastEditTime: 2025-12-13 12:44:16
 * @FilePath: /udx710-backend/frontend/src/pages/Dashboard/components/ConnectionStatus.tsx
 * @Description:
 *
 * Copyright (c) 2025 by 1orz, All Rights Reserved.
 */
import { Box, Chip, Typography, Stack } from '@mui/material'
import { Close, Lan } from '@mui/icons-material'
import type { QosInfo, SystemStatsResponse } from '@/api/types'
import { useCapabilities } from '@/contexts/CapabilitiesContext'
import { useSensitiveVisibility } from '@/contexts/revealSensitive'
import { getSensitiveStyle } from '../utils'
import type { ConnectivityResult } from '../hooks/useDashboardData'

interface ConnectionStatusProps {
  qosInfo: QosInfo | null
  connectivity: ConnectivityResult | null
  connectionInfo?: SystemStatsResponse['connection']
}

export function ConnectionStatus({ qosInfo, connectivity, connectionInfo }: ConnectionStatusProps) {
  const capabilities = useCapabilities()
  const [showInfo] = useSensitiveVisibility()
  if (capabilities?.status_only) return <Box>
    <Box display="flex" alignItems="center" gap={1} mb={1}><Lan color="primary" /><Typography variant="subtitle2" color="text.secondary">连接状态</Typography>
      <Chip sx={{ ml: 'auto' }} size="small" variant="outlined" color={connectionInfo?.active ? 'success' : 'default'} label={connectionInfo ? connectionInfo.active ? '已连接' : '未连接' : '-'} /></Box>
    <Stack spacing={1}>
      {[['协议 / 网卡', [connectionInfo?.protocol, connectionInfo?.interface].filter(Boolean).join(' / ')],
        ['连接时长', connectionInfo?.uptime_seconds === undefined ? '-' : `${Math.floor(connectionInfo.uptime_seconds / 3600)}时 ${Math.floor(connectionInfo.uptime_seconds / 60) % 60}分 ${Math.floor(connectionInfo.uptime_seconds) % 60}秒`],
        ['QCI', qosInfo?.qci == null ? '-' : String(qosInfo.qci)],
        ['下行', qosInfo?.dl_speed == null ? '-' : `${(qosInfo.dl_speed / 1000).toFixed(0)} Mbps`],
        ['上行', qosInfo?.ul_speed == null ? '-' : `${(qosInfo.ul_speed / 1000).toFixed(0)} Mbps`],
        ['IPv4', connectionInfo?.ipv4.join(', ')], ['IPv6', connectionInfo?.ipv6.join(', ')], ['IPv6 前缀', connectionInfo?.ipv6_prefix.join(', ')]].filter(([label, value]) => !label?.startsWith('IPv6') || !!value).map(([label, value]) =>
        <Box key={label} display="flex" justifyContent="space-between" alignItems="center" gap={1}><Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>{label}</Typography><Typography variant="body2" sx={{ overflowWrap: 'anywhere', textAlign: 'right', ...(label?.startsWith('IPv') ? getSensitiveStyle(showInfo) : {}) }}>{value || '-'}</Typography></Box>)}
    </Stack>
  </Box>
  const renderConnectivityStatus = (
    label: 'IPv4' | 'IPv6',
    status: { success: boolean; latency_ms?: number } | undefined
  ) => {
    const isLoading = status === undefined
    const color = isLoading ? 'action.disabled' : status.success ? 'success.main' : 'error.main'
    const text = isLoading ? '-' : status.success
      ? typeof status.latency_ms === 'number' ? `${status.latency_ms.toFixed(0)} ms` : '-'
      : <Close sx={{ fontSize: 14 }} titleAccess={`${label} 连接失败`} />

    return (
      <Box component="span" display="inline-flex" alignItems="center" gap={0.5}>
        <Box component="span" sx={{ color: 'text.secondary' }}>{label}:</Box>
        <Box component="span" sx={{ color, display: 'inline-flex', alignItems: 'center', fontWeight: 500 }}>
          {text}
        </Box>
      </Box>
    )
  }

  return (
    <Box>
      <Box display="flex" alignItems="center" flexWrap="wrap" gap={1} mb={1}>
        <Box display="flex" alignItems="center" gap={1}>
          <Lan color="primary" />
          <Typography variant="subtitle2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
            连接状态
          </Typography>
        </Box>
        <Chip
          size="small"
          variant="outlined"
          sx={{ ml: 'auto', '& .MuiChip-label': { fontSize: '0.7rem' } }}
          label={
            <Box component="span" display="inline-flex" alignItems="center" gap={0.75}>
              {renderConnectivityStatus('IPv4', connectivity?.ipv4)}
              <Box component="span" sx={{ color: 'text.disabled' }}>|</Box>
              {renderConnectivityStatus('IPv6', connectivity?.ipv6)}
            </Box>
          }
        />
      </Box>
      <Stack spacing={1}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Typography variant="caption" color="text.secondary">
            QCI
          </Typography>
          <Typography variant="body2" fontWeight="medium">
            {qosInfo?.qci || '-'}
          </Typography>
        </Box>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Typography variant="caption" color="text.secondary">
            下行
          </Typography>
          <Typography variant="body2" fontWeight="medium">
            {qosInfo?.dl_speed ? `${(qosInfo.dl_speed / 1000).toFixed(0)} Mbps` : '-'}
          </Typography>
        </Box>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Typography variant="caption" color="text.secondary">
            上行
          </Typography>
          <Typography variant="body2" fontWeight="medium">
            {qosInfo?.ul_speed ? `${(qosInfo.ul_speed / 1000).toFixed(0)} Mbps` : '-'}
          </Typography>
        </Box>
      </Stack>
    </Box>
  )
}
