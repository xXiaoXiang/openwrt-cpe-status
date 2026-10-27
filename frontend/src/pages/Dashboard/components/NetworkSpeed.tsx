/*
 * @Author: 1orz cloudorzi@gmail.com
 * @Date: 2025-12-10 10:17:51
 * @LastEditors: 1orz cloudorzi@gmail.com
 * @LastEditTime: 2025-12-13 12:44:25
 * @Description:
 *
 * Copyright (c) 2025 by 1orz, All Rights Reserved.
 */
import { useEffect, useState } from 'react'
import { Box, Button, Card, CardContent, Checkbox, Typography, Chip, Paper, Tooltip, useTheme, type Theme } from '@mui/material'
import { alpha } from '@/utils/theme'
import { Speed, ArrowDownward, ArrowUpward } from '@mui/icons-material'
import { SparkLineChart } from '@mui/x-charts/SparkLineChart'
import { formatBytes, formatSpeed } from '../utils'
import { SPEED_HISTORY_MAX_POINTS, type InterfaceSpeedHistory } from '../hooks/useDashboardData'
import type { SystemStatsResponse } from '@/api/types'
import { defaultSpeedInterfaces, readSpeedSelection, speedInterfaceSelected, speedSelectionKey } from '@/utils/speedInterfaces'

interface NetworkSpeedProps {
  systemStats: SystemStatsResponse | null
  speedHistory: Record<string, InterfaceSpeedHistory>
}

