export function roamingPreference(value: unknown) {
  const preference = [1, 3, 255].includes(Number(value)) ? Number(value) : null
  return { roam_pref: preference, roaming_allowed: preference === null ? null : preference !== 1, policy_scope: 'registration' as const }
}

export const snapshotCapabilities = {
  id: 'quectel-status-lite', demo: false, status_only: true, writes_enabled: true,
  lpac_enabled: false, data_control: true, airplane_control: true, roaming_policy: true, roaming_scope: 'registration', ims: false,
}
