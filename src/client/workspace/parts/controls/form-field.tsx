import React,{useId} from 'react'
export function FormField({label,help,error,children}: {label:React.ReactNode;help?:React.ReactNode;error?:string;children:React.ReactElement}){
  const id=useId(),message=`${id}-message`
  return <div className="db-form-field"><label className="db-form-label" htmlFor={children.props.id??id}>{label}</label>{React.cloneElement(children,{id:children.props.id??id,'aria-describedby':help||error?message:undefined,'aria-invalid':!!error||undefined})}{(help||error)&&<small id={message} className={error?'db-error':'db-muted'}>{error??help}</small>}</div>
}
