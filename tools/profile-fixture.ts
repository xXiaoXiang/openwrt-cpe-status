import { createHash } from 'node:crypto'
import { rm500qProfile } from '../adapters/rm500q-profile.ts'

export const profileContent = JSON.stringify(rm500qProfile, null, 2) + '\n'
export function profileFingerprint(content = profileContent) {
  return '2c7c0800:' + createHash('sha256').update(content).digest('hex')
}
export function profileFixture(root: string) {
  if (!/^\/tmp\/[a-zA-Z0-9-]+$/.test(root)) throw new Error('Profile fixture must stay in a named /tmp directory')
  return `umask 077
mkdir -p ${root}/modem.d
cat >${root}/modem.d/2c7c0800.conf <<'CPE_FIXTURE_PROFILE'
${profileContent.trimEnd()}
CPE_FIXTURE_PROFILE
export CPE_STATUS_MODEM_DIRECTORY=${root}/modem.d
`
}
