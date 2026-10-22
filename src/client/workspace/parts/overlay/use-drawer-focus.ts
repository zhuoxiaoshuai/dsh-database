import {useEffect,useId,type RefObject} from 'react'
import {useDialog} from './dialog.ts'
/** Drawers and dialogs share keyboard ownership, including portal children. */
export function useDrawerFocus(open:boolean,panel:RefObject<HTMLElement|null>,trigger:RefObject<HTMLElement|null>,close:()=>void){
  const id=useId()
  useEffect(()=>{const node=panel.current;if(!node||!open)return;const previous=node.dataset.dbDialogId;node.dataset.dbDialogId=id;return()=>{if(previous===undefined)delete node.dataset.dbDialogId;else node.dataset.dbDialogId=previous}},[open,id,panel])
  useDialog(panel,close,open,trigger)
}
