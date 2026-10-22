import React from 'react'
export function EmptyState({children,action,loading=false}:{children:React.ReactNode;action?:React.ReactNode;loading?:boolean}){
  return <div className="db-empty-state" role={loading?'status':undefined} aria-busy={loading||undefined}><span>{children}</span>{action}</div>
}
