import React, {useId,useRef} from 'react'
import {X} from 'lucide-react'
import {useDialog,useBackdropDismiss} from './dialog.ts'
import {IconButton} from '../controls/button.tsx'
export function DialogFrame({title,ariaLabel,close,busy=false,children,footer,context,size='form',className='',closeLabel='关闭',onSubmit,onInvalidCapture}: {
  title:string;ariaLabel?:string;close():void;busy?:boolean;children:React.ReactNode;footer?:React.ReactNode;context?:React.ReactNode;
  size?:'confirm'|'form'|'wide';className?:string;closeLabel?:string;onSubmit?:React.FormEventHandler<HTMLFormElement>;onInvalidCapture?:React.FormEventHandler<HTMLFormElement>;
}) {
  const ref=useRef<HTMLElement>(null),id=useId()
  const dismiss=()=>{if(!busy)close()}
  useDialog(ref,dismiss);const backdrop=useBackdropDismiss(dismiss)
  const heading=<header className="db-dialog-heading"><div><h2>{title}</h2>{context&&<div className="db-dialog-context">{context}</div>}</div><IconButton label={closeLabel} disabled={busy} onClick={dismiss}><X size={16}/></IconButton></header>
  const body=<>{heading}<div className="db-dialog-body">{children}</div>{footer&&<footer className="db-dialog-footer">{footer}</footer>}</>
  const attributes={className:`db-dialog db-dialog-${size} ${className}`,role:'dialog','aria-modal':true as const,'aria-label':ariaLabel??title,'data-db-dialog-id':id,tabIndex:-1}
  return <div className="db-overlay db-modal" {...backdrop}>{onSubmit?<form {...attributes} ref={ref as React.RefObject<HTMLFormElement>} onSubmit={onSubmit} onInvalidCapture={onInvalidCapture}>{body}</form>:<div {...attributes} ref={ref as React.RefObject<HTMLDivElement>}>{body}</div>}</div>
}
