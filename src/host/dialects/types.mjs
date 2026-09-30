/**
 * @typedef {object} SqlDialect
 * @property {string} id
 * @property {(value: string) => string} quote
 * @property {(position: number) => string} bindPlaceholder
 * @property {(limit: number, offset?: number) => string} limitClause
 * @property {(left: string, placeholder: string, column?: object) => string} equality
 * @property {RegExp} columnTypePattern
 * @property {string} identityClause
 * @property {boolean} inlineColumnComment
 * @property {boolean} supportsColumnComment
 */

/**
 * DriverSession is the database-driver boundary used by workers and query
 * execution. Driver-native connection objects never escape adapter call sites.
 *
 * @typedef {object} DriverSession
 * @property {string} id
 * @property {SqlDialect} sql
 * @property {(credentials: object, options?: object) => Promise<object>} openCatalog
 * @property {(credentials: object, options?: object) => Promise<object>} openQuery
 * @property {(credentials: object, options?: object) => Promise<object>} openMaintenance
 * @property {(connection: object) => Promise<void>} destroy
 * @property {(connection: object) => void} cancel
 * @property {(connection: object, credentials: object, options?: object) => Promise<object>} probe
 * @property {(connection: object, schema: string) => Promise<void>} prepareReadonly
 * @property {(connection: object) => Promise<void>} reset
 */

export {}
