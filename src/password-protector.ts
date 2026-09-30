import { execFile } from 'node:child_process'
import { join } from 'node:path'

export interface PasswordProtector {
  available: boolean
  protect(value: string): Promise<string>
  unprotect(value: string): Promise<string>
}

/** Windows DPAPI: secrets travel over stdin, never command-line arguments. Copied from remote-exec, no package coupling. */
export const windowsPasswordProtector: PasswordProtector = {
  available: process.platform === 'win32',
  protect: value => dpapi('Protect', Buffer.from(value, 'utf8').toString('base64')),
  unprotect: async value => Buffer.from(await dpapi('Unprotect', value), 'base64').toString('utf8'),
}

export const memoryPasswordProtector: PasswordProtector = {
  available: true,
  protect: async value => Buffer.from(value, 'utf8').toString('base64'),
  unprotect: async value => Buffer.from(value, 'base64').toString('utf8'),
}

function dpapi(action: 'Protect' | 'Unprotect', value: string): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error('当前平台不支持密码加密保存'))
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${action}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`
  return new Promise((resolve, reject) => {
    const child = execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 131072 }, (error, stdout) => {
      if (error || !stdout.trim()) reject(new Error('无法使用当前 Windows 账户保存或读取密码，请重新输入密码'))
      else resolve(stdout.trim())
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(value)
  })
}
