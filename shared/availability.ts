import type { ApiResponse, ModemAdapter } from './adapter.ts'

// Keep absence separate from false/zero/empty results and from transient errors.
// Unsupported declarations take precedence even if an old command is retained.
export const NOT_APPLICABLE = '-'
export function operationSupported(profile: ModemAdapter | undefined, name: string): boolean {
  return !!profile?.commands[name] && !Object.hasOwn(profile.unsupportedOperations ?? {}, name)
}
export function featureEnabled(profile: ModemAdapter | undefined, name: string): boolean {
  return !!profile && !Object.hasOwn(profile.unsupportedOperations ?? {}, name)
}
export function unsupportedResult(reason?: string): ApiResponse {
  return { status: 'unsupported', message: 'Not applicable', display: NOT_APPLICABLE, ...(reason ? { reason } : {}) }
}
export function requireOperation(profile: ModemAdapter, name: string): void {
  if (!operationSupported(profile, name)) throw new Error(`Unsupported: ${profile.unsupportedOperations?.[name] || name}`)
}
export function parameterSupported(profile: ModemAdapter | undefined, name: string, key: string, value: string): boolean {
  if (!operationSupported(profile, name)) return false
  const definition = profile!.commands[name]
  return (!definition.parameterValues?.[key] || definition.parameterValues[key].includes(value))
    && !!definition.parameters?.[key] && new RegExp(`^(?:${definition.parameters[key]})$`).test(value)
}
