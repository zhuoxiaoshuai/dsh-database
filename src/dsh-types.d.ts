declare const __DATABASE_CSS__: string
declare module '*.css'
// antlr4 4.13 exports types at src/index.node.d.ts, which is missing from the package.
declare module 'antlr4' {
  export class CharStream {
    constructor(data: string)
  }
  export class CommonTokenStream {
    constructor(tokenSource: unknown)
  }
}
