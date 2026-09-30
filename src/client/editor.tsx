import React, { useEffect, useRef } from 'react'
import { Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { sql, MySQL, PLSQL } from '@codemirror/lang-sql'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { closeCompletion } from '@codemirror/autocomplete'
import type { Connection, Dialect, SqlDialect } from '../shared/workbench.ts'
import type { SchemaCache } from './schema/schema-cache.ts'
import { createEditorCompletionRefresh, createSqlCompletionSource, opensTableSlot } from './sql/completion/source.ts'
import { createCompletionInteraction } from './completion/interaction.ts'
import { useEditorHost } from './workspace/source/editor-host.ts'
import { clientWorkspaceDescriptor } from '../shared/data-sources/registry.ts'

function dialectSupport(dialect: Dialect) {
  const source = clientWorkspaceDescriptor(dialect)
  if (source.family !== 'sql') throw new Error('此数据源不使用 SQL 编辑器。')
  const dialects = { mysql: MySQL, oracle: PLSQL } satisfies Record<SqlDialect, typeof MySQL>
  return sql({ dialect: dialects[source.id] })
}

export function SqlEditor(props: {
  value: string
  dialect: Dialect
  schema: string
  connection?: Connection
  cache?: SchemaCache
  visible?: boolean
  onChange(value: string): void
  onSelectionChange?(text: string): void
  onCursorChange?(offset: number): void
  onRun(selection?: string, mode?: 'current' | 'all'): void
  onSave?(): void
}) {
  const dialectConf = useRef(new Compartment())
  const refreshCompletions = useRef(createEditorCompletionRefresh())
  const { root, view, current } = useEditorHost(props, current => {
    const source = createSqlCompletionSource(() => current.current)
    const interaction = createCompletionInteraction(source, { activateOnCompletion: completion => opensTableSlot(completion.label) })
    return { extensions: [
      lineNumbers(), history(), drawSelection(), ...interaction.extensions, syntaxHighlighting(HighlightStyle.define([
        { tag: tags.keyword, color: 'var(--db-sql-keyword)' },
        { tag: [tags.string, tags.special(tags.string)], color: 'var(--db-sql-string)' },
        { tag: [tags.number, tags.bool, tags.null], color: 'var(--db-sql-number)' },
        { tag: tags.comment, color: 'var(--db-muted)', fontStyle: 'italic' },
        { tag: [tags.name, tags.operator, tags.punctuation], color: 'var(--db-text)' },
      ])),
      dialectConf.current.of(dialectSupport(current.current.dialect)),
      keymap.of([
        { key: 'Mod-Enter', run: editor => {
          const selection = editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to)
          current.current.onRun(selection.trim() ? selection : undefined, selection.trim() ? 'current' : 'all')
          return true
        } },
        { key: 'Mod-Shift-Enter', run: () => {
          current.current.onRun(undefined, 'all')
          return true
        } },
        { key: 'Mod-s', run: () => {
          if (current.current.onSave) { current.current.onSave(); return true }
          return false
        } },
        ...defaultKeymap, ...historyKeymap, indentWithTab,
      ]),
      EditorView.contentAttributes.of({ 'aria-label': 'SQL 编辑器', 'spellcheck': 'false' }),
      EditorView.updateListener.of(update => {
        if (update.docChanged) current.current.onChange(update.state.doc.toString())
        if (update.docChanged || update.selectionSet) {
          const text = update.state.sliceDoc(update.state.selection.main.from, update.state.selection.main.to)
          current.current.onSelectionChange?.(text)
          current.current.onCursorChange?.(update.state.selection.main.head)
        }
      }),
      // 注意：tooltips parent=document.body 时，CodeMirror 会把编辑器 themeClasses 复制给 body 下的
      // tooltip 容器，theme 的 '&' 选择器会命中它导致 height:100% 撑高整页——编辑器本体样式必须
      // 写在 style.css 的 .db-editor>.cm-editor 下，不能出现在 theme '&' 键里。
      EditorView.theme({
        '.cm-scroller': { fontFamily: 'var(--ds-font-family-code, var(--db-mono, Consolas, monospace))', lineHeight: '1.85', overflow: 'auto', overscrollBehavior: 'contain' },
        '.cm-content': { padding: '18px 0' },
        '.cm-gutters': { background: 'transparent', border: 'none', color: 'var(--db-muted)', padding: '0 8px 0 14px' },
        '.cm-cursor': { borderLeftColor: 'var(--db-text)' },
        '.cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground': { background: 'var(--db-selection) !important' },
        '&.cm-focused .cm-selectionBackground, &.cm-focused .cm-selectionLayer .cm-selectionBackground': { background: 'var(--db-selection) !important' },
        '&.cm-focused': { outline: 'none' },
      }),
    ], dispose: interaction.dispose }
  })
  useEffect(() => {
    const instance = view.current
    if (!instance) return
    instance.dispatch({ effects: dialectConf.current.reconfigure(dialectSupport(props.dialect)) })
  }, [props.dialect])
  useEffect(() => {
    if (props.visible !== false) return
    const instance = view.current
    if (instance) closeCompletion(instance)
  }, [props.visible])
  useEffect(() => {
    if (!props.cache) return
    return props.cache.subscribe(() => {
      const instance = view.current
      if (!instance) return
      refreshCompletions.current(instance, current.current)
    })
  }, [props.cache])
  return <div className="db-editor" ref={root} />
}
