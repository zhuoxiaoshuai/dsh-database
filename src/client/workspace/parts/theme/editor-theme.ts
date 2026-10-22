import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

export const workbenchHighlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.atom], color: 'var(--db-sql-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--db-sql-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--db-sql-number)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--db-code-property)' },
  { tag: tags.comment, color: 'var(--db-code-comment)', fontStyle: 'italic' },
  { tag: [tags.name, tags.operator, tags.punctuation], color: 'var(--db-text)' },
]))
export const workbenchEditorTheme = EditorView.theme({
  '.cm-scroller': { fontFamily: 'var(--db-mono)', fontSize: 'var(--db-code-size, 13px)', lineHeight: 'var(--db-code-line-height, 1.7)', overscrollBehavior: 'contain' },
  '.cm-content': { caretColor: 'var(--db-text)' },
  '.cm-cursor': { borderLeftColor: 'var(--db-text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--db-selection) !important' },
  '.cm-gutters': { background: 'var(--db-nav)', color: 'var(--db-muted)', borderRight: 'var(--db-border-width) solid var(--db-line)' },
})
