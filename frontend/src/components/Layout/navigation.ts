import { Dashboard, SimCardDownload, SignalCellularAlt, Sms, Terminal } from '@mui/icons-material'
export const navigationItems = [
  { path: '/', label: '仪表盘', icon: Dashboard },
  { path: '/euicc', label: 'eUICC管理', icon: SimCardDownload },
  { path: '/band-lock', label: '频段与小区设置', icon: SignalCellularAlt },
  { path: '/network', label: '网络状态', icon: SignalCellularAlt },
  { path: '/operators', label: '运营商与APN设置', icon: SignalCellularAlt },
  { path: '/sms', label: '短信', icon: Sms },
  { path: '/at-console', label: 'AT控制台', icon: Terminal },
]
