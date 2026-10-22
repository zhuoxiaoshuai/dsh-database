import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {SqlTemplateStore} from '../src/host/sql-template-store.ts'
import {KnowledgeService} from '../src/host/knowledge-service.ts'
const out='artifacts/ui/knowledge-archive';mkdirSync(out,{recursive:true});const evidence=[];
for(const sourceId of ['mysql','oracle','redis','kafka'])for(const entry of ['duplicates','tidy'])for(const changed of [false,true]){
 const root=mkdtempSync(out+'/store-'),store=new SqlTemplateStore(root),service=new KnowledgeService(store),sql=['mysql','oracle'].includes(sourceId),connectionId='audit';
 const record={sourceId,entry,changed,status:'PASS'};
 try{
  let keep,target;
  if(sql){keep=await store.dispatch({action:'template-publish',publishAction:'create',connectionId,dialect:sourceId,sql:'SELECT id FROM orders',title:'Keep'});target=await store.publish({action:'variant',connectionId,dialect:sourceId,targetId:keep.id,expectedVersion:keep.version,sql:keep.originalSql,title:'Target'})}
  else{const text=sourceId==='redis'?'GET keep':'TOPICS';keep=store.publishKnowledge({sourceId,connectionId,text,title:'Keep'});const other=store.publishKnowledge({sourceId,connectionId,text:sourceId==='redis'?'GET other':'GROUPS',title:'Target'});target=store.publishKnowledge({sourceId,connectionId,id:other.id,expectedVersion:other.version,text,title:'Target'})}
  await store.whenIdle();
  const guards=(sql?store.clusterPublished(connectionId,sourceId):store.clusterKnowledge(sourceId,connectionId)).flatMap(g=>g.members).filter(x=>[keep.id,target.id].includes(x.id)).map(x=>({id:x.id,archiveGuard:x.archiveGuard}));
  const proposal=entry==='tidy'?store.proposeTidy({sourceId,connectionId,changes:[{id:target.id,kind:'archive'}]}):undefined;
  if(changed){
   if(sql)await store.publish({action:'mergeMeta',dialect:sourceId,connectionId,targetId:target.id,expectedVersion:target.version,sql:target.originalSql,summary:'New author metadata'});
   else store.publishKnowledge({sourceId,connectionId,id:target.id,expectedVersion:target.version,text:target.text,title:'New author title'});
  }
  const before=readFileSync(store.path,'utf8');let rejected=false;
  try{const result=await service.dispatch(sourceId,connectionId,{action:(sql?'template-':'knowledge-')+(entry==='tidy'?'tidy-apply':'archive-duplicates'),batchId:proposal?.id,keepId:keep.id,ids:[target.id],guards});record.receipt=result;rejected=!!result.failed?.length}
  catch(error){record.rejection=error.message;rejected=true}
  record.rejected=rejected;record.diskUnchanged=before===readFileSync(store.path,'utf8');
  assert.equal(rejected,changed,'stale archive decision must conflict');if(changed)assert.equal(record.diskUnchanged,true,'rejected decision cannot mutate durable state');
  const read=id=>sql?store.get(id):store.getKnowledge(sourceId,id,connectionId);assert.ok(read(keep.id));assert.equal(!!read(target.id),changed);
 }catch(error){record.status='FAIL';record.error=error.message}
 evidence.push(record);console.log(JSON.stringify(record));
}
writeFileSync(out+'/result.json',JSON.stringify({status:evidence.some(x=>x.status==='FAIL')?'FAIL':'PASS',checks:evidence.length,evidence},null,2));
process.exitCode=evidence.some(x=>x.status==='FAIL')?1:0;
