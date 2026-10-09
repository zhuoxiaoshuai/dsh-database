import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep, basename } from 'node:path'

const tag = `dsh-redis-${randomUUID()}`
const root = mkdtempSync(join(tmpdir(), 'dsh-redis-tls-'))
const containers = []
writeFileSync(join(root, 'openssl.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n')
const report = { status: 'FAIL', runId: tag, plain: 'NOT_RUN', tls: 'NOT_RUN', image: 'redis:7.4-alpine', digest: '' }
function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1048576, env: { ...process.env, OPENSSL_CONF: join(root, 'openssl.cnf') } })
  if (result.status !== 0) throw new Error(`${basename(file)} ${args[0]} failed: ${result.error?.message || result.stderr.slice(0, 500)}`)
  return result.stdout.trim()
}
const docker = args => run('docker', args)
const openssl = process.env.DSH_OPENSSL || 'openssl'
function certificate(name, san) {
  run(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, `${name}.key`), '-out', join(root, `${name}.csr`), '-subj', `/CN=${name}`])
  writeFileSync(join(root, `${name}.ext`), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`)
  run(openssl, ['x509', '-req', '-in', join(root, `${name}.csr`), '-CA', join(root, 'ca.crt'), '-CAkey', join(root, 'ca.key'), '-CAcreateserial', '-days', '2', '-out', join(root, `${name}.crt`), '-extfile', join(root, `${name}.ext`)])
}
async function start(cert) {
  const name = `dsh-redis-${randomUUID().slice(0, 8)}`
  const args = ['run', '-d', '--name', name, '--label', `dsh.run=${tag}`, '-p', '127.0.0.1::6379']
  if (cert) args.push('--mount', `type=bind,source=${root},target=/certs,readonly`)
  args.push(report.digest)
  if (cert) args.push('redis-server', '--port', '0', '--tls-port', '6379', '--tls-cert-file', `/certs/${cert}.crt`, '--tls-key-file', `/certs/${cert}.key`, '--tls-ca-cert-file', '/certs/ca.crt', '--tls-auth-clients', 'no', '--save', '', '--appendonly', 'no')
  const id = docker(args)
  assert.match(id, /^[a-f0-9]{64}$/)
  containers.push({ id, name })
  const port = Number(docker(['port', id, '6379/tcp']).match(/:(\d+)\s*$/)?.[1])
  assert.ok(port > 0)
  const deadline = Date.now() + 15000
  while (true) {
    const ping = spawnSync('docker', ['exec', id, 'redis-cli', ...(cert ? ['--tls', '--cacert', '/certs/ca.crt'] : []), 'PING'], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
    if (ping.status === 0 && ping.stdout.trim() === 'PONG') return port
    if (Date.now() >= deadline) throw new Error('Owned Redis fixture did not become ready')
    await new Promise(done => setTimeout(done, 250))
  }
}
try {
  run(openssl, ['version'])
  docker(['pull', report.image])
  report.digest = JSON.parse(docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', report.image]))[0]
  assert.match(report.digest, /^redis@sha256:[a-f0-9]{64}$/)
  run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'ca.key'), '-out', join(root, 'ca.crt'), '-days', '2', '-subj', '/CN=DSH disposable CA', '-addext', 'basicConstraints=critical,CA:TRUE'])
  run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'wrong.key'), '-out', join(root, 'wrong.crt'), '-days', '2', '-subj', '/CN=DSH unrelated CA'])
  certificate('server', 'DNS:localhost,IP:127.0.0.1')
  certificate('mismatch', 'DNS:wrong.invalid')
  const port = await start()
  const tlsPort = await start('server')
  const mismatchPort = await start('mismatch')
  const child = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/redis-acceptance.mjs'], {
    env: { ...process.env, DSH_REDIS_STAGE_REPORT: join(root, 'stages.json'), DSH_REDIS_TEST_PORT: String(port), DSH_REDIS_TLS_TEST: '1', DSH_REDIS_TLS_PORT: String(tlsPort), DSH_REDIS_TLS_MISMATCH_PORT: String(mismatchPort), DSH_REDIS_CA_PATH: join(root, 'ca.crt'), DSH_REDIS_WRONG_CA_PATH: join(root, 'wrong.crt') }, stdio: 'inherit', windowsHide: true,
  })
  if (existsSync(join(root, 'stages.json'))) Object.assign(report, JSON.parse(readFileSync(join(root, 'stages.json'), 'utf8')))
  if (child.status !== 0) throw new Error(`Redis acceptance exited ${child.status}`)
  assert.equal(report.plain, 'PASS'); assert.equal(report.tls, 'PASS'); report.status = 'PASS'
} catch (error) {
  report.error = error.message
  process.exitCode = 1
} finally {
  for (const { id, name } of containers) {
    assert.equal(docker(['inspect', '-f', '{{index .Config.Labels "dsh.run"}}', id]), tag)
    assert.equal(docker(['inspect', '-f', '{{.Name}}', id]), `/${name}`)
    docker(['rm', '-f', id])
  }
  const target = resolve(root), parent = resolve(tmpdir())
  assert.ok(target.startsWith(parent + sep) && basename(target).startsWith('dsh-redis-tls-'))
  rmSync(target, { recursive: true, force: true })
  console.log(JSON.stringify(report))
}
