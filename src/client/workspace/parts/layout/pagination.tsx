import React from 'react'
import {Button} from '../controls/button.tsx'
export function Pagination({page,total,pageSize,onPage,busy=false}:{page:number;total?:number;pageSize:number;onPage(page:number):void;busy?:boolean}){
  return <div className="db-resource-pager" aria-label="分页"><Button variant="text" disabled={busy||page<=1} onClick={()=>onPage(page-1)}>上一页</Button><span>第 {page} 页{total!==undefined?` · 共 ${total} 条`:''}</span><Button variant="text" disabled={busy||(total!==undefined&&page*pageSize>=total)} onClick={()=>onPage(page+1)}>下一页</Button></div>
}
