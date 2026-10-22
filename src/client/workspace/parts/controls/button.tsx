import React, {forwardRef} from 'react'
export type ButtonProps=React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'primary'|'normal'|'text'|'danger';busy?:boolean}
export const Button=forwardRef<HTMLButtonElement,ButtonProps>(function Button({variant='normal',busy=false,className='',children,disabled,...props},ref){
  return <button {...props} ref={ref} type={props.type??'button'} className={`${{primary:'db-primary',normal:'db-btn',text:'db-text-button',danger:'db-danger-button'}[variant]} ${className}`} disabled={disabled||busy} aria-busy={busy||undefined}>{children}</button>
})
export const IconButton=forwardRef<HTMLButtonElement,React.ButtonHTMLAttributes<HTMLButtonElement>&{label:string}>(function IconButton({label,className='',...props},ref){
  return <button {...props} ref={ref} type={props.type??'button'} aria-label={label} title={props.title??label} className={`db-icon-button ${className}`}/>
})
