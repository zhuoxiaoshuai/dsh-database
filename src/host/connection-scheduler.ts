type Lane = 'manual' | 'background'
type Claim = { key: string; lane: Lane; resolve(value: { release(): void; queueMs: number }): void; reject(error: Error): void; cleanup(): void; started: number }

/** Connection resource permits. Reservation happens synchronously; waiting owns no permit. */
export class ConnectionScheduler {
  #active = new Map<string, number>()
  #total = 0
  #background = new Map<string, number>()
  #backgroundCount = 0
  #waiting: Claim[] = []
  #closed = false
  #lastKey?: string
  private perConnection: number
  private total: number
  private backgroundPerConnection: number
  private backgroundTotal: number
  private timeoutMs: number
  private blocked: (key: string) => boolean
  private prioritizeManual: boolean
  constructor(perConnection: number, total: number, backgroundPerConnection: number, backgroundTotal: number,
    timeoutMs = 30_000, blocked: (key: string) => boolean = () => false, prioritizeManual = false) {
    this.perConnection = perConnection; this.total = total; this.backgroundPerConnection = backgroundPerConnection
    this.backgroundTotal = backgroundTotal; this.timeoutMs = timeoutMs; this.blocked = blocked
    this.prioritizeManual = prioritizeManual
  }
  active(key: string): number { return this.#active.get(key) || 0 }
  acquire(key: string, lane: Lane = 'manual', signal?: AbortSignal): Promise<{ release(): void; queueMs: number }> {
    if (this.#closed) return Promise.reject(new Error('连接服务已关闭。'))
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('请求已取消。'), { cancelled: true, code: 'request_cancelled' }))
    return new Promise((resolve, reject) => {
      const abort = () => remove(Object.assign(new Error('请求已取消。'), { cancelled: true, code: 'request_cancelled' }))
      const timer = setTimeout(() => remove(Object.assign(new Error('连接排队已满，请稍后再试。'), { code: 'connection_busy' })), this.timeoutMs)
      const claim: Claim = { key, lane, resolve, reject, started: Date.now(), cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) } }
      const remove = (error: Error) => { const index = this.#waiting.indexOf(claim); if (index < 0) return; this.#waiting.splice(index, 1); claim.cleanup(); reject(error); this.drain() }
      signal?.addEventListener('abort', abort, { once: true })
      this.#waiting.push(claim)
      this.drain()
    })
  }
  drain(): void {
    while (!this.#closed) {
      const eligible = (claim: Claim) => !this.blocked(claim.key) && this.active(claim.key) < this.perConnection && this.#total < this.total
        && (claim.lane !== 'background' || ((this.#background.get(claim.key) || 0) < this.backgroundPerConnection && this.#backgroundCount < this.backgroundTotal))
      let index = -1
      for (const lane of this.prioritizeManual ? ['manual','background'] as const : [undefined]) {
        const available = (claim: Claim) => (lane === undefined || claim.lane === lane) && eligible(claim)
        index = this.#waiting.findIndex(claim => claim.key !== this.#lastKey && available(claim))
        if (index < 0) index = this.#waiting.findIndex(available)
        if (index >= 0) break
      }
      if (index < 0) return
      const claim = this.#waiting.splice(index, 1)[0]
      claim.cleanup()
      this.#lastKey = claim.key
      this.#active.set(claim.key, this.active(claim.key) + 1)
      this.#total++
      if (claim.lane === 'background') { this.#backgroundCount++; this.#background.set(claim.key, (this.#background.get(claim.key) || 0) + 1) }
      let released = false
      claim.resolve({ queueMs: Date.now() - claim.started, release: () => {
        if (released) return
        released = true
        const next = this.active(claim.key) - 1
        if (next) this.#active.set(claim.key, next); else this.#active.delete(claim.key)
        this.#total--
        if (claim.lane === 'background') { this.#backgroundCount--; const background = (this.#background.get(claim.key) || 0) - 1; if (background) this.#background.set(claim.key, background); else this.#background.delete(claim.key) }
        this.drain()
      } })
    }
  }
  cancel(key: string): void {
    for (const claim of this.#waiting.filter(claim => claim.key === key)) {
      this.#waiting.splice(this.#waiting.indexOf(claim), 1); claim.cleanup(); claim.reject(Object.assign(new Error('连接已变化，请刷新。'), { code: 'connection_stale' }))
    }
  }
  close(): void { this.#closed = true; for (const claim of this.#waiting.splice(0)) { claim.cleanup(); claim.reject(new Error('连接服务已关闭。')) } }
}
