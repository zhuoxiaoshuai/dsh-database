import React from 'react'
import {X} from 'lucide-react'
import {IconButton} from '../controls/button.tsx'
export function DrawerBackdrop({label,close,className='db-panel-backdrop'}:{label:string;close():void;className?:string}){
  return <button type="button" className={className} aria-label={label} onClick={close} tabIndex={-1}/>
}
export function DrawerClose({label,close,className=''}:{label:string;close():void;className?:string}){
  return <IconButton label={label} onClick={close} className={className}><X size={16}/></IconButton>
}
