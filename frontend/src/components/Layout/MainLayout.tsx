/*
 * @Author: 1orz cloudorzi@gmail.com
 * @Date: 2025-11-22 10:30:41
 * @LastEditors: 1orz cloudorzi@gmail.com
 * @LastEditTime: 2026-04-18 20:15:00
 * @Description:
 *
 * Copyright (c) 2025 by 1orz, All Rights Reserved.
 */
import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { alpha, Box, Paper, type Theme, useMediaQuery, useTheme } from '@mui/material'

import { api } from '../../api'
import { RefreshContext } from '../../contexts/RefreshContext'
import { DashboardDataContext } from '../../contexts/DashboardDataContext'
import { DashboardHeaderContext } from '../../contexts/DashboardHeaderContext'
import { useDashboardData } from '../../pages/Dashboard/hooks/useDashboardData'
import { usePageVisibility } from '../../hooks/useAdaptivePolling'
import { useSingleFlight } from '../../hooks/useSingleFlight'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import SidebarControls from './SidebarControls'
import { StatusOverview } from '@/pages/Dashboard/components/StatusOverview'

const DRAWER_WIDTH = 240
const DEFAULT_REFRESH_INTERVAL = 5000
// Keep the heartbeat comfortably below the backend timeout floor so 1s/3s polling
// does not drift onto the timeout boundary.
const HEARTBEAT_MIN_INTERVAL = 5000
const HIDDEN_HEARTBEAT_MIN_INTERVAL = 30000

function getHeartbeatInterval(refreshInterval: number, isPageVisible: boolean) {
  if (refreshInterval <= 0) {
    return isPageVisible ? 20000 : 60000
  }

  if (!isPageVisible) {
    return Math.max(refreshInterval * 12, HIDDEN_HEARTBEAT_MIN_INTERVAL)
  }

  return Math.max(refreshInterval * 3, HEARTBEAT_MIN_INTERVAL)
}

export default function MainLayout() {
  const embedded = new URLSearchParams(location.search).has('embedded')
  const run = useSingleFlight()
  const theme = useTheme<Theme>()
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'))
  const isPageVisible = usePageVisibility()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [desktopOpen, setDesktopOpen] = useState(true)
  const [refreshInterval, setRefreshIntervalState] = useState(DEFAULT_REFRESH_INTERVAL)
  const [refreshKey, setRefreshKey] = useState(0)
  const [dashboardStatusTarget, setDashboardStatusTarget] = useState<HTMLDivElement | null>(null)
  const { pathname } = useLocation()
  const dashboardData = useDashboardData(refreshInterval, refreshKey, pathname === '/')
  const refreshRequestIdRef = useRef(0)

  useEffect(() => {
    let cancelled = false

    const loadRefreshConfig = async () => {
      try {
        const response = await api.getRefreshConfig()
        if (
          !cancelled &&
          refreshRequestIdRef.current === 0 &&
          response.status === 'ok' &&
          response.data
        ) {
          setRefreshIntervalState(response.data.interval_ms)
        }
      } catch (error) {
        console.warn('加载刷新设置失败:', error)
      }
    }

    void loadRefreshConfig()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const sendHeartbeat = () => run('heartbeat', async () => {
      try {
        await api.sendRefreshHeartbeat()
      } catch (error) {
        if (!cancelled) {
          console.warn('刷新心跳发送失败:', error)
        }
      }
    })

    void sendHeartbeat()

    const timer = window.setInterval(() => {
      void sendHeartbeat()
    }, getHeartbeatInterval(refreshInterval, isPageVisible))

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [isPageVisible, refreshInterval, run])

  const handleDrawerToggle = () => {
    if (isMobile) {
      setMobileOpen((current) => !current)
    } else {
      setDesktopOpen((current) => !current)
    }
  }

  const triggerRefresh = () => {
    setRefreshKey((current) => current + 1)
  }

  const setRefreshInterval = (interval: number) => {
    const previousInterval = refreshInterval
    const requestId = refreshRequestIdRef.current + 1
    refreshRequestIdRef.current = requestId
    setRefreshIntervalState(interval)
    void api
      .setRefreshConfig(interval)
      .then((response) => {
        if (refreshRequestIdRef.current !== requestId) {
          return
        }

        if (response.status === 'ok' && response.data) {
          setRefreshIntervalState(response.data.interval_ms)
          return
        }

        setRefreshIntervalState(previousInterval)
        console.warn('保存刷新设置失败:', response.message)
      })
      .catch((error) => {
        if (refreshRequestIdRef.current === requestId) {
          setRefreshIntervalState(previousInterval)
        }
        console.warn('保存刷新设置失败:', error)
      })
  }

  return (
    <RefreshContext.Provider
      value={{ refreshInterval, setRefreshInterval, refreshKey, triggerRefresh }}
    >
      <DashboardDataContext.Provider value={dashboardData}>
        <DashboardHeaderContext.Provider value={{ target: dashboardStatusTarget, setTarget: setDashboardStatusTarget }}>
          <Box sx={{ display: 'flex', minHeight: '100vh' }}>
            {!embedded && <><TopBar
              drawerWidth={desktopOpen ? DRAWER_WIDTH : 0}
              onMenuClick={handleDrawerToggle}
            /><Sidebar
              drawerWidth={DRAWER_WIDTH}
              mobileOpen={mobileOpen}
              desktopOpen={desktopOpen}
              onClose={handleDrawerToggle}
              isMobile={isMobile}
            /></>}

            <Box
              component="main"
              sx={{
                flexGrow: 1,
                minWidth: 0,
                p: embedded ? 0 : { xs: 2, sm: 3 },
                pb: embedded ? 2 : { xs: 2, sm: 3 },
                width: {
                  xs: '100%',
                  sm: desktopOpen && !embedded ? `calc(100% - ${DRAWER_WIDTH}px)` : '100%',
                },
                mt: embedded ? 0 : { xs: 7, sm: 8 },
                minHeight: '100vh',
                backgroundColor: embedded ? 'transparent' : 'background.default',
                transition: theme.transitions.create(['width', 'margin'], {
                  easing: theme.transitions.easing.sharp,
                  duration: theme.transitions.duration.leavingScreen,
                }),
              }}
            >
              {embedded && <Paper component="header" data-embedded-status-bar elevation={0} sx={{
                position: 'sticky', top: 0, zIndex: theme.zIndex.appBar,
                display: 'flex', alignItems: 'center', gap: { xs: 0.5, sm: 1 },
                p: { xs: 1, sm: 1.5 }, mb: 2, borderRadius: 2,
                bgcolor: 'background.paper',
                backgroundImage: `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.08)} 0%, ${alpha(theme.palette.secondary.main, 0.03)} 100%)`,
                border: `1px solid ${alpha(theme.palette.primary.main, 0.1)}`,
              }}>
                <StatusOverview presentation="bar" {...dashboardData.data} />
                <SidebarControls />
              </Paper>}
              <Outlet />
            </Box>
          </Box>
        </DashboardHeaderContext.Provider>
      </DashboardDataContext.Provider>
    </RefreshContext.Provider>
  )
}
