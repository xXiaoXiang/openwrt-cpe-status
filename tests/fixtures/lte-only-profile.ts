import { rm500qProfile } from '../../adapters/rm500q-profile.ts'

// A simulated capability set, not a claim that a new hardware model is tested.
export function lteOnlyProfile() {
  const profile = structuredClone(rm500qProfile)
  profile.unsupportedOperations = Object.fromEntries([
    'registration5g', 'nrBands', 'nsaBands', 'nrBandsSet', 'nsaBandsSet',
    'nrCellLock', 'nrCellLockSet', 'nrCellUnlock', 'roamingPreference',
    'roamingSet', 'airplaneSet', 'temperature', 'cellScan', 'phone',
    'contexts', 'contextsActive', 'imeiSet', 'sms',
  ].map(name => [name, 'Not supported by the simulated LTE-only profile']))
  profile.commands.modeSet.parameterValues = { mode: ['AUTO', 'LTE', 'WCDMA:LTE', 'WCDMA'] }
  return profile
}
