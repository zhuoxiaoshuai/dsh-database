import React, {useEffect, useRef} from 'react'
import {EditorState, Compartment} from '@codemirror/state'
import {EditorView, lineNumbers} from '@codemirror/view'
import {textEditorExtensions} from '../workspace/parts/controls/text-editor-extensions.ts'
import {json} from '@codemirror/lang-json'
import {yaml} from '@codemirror/lang-yaml'
import {xml} from '@codemirror/lang-xml'
import {html} from '@codemirror/lang-html'
import {normalizeNacosConfigType,nacosConfigValidationNote} from '../../shared/nacos-config-types.mjs'
import {StreamLanguage} from '@codemirror/language'
import {workbenchHighlighting, workbenchEditorTheme} from '../workspace/parts/theme/editor-theme.ts'
import {useEditorHost, hasUserTextChange} from '../workspace/parts/hooks/editor-host.ts'
import {TextDiff, type TextDiffIssue} from '../workspace/parts/layout/text-diff.tsx'
const properties = StreamLanguage.define({token(stream) {if (stream.sol() && stream.match(/\s*[#!].*/)) return 'comment'; if (stream.sol() && stream.match(/[^:=]+(?=[:=])/)) return 'propertyName'; stream.next(); return null}})
function configLanguage(type:string) {
  switch(normalizeNacosConfigType(type)) {case 'json':return json();case 'yaml':return yaml();case 'xml':return xml();case 'html':return html();case 'properties':return properties;default:return []}
}
export function ConfigEditor(props: {value: string; type: string; readOnly?: boolean; focusRequest?:number; onChange(value: string): void}) {
  const readOnly=useRef(new Compartment())
  const language=useRef(new Compartment())
  const languageExtensions=()=>configLanguage(props.type)
  const readonlyExtensions=()=>[EditorState.readOnly.of(!!props.readOnly),EditorView.editable.of(!props.readOnly)]
  const {root,view} = useEditorHost(props,current => ({extensions:[lineNumbers(),...textEditorExtensions('Nacos 配置正文'), workbenchHighlighting, workbenchEditorTheme,
    language.current.of(languageExtensions()),
    readOnly.current.of(readonlyExtensions()),
    EditorView.updateListener.of(update => {if (hasUserTextChange(update)) current.current.onChange(update.state.doc.toString())})]}))
  useEffect(()=>{view.current?.dispatch({effects:readOnly.current.reconfigure(readonlyExtensions())})},[props.readOnly])
  useEffect(()=>{view.current?.dispatch({effects:language.current.reconfigure(languageExtensions())})},[props.type])
  useEffect(()=>{if(!props.focusRequest)return;const frame=requestAnimationFrame(()=>view.current?.focus());return()=>cancelAnimationFrame(frame)},[props.focusRequest])
  return <div ref={root} className="db-nacos-editor" />
}
type FormatIssue = TextDiffIssue & { code: string }
const noIssues: FormatIssue[] = []
export function ConfigDiff({ before, after, type = 'text', issues = noIssues, autoFocus = false }: { before: string; after: string; type?: string; issues?: FormatIssue[]; autoFocus?: boolean }) {
  return <TextDiff before={before} after={after} extensions={[configLanguage(type)]} extensionKey={type} issues={issues} note={nacosConfigValidationNote(type) || undefined} beforeLabel="变更前 / 历史版本" afterLabel="变更后 / 当前版本" autoFocus={autoFocus} label="配置差异" />
}
