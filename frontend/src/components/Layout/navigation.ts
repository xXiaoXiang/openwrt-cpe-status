import { Dashboard, SimCardDownload, SignalCellularAlt, Sms, Terminal } from '@mui/icons-material'
export const navigationItems = [
  { path: '/', label: '状态', icon: Dashboard },
  { path: '/band-lock', label: '频段/小区', icon: SignalCellularAlt },
  { path: '/network', label: '网络状态', icon: SignalCellularAlt },
  { path: '/operators', label: '运营商/APN', icon: SignalCellularAlt },
  { path: '/at-console', label: 'AT', icon: Terminal },
  { path: '/sms', label: '短信', icon: Sms },
  { path: '/euicc', label: 'eUICC', icon: SimCardDownload },
]
