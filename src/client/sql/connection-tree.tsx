import React, {useEffect} from 'react'
import {SchemaTreeNode} from '../schema-tree-node.tsx'
import {TreeRetryHint} from '../workspace/tree/tree-loading-icon.tsx'
import {refreshCatalogLayer} from '../schema/refresh.ts'
import {catalogSchemaName, visibleCatalogChildren, type Connection} from '../../shared/workbench.ts'
import {dialectCapabilities} from '../../shared/dialect-capabilities.ts'
import {sqlCatalogFilterCopy} from '../workspace/shell/catalog-filter-copy.ts'
import type {SchemaCache} from '../schema/schema-cache.ts'
import type {TreeFocus} from '../tree-focus.ts'
type Kind='table'|'view'
export function SqlConnectionTree({item,cache,selected,schema,search,treeFocus,onPick,onActivateSchema,onShowHomeFolder,onFocus,onHighlight,onSyncListHighlight,onOpen,onMenu}: {
 item:Connection;cache:SchemaCache;selected:boolean;schema:string;search:string;treeFocus?:TreeFocus;onPick():void;
 onActivateSchema(name:string):void;onShowHomeFolder(name:string,kind:Kind):void;onFocus(focus:TreeFocus):void;
 onHighlight(name:string,kind:Kind):void;onSyncListHighlight(name:string,kind:Kind):void;onOpen(schema:string,name:string,kind:Kind):void;
 onMenu(event:React.MouseEvent,schema:string,name:string,kind:Kind):void
}) {
 const schemas=cache.schemasSnapshot(item)||[], status=cache.schemasStatus(item)
 const schemasBusy=status?.status==='loading', schemasError=status?.status==='error'?status.error:''
 useEffect(()=>{const controller=new AbortController();void cache.loadSchemas(item,{signal:controller.signal}).catch(()=>{});return()=>controller.abort()},[cache,item.id,item.generation])
 const children=schemas.flatMap(row=>{const name=catalogSchemaName(row);return name?[{id:name,label:name}]:[]})
 const visibleSchemas=visibleCatalogChildren(children,item.workbench?.visibleSchemas,{currentId:schema,search,caseInsensitive:dialectCapabilities(item.dialect).namespaceCaseInsensitive})
 return <>
      {visibleSchemas.map(row => {
        const name = row.id
        return <SchemaTreeNode
          key={name}
          name={name}
          connection={item}
          cache={cache}
          active={selected && schema === name}
          search={search}
          treeFocus={treeFocus}
          onActivate={() => onActivateSchema(name)}
          onShowHomeFolder={kind => onShowHomeFolder(name, kind)}
          onFocus={onFocus}
          onHighlight={(tableName, kind) => { onActivateSchema(name); onHighlight(tableName, kind) }}
          onSyncListHighlight={(tableName, kind) => { onActivateSchema(name); onSyncListHighlight(tableName, kind) }}
          onOpen={onOpen}
          onMenu={onMenu}
        />
      })}
      {schemasBusy && !visibleSchemas.length && <p className="db-muted db-tree-hint">正在读取数据库…</p>}
      {schemasError && <TreeRetryHint text={schemasError} onRetry={() => { onPick(); void refreshCatalogLayer(cache, item, { layer: 'connection' }).catch(() => {}) }} />}
      {!schemasBusy && !schemasError && !visibleSchemas.length && <p className="db-muted db-tree-hint">{sqlCatalogFilterCopy.emptyTree}</p>}
  </>
}
