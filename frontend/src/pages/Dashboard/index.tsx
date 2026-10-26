/*
 * @Author: 1orz cloudorzi@gmail.com
 * @Date: 2025-12-10 10:22:12
 * @LastEditors: 1orz cloudorzi@gmail.com
 * @LastEditTime: 2025-12-13 12:44:42
 * @FilePath: /udx710-backend/frontend/src/pages/Dashboard/index.tsx
 * @Description:
 *
 * Copyright (c) 2025 by 1orz, All Rights Reserved.
 */
import { Box, Card, CardContent, LinearProgress } from '@mui/material'
import Grid from '@mui/material/Grid'
import { useSharedDashboardData } from '@/contexts/DashboardDataContext'
import ErrorSnackbar from '@/components/ErrorSnackbar'
import { StatusOverview } from './components/StatusOverview'
import {
  QuickControls,
  SystemResources,
  NetworkSpeed,
  ConnectionStatus,
  SimCardInfo,
  TemperatureMonitor,
  CellInfo,
  DeviceInfoCard,
} from './components'

export default function Dashboard() {
  const embedded = new URLSearchParams(location.search).has('embedded')
  const { initialLoading, error, setError, pendingControl, data, actions, waitingMessage } = useSharedDashboardData()

  return (
    <Box>
      <ErrorSnackbar error={error} onClose={() => setError(null)} />

      {initialLoading && (
        <Box sx={{ mb: 2 }}>
          <LinearProgress sx={{ height: 3, borderRadius: 999 }} />
        </Box>
      )}

      {!embedded && <StatusOverview
        presentation="dashboard"
        deviceInfo={data.deviceInfo} networkInfo={data.networkInfo} cellsInfo={data.cellsInfo}
        airplaneMode={data.airplaneMode} imsStatus={data.imsStatus}
        roaming={data.roaming} waitingMessage={waitingMessage}
      />}

      {/* 主体内容区，PC 端采用多列布局 */}
      <Grid container spacing={2}>
        {/* 第一行：给快捷控制更多宽度，适应 LuCI 的容器限制 */}
        <Grid size={{ xs: 12, md: 5 }}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <QuickControls
                dataStatus={data.dataStatus}
                airplaneMode={data.airplaneMode}
                roaming={data.roaming}
                pendingControl={pendingControl}
                onToggleData={(target) => void actions.toggleData(target)}
                onToggleAirplaneMode={(target) => void actions.toggleAirplaneMode(target)}
                onToggleRoaming={(target) => void actions.toggleRoaming(target)}
              />
              <Box role="separator" sx={{
                height: '1px',
                my: 2,
                background: (theme) => `linear-gradient(to right, transparent, ${theme.palette.divider}, transparent)`,
              }} />
              <ConnectionStatus qosInfo={data.qosInfo} connectivity={data.connectivity} connectionInfo={data.systemStats?.connection} />
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, md: 3 }}>
          <SimCardInfo simInfo={data.simInfo} networkInfo={data.networkInfo} />
        </Grid>

        <Grid size={{ xs: 12, md: 4 }}>
          <SystemResources systemStats={data.systemStats} />
        </Grid>

        {/* 第二行：实时网速、温度监控 */}
        <Grid size={{ xs: 12, md: 8 }}>
          <NetworkSpeed systemStats={data.systemStats} speedHistory={data.speedHistory} />
        </Grid>

        <Grid size={{ xs: 12, md: 4 }}>
          <TemperatureMonitor systemStats={data.systemStats} />
        </Grid>

        {/* 第三行：宽屏下小区信息与设备信息按 2:1 并排 */}
        <Grid size={{ xs: 12, md: 8 }} sx={{ minWidth: 0 }}>
          <CellInfo cellsInfo={data.cellsInfo} stale={data.cellsStale} />
        </Grid>
        <Grid size={{ xs: 12, md: 4 }} sx={{ minWidth: 0 }}>
          <DeviceInfoCard deviceInfo={data.deviceInfo} systemStats={data.systemStats} />
        </Grid>
      </Grid>
    </Box>
  )
}
