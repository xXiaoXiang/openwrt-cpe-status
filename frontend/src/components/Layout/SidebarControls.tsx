import { useState } from 'react'
import { Box, IconButton, Menu, MenuItem, ListItemIcon, ListItemText, Divider } from '@mui/material'
import {
  Refresh as RefreshIcon, MoreVert as MoreVertIcon, Brightness4 as DarkModeIcon,
  Brightness7 as LightModeIcon, Speed as SpeedIcon, Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
  BrightnessAuto as AutoModeIcon,
} from '@mui/icons-material'
import { toggleRevealAll, useRevealAll } from '@/contexts/revealSensitive'
import { useTheme } from '@/contexts/ThemeContext'
import { useRefreshInterval } from '@/contexts/RefreshContext'

export default function SidebarControls() {
  const { preference, setPreference } = useTheme()
  const { refreshInterval, setRefreshInterval: onRefreshIntervalChange, triggerRefresh } = useRefreshInterval()
  const revealAll = useRevealAll()
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)
  const [refreshMenuAnchor, setRefreshMenuAnchor] = useState<null | HTMLElement>(null)

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget)
  }

  const handleMenuClose = () => {
    setAnchorEl(null)
  }

  const handleRefreshMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setRefreshMenuAnchor(event.currentTarget)
  }

  const handleRefreshMenuClose = () => {
    setRefreshMenuAnchor(null)
  }

  const handleRefreshIntervalChange = (interval: number) => {
    onRefreshIntervalChange(interval)
    handleRefreshMenuClose()
  }

  const handleRefresh = () => {
    triggerRefresh()
  }

  const getRefreshLabel = () => {
    if (refreshInterval === 0) return '手动'
    if (refreshInterval === 1000) return '1秒'
    if (refreshInterval === 3000) return '3秒'
    if (refreshInterval === 5000) return '5秒'
    if (refreshInterval === 10000) return '10秒'
    return `${refreshInterval / 1000}秒`
  }

  return (
    <>
      {/* 右侧按钮组 */}
      <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, gap: 0, '& .MuiIconButton-root': { p: 0.5 }, '& .MuiSvgIcon-root': { fontSize: 20 } }}>
        <IconButton
          color="inherit"
          onClick={toggleRevealAll}
          title={revealAll ? '隐藏所有敏感信息' : '显示所有敏感信息'}
        >
          {revealAll ? <VisibilityOffIcon /> : <VisibilityIcon />}
        </IconButton>

        {/* 刷新按钮 - 始终显示 */}
        <IconButton
          color="inherit"
          onClick={handleRefresh}
          title="刷新页面"
          sx={{ display: { xs: 'inline-flex', sm: 'inline-flex' } }}
        >
          <RefreshIcon />
        </IconButton>

        {/* 更多选项按钮 - 折叠其他功能 */}
        <IconButton
          color="inherit"
          onClick={handleMenuOpen}
          title="刷新间隔与显示设置"
          sx={{ display: { xs: 'inline-flex', sm: 'inline-flex' } }}
        >
          <MoreVertIcon />
        </IconButton>
      </Box>

      {/* 更多选项菜单 */}
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleMenuClose}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
        PaperProps={{
          sx: {
            minWidth: 200,
            mt: 1,
          },
        }}
      >
        {/* 主题切换 */}
        {([
          ['auto', '跟随 LuCI', <AutoModeIcon fontSize="small" />],
          ['light', '浅色模式', <LightModeIcon fontSize="small" />],
          ['dark', '深色模式', <DarkModeIcon fontSize="small" />],
        ] as const).map(([value, label, icon]) => <MenuItem key={value} selected={preference === value} onClick={() => { setPreference(value); handleMenuClose() }}>
          <ListItemIcon>{icon}</ListItemIcon><ListItemText>{label}</ListItemText>
        </MenuItem>)}

        <Divider />

        {/* 刷新频率 */}
        <MenuItem onClick={handleRefreshMenuOpen}>
          <ListItemIcon>
            <SpeedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="刷新频率"
            secondary={getRefreshLabel()}
            secondaryTypographyProps={{ variant: 'caption' }}
          />
        </MenuItem>
      </Menu>

      {/* 刷新频率子菜单 */}
      <Menu
        anchorEl={refreshMenuAnchor}
        open={Boolean(refreshMenuAnchor)}
        onClose={handleRefreshMenuClose}
        anchorOrigin={{
          vertical: 'top',
          horizontal: 'left',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
        PaperProps={{
          sx: {
            minWidth: 150,
          },
        }}
      >
        <MenuItem
          selected={refreshInterval === 1000}
          onClick={() => handleRefreshIntervalChange(1000)}
        >
          1秒/次
        </MenuItem>
        <MenuItem
          selected={refreshInterval === 3000}
          onClick={() => handleRefreshIntervalChange(3000)}
        >
          3秒/次
        </MenuItem>
        <MenuItem
          selected={refreshInterval === 5000}
          onClick={() => handleRefreshIntervalChange(5000)}
        >
          5秒/次
        </MenuItem>
        <MenuItem
          selected={refreshInterval === 10000}
          onClick={() => handleRefreshIntervalChange(10000)}
        >
          10秒/次
        </MenuItem>
        <Divider />
        <MenuItem
          selected={refreshInterval === 0}
          onClick={() => handleRefreshIntervalChange(0)}
        >
          手动刷新
        </MenuItem>
      </Menu>
    </>
  )
}
