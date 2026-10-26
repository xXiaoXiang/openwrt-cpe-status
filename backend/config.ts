import type { LpacConfig } from './lpac.ts'

export interface ServiceConfig {
  device: string
  adapterDirectory: string
  adapterId?: string
  networkInterface: string
  socketPath: string
  allowWrites: boolean
  validatedOperations: string[]
  stateDirectory: string
  lpac: LpacConfig
}

export const exampleConfig: ServiceConfig = {
  device: '/dev/ttyUSB2', adapterDirectory: '/usr/share/openwrt-modem/adapters',
  networkInterface: 'wwan', socketPath: '/var/run/openwrt-modem.sock',
  allowWrites: true, validatedOperations: [], stateDirectory: '/etc/openwrt-modem/state',
  lpac: { enabled: false, executable: '/usr/bin/lpac', env: { LPAC_APDU: 'at', LPAC_APDU_AT_DEVICE: '/dev/ttyUSB2' }, enableRefresh: '1' },
}
