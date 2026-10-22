import type {Worker} from 'node:worker_threads'
import { workerReplyHeaderValid, type WorkerReply } from '../shared/worker-protocol.ts'
/** Transport ownership only: one matching request, terminal settlement and listener cleanup. */
export function workerExchange<T>(worker:Worker, requestId:string|undefined, timeoutMs:number, signal:AbortSignal|undefined,
 setup:(finish:(error?:Error,value?:T)=>void)=>{message(reply:WorkerReply<T>):void;exit():void;timeout():void;abort?():void;error?(error:Error):void;send():void}):Promise<T> {
 return new Promise((resolve,reject)=>{
  let settled=false, cleanup=()=>{}
  const finish=(error?:Error,value?:T)=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve(value!)}
  const handlers=setup(finish)
  if(settled)return
  const message=(reply:unknown)=>{
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return
    if ((reply as {requestId?:unknown}).requestId !== requestId) return
    if (!workerReplyHeaderValid(reply)) { finish(Object.assign(new Error('Worker 回执协议无效，执行结果需要核验。'), { code: 'PROTOCOL_INVALID', effect: 'unknown', phase: 'receipt' })); return }
    try { handlers.message(reply as WorkerReply<T>) } catch (error) { finish(error instanceof Error ? error : new Error('Worker 回执无法处理。')) }
  }
  const exit=()=>handlers.exit(), abort=()=>handlers.abort?handlers.abort():finish(new Error('请求已取消。')),onError=(error:Error)=>handlers.error?handlers.error(error):finish(error)
  const timer=setTimeout(()=>handlers.timeout(),timeoutMs)
  cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.off('message',message);worker.off('exit',exit);worker.off('error',onError)}
  worker.on('message',message);worker.once('exit',exit);worker.once('error',onError);signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted){abort();return}
  try{handlers.send()}catch(error){finish(error as Error)}
 })
}
