import React, {useEffect, useRef} from 'react'
import {EditorState, Compartment} from '@codemirror/state'
import {EditorView, lineNumbers} from '@codemirror/view'
import {textEditorExtensions} from '../workspace/source/text-editor-extensions.ts'
import {json} from '@codemirror/lang-json'
import {yaml} from '@codemirror/lang-yaml'
import {MergeView} from '@codemirror/merge'
import {StreamLanguage, syntaxHighlighting, defaultHighlightStyle} from '@codemirror/language'
import {useEditorHost, hasUserTextChange} from '../workspace/source/editor-host.ts'
const properties = StreamLanguage.define({token(stream) {if (stream.sol() && stream.match(/\s*[#!].*/)) return 'comment'; if (stream.sol() && stream.match(/[^:=]+(?=[:=])/)) return 'propertyName'; stream.next(); return null}})
export function ConfigEditor(props: {value: string; type: string; readOnly?: boolean; onChange(value: string): void}) {
  const readOnly=useRef(new Compartment())
  const readonlyExtensions=()=>[EditorState.readOnly.of(!!props.readOnly),EditorView.editable.of(!props.readOnly)]
  const {root,view} = useEditorHost(props,current => ({extensions:[lineNumbers(),...textEditorExtensions('Nacos 配置正文'), syntaxHighlighting(defaultHighlightStyle),
    props.type === 'json' ? json() : ['yaml','yml'].includes(props.type) ? yaml() : props.type === 'properties' ? properties : [],
    readOnly.current.of(readonlyExtensions()),
    EditorView.updateListener.of(update => {if (hasUserTextChange(update)) current.current.onChange(update.state.doc.toString())})]}))
  useEffect(()=>{view.current?.dispatch({effects:readOnly.current.reconfigure(readonlyExtensions())})},[props.readOnly])
  return <div ref={root} className="db-nacos-editor" />
}
export function ConfigDiff({before,after}: {before: string; after: string}) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!root.current) return
    const extensions = [EditorState.readOnly.of(true),EditorView.editable.of(false),lineNumbers()]
    const view = new MergeView({parent:root.current,a:{doc:before,extensions},b:{doc:after,extensions},highlightChanges:true})
    return () => view.destroy()
  },[before,after])
  return <div ref={root} className="db-nacos-diff" aria-label="配置差异" />
}
