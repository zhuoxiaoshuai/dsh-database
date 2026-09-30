import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Only the static registrations of the test bundle change; production business code stays byte-for-byte intact. */
export function sourceFixtureRegistrations() {
  const host = JSON.stringify(resolve('test/fixtures/source-module-host.ts'))
  const client = JSON.stringify(resolve('test/fixtures/source-module-client.tsx'))
  const edits = [
    ['src/shared/data-sources/registry.ts', `import { mockDescriptor } from ${host}\n`, 'mysqlSource, oracleSource, redisSource, kafkaSource,', 'mysqlSource, oracleSource, redisSource, kafkaSource, mockDescriptor,', "['mysql', 'oracle', 'redis', 'kafka']", "['mysql', 'oracle', 'redis', 'kafka', 'mock-source']"],
    ['src/host/data-sources/modules.ts', `import { mockHostModule } from ${host}\n`, '[mysqlModule, oracleModule, redisModule, kafkaModule]', '[mysqlModule, oracleModule, redisModule, kafkaModule, mockHostModule]'],
    ['src/host/data-sources/runtime-registry.mjs', `import { mockRuntime } from ${host}\n`, '[mysqlRuntime, oracleRuntime, redisRuntime, kafkaRuntime]', '[mysqlRuntime, oracleRuntime, redisRuntime, kafkaRuntime, mockRuntime]'],
    ['src/host/knowledge-policy-registry.ts', `import { mockPolicy } from ${host}\n`, '[redisKnowledgePolicy, kafkaKnowledgePolicy]', '[redisKnowledgePolicy, kafkaKnowledgePolicy, mockPolicy]', "['redis' as DataSourceId, 'kafka' as DataSourceId]", "['redis' as DataSourceId, 'kafka' as DataSourceId, 'mock-source']"],
    ['src/client/data-sources/registry.ts', `import { mockClientModule } from ${client}\n`, '[mysqlModule, oracleModule, redisModule, kafkaModule]', '[mysqlModule, oracleModule, redisModule, kafkaModule, mockClientModule]'],
  ]
  return { name: 'test-only-static-source', setup(build) {
    build.onLoad({ filter: /(?:registry|modules|runtime-registry|knowledge-policy-registry)\.(?:ts|mjs)$/ }, async args => {
      const edit = edits.find(item => resolve(item[0]) === args.path)
      if (!edit) return
      let contents = await readFile(args.path, 'utf8')
      for (let i = 2; i < edit.length; i += 2) {
        assert.equal(contents.split(edit[i]).length, 2, `Test registration changed: ${edit[0]}`)
        contents = contents.replace(edit[i], edit[i + 1])
      }
      return { contents: edit[1] + contents, loader: 'ts' }
    })
  } }
}
