/** Process-local signing keys and preview consumption share the same lifetime. */
export class NacosPreviewConsumption {
  readonly #consumed = new Map<string, number>()
  private readonly capacity: number
  private readonly now: () => number
  constructor(capacity = 1024, now = () => Date.now()) { this.capacity = capacity; this.now = now }

  consume(id: string, expires: number): void {
    const now = this.now()
    for (const [key, expiry] of this.#consumed) if (expiry <= now) this.#consumed.delete(key)
    if (!Number.isSafeInteger(expires) || expires <= now) throw new Error('预览已过期，请重新预览。')
    if (this.#consumed.has(id)) throw new Error('此预览已执行，请重新读取目标；未知结果不能重试原写入。')
    // Never evict a live proof to make room for another write.
    if (this.#consumed.size >= this.capacity) throw new Error('预览消费记录已达上限，请等待已有预览过期后重新预览。')
    this.#consumed.set(id, expires)
  }
}
