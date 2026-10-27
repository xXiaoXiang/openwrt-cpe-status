export const sdkTargets = {
  'aarch64_cortex-a53': { root: 'cpe-status-build/immortalwrt-25.12.2', target: 'mediatek/filogic' },
  x86_64: { root: 'cpe-status-build/immortalwrt-25.12.2-x86_64', target: 'x86/64' },
} as const

export type SdkArchitecture = keyof typeof sdkTargets
export function sdkArchitecture(value = 'aarch64_cortex-a53'): SdkArchitecture {
  if (!Object.hasOwn(sdkTargets, value)) throw new Error('Supported architectures: ' + Object.keys(sdkTargets).join(', '))
  return value as SdkArchitecture
}
export const apkFilename = (version: string, revision: number, architecture: SdkArchitecture) => `luci-app-cpe-status-${version}-r${revision}-${architecture}.apk`
