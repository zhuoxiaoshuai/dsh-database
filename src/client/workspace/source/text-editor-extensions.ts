import {EditorState, type Extension} from '@codemirror/state'
import {EditorView, keymap} from '@codemirror/view'
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands'
/** Text editing only. Completion, dialect and source limits remain caller-owned. */
export function textEditorExtensions(label:string, maxLength?:number, run?:(text:string)=>void):Extension[] {
 return [history(),EditorView.lineWrapping,...(maxLength===undefined?[]:[EditorState.changeFilter.of(transaction=>transaction.newDoc.length<=maxLength)]),
 keymap.of([...(run?[{key:'Mod-Enter',run:(editor:EditorView)=>{run(editor.state.doc.toString());return true}}]:[]),...defaultKeymap,...historyKeymap]),
 EditorView.contentAttributes.of({'aria-label':label,spellcheck:'false'})]
}
