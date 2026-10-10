import type {Worker} from 'node:worker_threads'
/** Transport ownership only: one matching request, terminal settlement and listener cleanup. */
export function workerExchange<T>(worker:Worker, requestId:string|undefined, timeoutMs:number, signal:AbortSignal|undefined,
 setup:(finish:(error?:Error,value?:T)=>void)=>{message(reply:any):void;exit():void;timeout():void;abort?():void;error?(error:Error):void;send():void}):Promise<T> {
 return new Promise((resolve,reject)=>{
  let settled=false, cleanup=()=>{}
  const finish=(error?:Error,value?:T)=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve(value!)}
  const handlers=setup(finish)
  if(settled)return
  const message=(reply:any)=>{if(reply.requestId===requestId)handlers.message(reply)}
  const exit=()=>handlers.exit(), abort=()=>handlers.abort?handlers.abort():finish(new Error('请求已取消。')),onError=(error:Error)=>handlers.error?handlers.error(error):finish(error)
  const timer=setTimeout(()=>handlers.timeout(),timeoutMs)
  cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.off('message',message);worker.off('exit',exit);worker.off('error',onError)}
  worker.on('message',message);worker.once('exit',exit);worker.once('error',onError);signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted){abort();return}
  try{handlers.send()}catch(error){finish(error as Error)}
 })
}
