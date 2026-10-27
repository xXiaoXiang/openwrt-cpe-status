/*
 * @Author: 1orz cloudorzi@gmail.com
 * @Date: 2025-11-22 10:30:41
 * @LastEditors: 1orz cloudorzi@gmail.com
 * @LastEditTime: 2025-12-13 12:43:28
 * @Description: 
 * 
 * Copyright (c) 2025 by 1orz, All Rights Reserved. 
 */
/*
 * @Author: 1orz cloudorzi@gmail.com
 * @Date: 2025-11-22 10:30:41
 * @LastEditors: 1orz cloudorzi@gmail.com
 * @LastEditTime: 2025-12-13 12:43:22
 * @Description: 
 * 
 * Copyright (c) 2025 by 1orz, All Rights Reserved. 
 */
import { useLocation } from 'react-router-dom'
import { AppBar, Box, Toolbar, Typography, IconButton } from '@mui/material'
import { Menu as MenuIcon } from '@mui/icons-material'
import { useSharedDashboardData } from '@/contexts/DashboardDataContext'
import { useDashboardHeader } from '@/contexts/DashboardHeaderContext'
import { StatusOverview } from '@/pages/Dashboard/components/StatusOverview'
import { navigationItems } from './navigation'

interface TopBarProps {
  drawerWidth: number
  onMenuClick: () => void
}

export default function TopBar({ drawerWidth, onMenuClick }: TopBarProps) {
  const { pathname } = useLocation()
  const currentPath = pathname.replace(/\/+$/, '') || '/'
  const pageTitle = navigationItems.find((item) => item.path === currentPath)?.label ?? 'CPE Status'
  const { data } = useSharedDashboardData()
  const { setTarget } = useDashboardHeader()

  return (
    <AppBar
      data-app-header
      position="fixed"
      color="default"
      elevation={0}
      sx={{
        width: { sm: 'calc(100% - ' + drawerWidth + 'px)' },
        ml: { sm: drawerWidth + 'px' },
        bgcolor: 'background.paper', color: 'text.primary',
        backgroundImage: 'none', borderRadius: 0, containerType: 'inline-size',
        borderBottom: 1, borderColor: 'divider',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.06)',
        transition: 'width 0.3s, margin-left 0.3s',
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
      }}
    >
      <Toolbar sx={{
        minHeight: { xs: 56, sm: 64 }, px: { xs: 1, sm: 2 }, gap: { xs: 0.5, sm: 1 },
      }}>
        <IconButton color="inherit" aria-label="切换侧边栏" edge="start"
          onClick={onMenuClick} sx={{ flexShrink: 0, ml: 0, p: { xs: 0.5, sm: 1 }, '& svg': { fontSize: { xs: 20, sm: 24 } } }}>
          <MenuIcon />
        </IconButton>
        <Typography variant="h6" noWrap component="h1" data-page-title sx={{
          flexShrink: 0, width: { xs: 88, sm: 112 }, fontSize: { xs: '0.9375rem', sm: '1.25rem' },
        }}>
          {pageTitle}
        </Typography>
        {currentPath === '/' ? (
          <Box ref={setTarget} data-dashboard-header-slot sx={{ position: 'relative', flex: '1 1 0', minWidth: 0, height: 40 }} />
        ) : (
          <StatusOverview
            deviceInfo={data.deviceInfo} networkInfo={data.networkInfo} cellsInfo={data.cellsInfo}
            airplaneMode={data.airplaneMode} imsStatus={data.imsStatus}
            roaming={data.roaming}
          />
        )}
      </Toolbar>
    </AppBar>
  )
}
