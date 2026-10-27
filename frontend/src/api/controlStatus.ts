import type { ApiResponse } from './types.ts'
import { isDeferredMessage, isDeferredResponse } from './modemPolling.ts'

// A deferred write may already have reached the modem. Only poll its real state;
// replaying the POST could toggle the modem twice. No optimistic confirmation.
export async function readDeferredControl<T>(
  read: () => Promise<ApiResponse<T>>,
  matches: (data: T) => boolean,
  budget = 60_000,
  interval = 5000,
): Promise<T | undefined> {
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, deadline - Date.now())))
    if (Date.now() >= deadline) break
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        read(),
        new Promise<ApiResponse<T>>((resolve) => {
          timer = setTimeout(() => resolve({ status: 'deferred', message: 'Status read deferred' }),
            Math.min(5000, deadline - Date.now()))
        }),
      ])
      if (isDeferredResponse(response)) continue
      if (response.status !== 'ok' || response.data === undefined || response.data === null) {
        throw new Error(response.message || '设备未返回有效状态')
      }
      if (matches(response.data)) return response.data
    } catch (reason) {
      if (!isDeferredMessage(String(reason))) throw reason
    } finally {
      clearTimeout(timer)
    }
  }
  // Keep the old switch position; later polling may still confirm the change.
  return undefined
}
