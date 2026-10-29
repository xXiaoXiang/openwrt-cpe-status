// Shared across routes. Only the backend owns the download lifetime.
export class ModemActivity {
  private local = 0
  private remote = false
  private listeners = new Set<() => void>()
  isPaused = () => this.local > 0 || this.remote
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private notify() { for (const listener of this.listeners) listener() }
  setRemote(active: boolean) { if (active !== this.remote) { this.remote = active; this.notify() } }
  begin() {
    this.local++; this.notify()
    let released = false
    return () => { if (!released) { released = true; this.local--; this.notify() } }
  }
  wait(signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    if (!this.isPaused()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = () => { unsubscribe(); signal?.removeEventListener('abort', abort) }
      const abort = () => { finish(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
      const unsubscribe = this.subscribe(() => { if (!this.isPaused()) { finish(); resolve() } })
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}
export const modemActivity = new ModemActivity()
