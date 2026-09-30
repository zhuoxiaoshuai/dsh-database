/**
 * 安全读取 uiSession。
 * cordis 对未 inject 的属性访问会抛；旧宿主没有该服务，写进 inject 会挂起激活。
 */

/** uiSession.adapter.current 快照。 */
export type UiCurrentSnapshot = {
  key?: unknown
}

/** uiSession.adapter.current 的 binding source。 */
export type UiCurrentFeed = {
  subscribe(fn: () => void): () => void
  getSnapshot(): UiCurrentSnapshot
}

/** 只依赖 adapter.current。禁止把 uiSession 写进 inject。 */
export type UiSessionLike = {
  adapter: {
    current: UiCurrentFeed
  }
}

export function getUiSession(ctx: unknown): UiSessionLike | undefined {
  try {
    return (ctx as { uiSession?: UiSessionLike }).uiSession
  } catch {
    return undefined
  }
}
