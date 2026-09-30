import { createElement as h, useSyncExternalStore } from 'react'
import { Database } from 'lucide-react'
import { DatabaseWorkspace } from './workspace/shell/database-workspace.tsx'
import { getUiSession, type UiCurrentSnapshot } from './current-resolver.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'

export const name = 'database'
export const inject = ['slots', 'sessions', 'sidebarRightTabs', 'sidebarRight']

type TabBodyProps = {
  sessionId: string
  useTabInfo: () => { tab: { id: string; title: string; signal: AbortSignal } }
}

type SlotsLike = {
  inject(name: string, effect: () => (() => void)): () => void
  register(options: Record<string, unknown>, component: (props: Record<string, unknown>) => ReturnType<typeof h> | null): () => void
}

type TabsLike = {
  register(options: {
    id: string
    kind: string
    title: () => string
    guide?: Array<{ order: number; title: () => string; description: () => string; icon: (props: { size?: number; className?: string }) => ReturnType<typeof h> }>
  }): () => void
}

type NavigateLike = { openTab(kind: string, options?: Record<string, unknown>): void }

/** uiSession 缺失时用同一空快照，避免 useSyncExternalStore 每轮新对象导致重渲染循环。 */
const EMPTY_UI_SNAPSHOT: UiCurrentSnapshot = {}

export function apply(ctx: unknown): void {
  const context = ctx as Context & { slots: SlotsLike; sidebarRightTabs: TabsLike; sidebarRight: NavigateLike }
  context.effect(() => {
    const nativeGlyph = (props: { size?: number; className?: string }) => h('svg', { width: props.size ?? 16, height: props.size ?? 16, viewBox: '0 0 16 16', fill: 'none', className: props.className },
      h('ellipse', { cx: 8, cy: 4.2, rx: 5.2, ry: 1.8, stroke: 'currentColor', strokeWidth: 1.2 }),
      h('path', { d: 'M2.8 4.2v7.6c0 1 2.3 1.8 5.2 1.8s5.2-.8 5.2-1.8V4.2', stroke: 'currentColor', strokeWidth: 1.2, fill: 'none' }),
      h('path', { d: 'M2.8 8c0 1 2.3 1.8 5.2 1.8s5.2-.8 5.2-1.8', stroke: 'currentColor', strokeWidth: 1.2, fill: 'none' }))
    const uiCurrent = getUiSession(ctx)?.adapter.current
    const LiveWorkspaceBody = (props: { fallbackSessionId?: string; visible?: boolean }) => {
      const sessions = useSyncExternalStore(fn => context.sessions.list.subscribe(fn), () => context.sessions.list.getSnapshot())
      const uiSnapshot = useSyncExternalStore(
        fn => uiCurrent?.subscribe(fn) ?? (() => {}),
        () => uiCurrent?.getSnapshot() ?? EMPTY_UI_SNAPSHOT)
      const rawUiKey = uiSnapshot.key
      const uiKey = typeof rawUiKey === 'string' && rawUiKey.trim() ? rawUiKey.trim() : ''
      const conversationId = sessions.current || props.fallbackSessionId || uiKey || ''
      if (!conversationId) return h('div', { style: { padding: 16, color: 'var(--dsw-alias-label-secondary, var(--db-muted, #91a2ba))' } }, '请先选择或开始一个 DSH 对话')
      return h('div', { style: { height: '100%', minHeight: 0 } },
        h(DatabaseWorkspace, { conversationId, visible: props.visible !== false, onActive: () => {}, onDialogChange: () => {} }))
    }
    const NativeSidebarBody = (props: TabBodyProps) => {
      props.useTabInfo()
      return h(LiveWorkspaceBody, { fallbackSessionId: props.sessionId, visible: true })
    }
    const openWorkbench = (): void => {
      context.sidebarRight.openTab('database', { revealIfOpened: true })
    }
    const entryChip = () => h('button', {
      type: 'button', title: '数据库', 'aria-label': '打开数据库工作台',
      onClick: () => openWorkbench(),
      style: { boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 10px', border: 0, borderRadius: 8, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 14, fontWeight: 500, lineHeight: '20px', cursor: 'pointer', flexShrink: 0 },
    }, h(Database, { size: 16 }), h('span', {}, '数据库'))
    const disposes: (() => void)[] = []
    try {
      disposes.push(context.slots.inject('conversation.input.left', () => context.slots.register({
        name: 'conversation.input.left', id: 'database-entry', order: 95,
      }, entryChip)))
    } catch { /* host without those slots */ }
    disposes.push(context.sidebarRightTabs.register({
      id: 'database', kind: 'database', title: () => '数据库',
      guide: [{ order: 95, title: () => '数据库', description: () => 'MySQL、Oracle、Redis 与 Kafka 工作台', icon: nativeGlyph }],
    }))
    disposes.push(context.slots.inject('sidebar.right.pane.tab', () => context.slots.register(
      { name: 'sidebar.right.pane.tab', key: 'database' },
      props => h(NativeSidebarBody, props as TabBodyProps))))
    return () => { for (const dispose of disposes) dispose() }
  }, 'database: native sidebar workbench')
}
