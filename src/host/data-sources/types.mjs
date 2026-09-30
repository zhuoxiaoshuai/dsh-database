/**
 * @typedef {object} SqlProvider
 * @property {string} id Stable external `dialect` value.
 * @property {'sql'} family
 * @property {{showStatement: boolean, showIndex: boolean, columnComment: boolean}} capabilities
 * @property {{config: Function, validateTarget: Function, fingerprintSuffix: Function}} connection Vendor connection fields and driver config.
 * @property {object} driver Native sessions never leave the worker.
 * @property {{statement: Function, read: Function}} catalog
 * @property {{splitStatements: Function, authorize: Function, extractExplainSql: Function, validateMaintenanceSelect: Function}} policy
 * @property {object} maintenance Vendor transaction and DDL operations.
 * @property {{discardOnCancel: boolean, discardOnTimeout: Function, isFatalCatalog: Function, isFatalQuery: Function, shouldRetryReadonly: Function}} recovery
 */
export {}
