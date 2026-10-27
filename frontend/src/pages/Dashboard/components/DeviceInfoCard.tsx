/*
 * @Author: 1orz cloudorzi@gmail.com
 * @Date: 2025-12-10 10:21:46
 * @LastEditors: 1orz cloudorzi@gmail.com
 * @LastEditTime: 2025-12-13 12:44:19
 * @Description:
 *
 * Copyright (c) 2025 by 1orz, All Rights Reserved.
 */
import { Box, Card, CardContent, Typography, IconButton, Tooltip, Chip } from '@mui/material'
import { Router, Visibility, VisibilityOff, Usb, Info } from '@mui/icons-material'
import { useSensitiveVisibility } from '../../../contexts/revealSensitive'
import { getSensitiveStyle } from '../utils'
import type { DeviceInfo, SystemStatsResponse } from '@/api/types'

interface DeviceInfoCardProps {
  deviceInfo: DeviceInfo | null
  systemStats: SystemStatsResponse | null
}

export function DeviceInfoCard({ deviceInfo, systemStats }: DeviceInfoCardProps) {
  const [showInfo, setShowInfo] = useSensitiveVisibility()
  const manufacturer = deviceInfo?.manufacturer
  const model = deviceInfo?.model
  const manufacturerModel = manufacturer && model ? `${manufacturer}（${model}）` : manufacturer || model || 'N/A'

  return (
    <Card sx={{ containerType: 'inline-size', minWidth: 0 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
          <Box display="flex" alignItems="center" gap={1}>
            <Router fontSize="small" color="primary" />
            <Typography variant="subtitle2" fontWeight="medium">
              设备信息
            </Typography>
          </Box>
          <Tooltip title={showInfo ? '隐藏 IMEI' : '显示 IMEI'}>
            <IconButton size="small" onClick={() => setShowInfo(!showInfo)}>
              {showInfo ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Box>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
            '@container (max-width: 279px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
            gap: 1.5,
            '& > div': { minWidth: 0, overflowWrap: 'anywhere' },
          }}
        >
          <Box>
            <Typography variant="caption" color="text.secondary">
              IMEI
            </Typography>
            <Typography variant="body2" fontFamily="monospace" fontSize="0.75rem" sx={getSensitiveStyle(showInfo)}>
              {deviceInfo?.imei || 'N/A'}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              制造商（型号）
            </Typography>
            <Typography variant="body2" fontSize="0.75rem">
              {manufacturerModel}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              系统
            </Typography>
            <Typography variant="body2" fontSize="0.75rem">
              {systemStats?.system_info?.sysname || '-'} / {systemStats?.system_info?.machine || '-'}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              内核
            </Typography>
            <Typography variant="body2" fontSize="0.75rem">
              {systemStats?.system_info?.release || '-'}
            </Typography>
          </Box>
          {deviceInfo?.revision && <Box><Typography variant="caption" color="text.secondary">模块固件</Typography><Typography variant="body2" fontSize="0.75rem">{deviceInfo.revision}</Typography></Box>}
          {deviceInfo?.at_port && <Box><Typography variant="caption" color="text.secondary">AT 端口</Typography><Typography variant="body2" fontSize="0.75rem">{deviceInfo.at_port}</Typography></Box>}
        </Box>
        <Box display="flex" justifyContent="space-between" alignItems="center" gap={1} mt={1.5}>
          <Box display="flex" alignItems="center" gap={0.5} sx={{ flexShrink: 0 }}>
            <Usb fontSize="small" color="action" />
            <Typography variant="caption" color="text.secondary">
              USB 模式
            </Typography>
          </Box>
          <Box display="flex" alignItems="center" gap={0.5}>
            <Chip label={systemStats?.usb_mode?.current_mode_name || 'N/A'} size="small" color="primary" variant="outlined" />
            {systemStats?.usb_mode?.needs_reboot && (
              <Tooltip title="需要重启生效">
                <Info fontSize="small" color="warning" />
              </Tooltip>
            )}
          </Box>
        </Box>
      </CardContent>
    </Card>
  )
}
