import { parentPort, workerData } from 'node:worker_threads'
import { inspectSyntax } from './parse.mjs'
try { parentPort.postMessage({ ok: true, result: inspectSyntax(workerData.dialect, workerData.sql) }) }
catch { parentPort.postMessage({ ok: false, code: 'PARSE_FAILED' }) }