export function NetworkSpeed({ systemStats, speedHistory }: NetworkSpeedProps) {
  const theme = useTheme<Theme>()
  const [showAll, setShowAll] = useState(false)
  const [selected, setSelected] = useState(() => {
    try { return readSpeedSelection(localStorage.getItem(speedSelectionKey)) } catch { return [...defaultSpeedInterfaces] }
  })
  useEffect(() => {
    try { localStorage.setItem(speedSelectionKey, JSON.stringify(selected)) } catch { /* Private browser storage may be disabled. */ }
  }, [selected])
  const interfaces = systemStats?.network_speed?.interfaces ?? []
  const visible = showAll ? interfaces : interfaces.filter(iface => speedInterfaceSelected(iface, selected))

  return (
    <Card data-speed-monitor sx={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <CardContent sx={{ flex: 1, display: 'flex', flexDirection: 'column', '&:last-child': { pb: 2 } }}>
        <Box display="flex" alignItems="center" gap={1} mb={2} flexWrap="wrap">
          <Speed color="primary" />
          <Typography variant="subtitle2" color="text.secondary">
            实时网速
          </Typography>
          <Typography variant="caption" color="text.disabled" sx={{ ml: 'auto' }}>
            {SPEED_HISTORY_MAX_POINTS}s 趋势
          </Typography>
          <Button size="small" variant="outlined" aria-label="切换网速接口视图" aria-pressed={showAll} onClick={() => setShowAll(value => !value)} sx={{ fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
            {showAll ? '仅看已选' : '显示全部'}
          </Button>
        </Box>
        {visible.length > 0 ? (
          <Box
            sx={{
              flex: 1,
              display: 'grid',
              gridTemplateColumns: {
                xs: '1fr',
                md: visible.length > 1 ? 'repeat(2, minmax(0, 1fr))' : '1fr',
              },
              gap: 2,
            }}
          >
            {visible.map((iface) => {
              const history = speedHistory[iface.interface]
              const rxData = history?.rx || []
              const txData = history?.tx || []
              const maxSpeed = Math.max(Math.max(...rxData, 1), Math.max(...txData, 1))

              return (
                <Paper
                  data-speed-interface={iface.interface}
                  key={iface.interface}
                  variant="outlined"
                  sx={{
                    p: 2,
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    background: (() => {
                      const paperColor = (theme.palette.background as { paper: string }).paper
                      return alpha(paperColor, 0.6)
                    })(),
                  }}
                >
                  <Box display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1} mb={1.5}>
                    <Box display="flex" alignItems="center" gap={0.25}>
                      <Tooltip title={iface.logical_interfaces?.join(' / ') || iface.interface}>
                        <Chip label={iface.interface} size="small" variant="outlined" sx={{ fontFamily: 'monospace', fontWeight: 500 }} />
                      </Tooltip>
                      {showAll && <Tooltip title="在默认视图中显示">
                        <Checkbox size="small" checked={speedInterfaceSelected(iface, selected)} inputProps={{ 'aria-label': `默认显示 ${iface.interface}` }} sx={{ p: 0.5 }} onChange={(_, checked) => setSelected(previous => {
                          const names = [iface.interface, ...(iface.logical_interfaces ?? [])]
                          const remaining = previous.filter(name => !names.includes(name))
                          return checked ? [...remaining, iface.interface] : remaining
                        })} />
                      </Tooltip>}
                    </Box>
                    <Typography variant="caption" color="text.secondary">
                      总流量 ↓ {formatBytes(iface.total_rx_bytes)} / ↑ {formatBytes(iface.total_tx_bytes)}
                    </Typography>
                  </Box>

                  <Box mb={1.5} sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <Box display="flex" alignItems="center" justifyContent="space-between" mb={0.5}>
                      <Box display="flex" alignItems="center" gap={0.5}>
                        <ArrowDownward fontSize="small" sx={{ color: (theme.palette.success as { main: string }).main }} />
                        <Typography variant="caption" color="text.secondary">
                          下载
                        </Typography>
                      </Box>
                      <Typography
                        variant="body1"
                        fontWeight="bold"
                        sx={{
                          color: (theme.palette.success as { main: string }).main,
                          fontFamily: 'monospace',
                          minWidth: 90,
                          textAlign: 'right',
                        }}
                      >
                        {formatSpeed(iface.rx_bytes_per_sec)}
                      </Typography>
                    </Box>
                    {rxData.length > 1 && (
                      <Box sx={{ flex: 1, minHeight: 40, position: 'relative' }}>
                        <Box sx={{ position: 'absolute', inset: 0 }}>
                          <SparkLineChart
                            data={rxData}
                            area
                            curve="natural"
                            color={(theme.palette.success as { main: string }).main}
                            yAxis={{ min: 0, max: maxSpeed * 1.1 }}
                            margin={{ top: 2, bottom: 2, left: 0, right: 0 }}
                          />
                        </Box>
                      </Box>
                    )}
                  </Box>

                  <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <Box display="flex" alignItems="center" justifyContent="space-between" mb={0.5}>
                      <Box display="flex" alignItems="center" gap={0.5}>
                        <ArrowUpward fontSize="small" sx={{ color: (theme.palette.primary as { main: string }).main }} />
                        <Typography variant="caption" color="text.secondary">
                          上传
                        </Typography>
                      </Box>
                      <Typography
                        variant="body1"
                        fontWeight="bold"
                        sx={{
                          color: (theme.palette.primary as { main: string }).main,
                          fontFamily: 'monospace',
                          minWidth: 90,
                          textAlign: 'right',
                        }}
                      >
                        {formatSpeed(iface.tx_bytes_per_sec)}
                      </Typography>
                    </Box>
                    {txData.length > 1 && (
                      <Box sx={{ flex: 1, minHeight: 40, position: 'relative' }}>
                        <Box sx={{ position: 'absolute', inset: 0 }}>
                          <SparkLineChart
                            data={txData}
                            area
                            curve="natural"
                            color={(theme.palette.primary as { main: string }).main}
                            yAxis={{ min: 0, max: maxSpeed * 1.1 }}
                            margin={{ top: 2, bottom: 2, left: 0, right: 0 }}
                          />
                        </Box>
                      </Box>
                    )}
                  </Box>
                </Paper>
              )
            })}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {interfaces.length ? '未选择当前在线的接口，点击“显示全部”进行勾选。' : '暂无数据'}
          </Typography>
        )}
      </CardContent>
    </Card>
  )
}
