import { supportedAllDataSources } from '../../shared/data-sources/registry.ts'
import { mysqlModule } from './mysql.tsx'
import { oracleModule } from './oracle.tsx'
import { redisModule } from './redis.tsx'
import { kafkaModule } from './kafka.tsx'
import { nacosModule } from './nacos.tsx'
import { createClientModuleRegistry } from './registry-core.ts'

export const clientModules = createClientModuleRegistry([mysqlModule, oracleModule, redisModule, kafkaModule, nacosModule], supportedAllDataSources)
