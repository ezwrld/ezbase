import type { AppliedFilter } from './rules.js'

declare module 'hono' {
  interface ContextVariableMap {
    role: string
    userId: string | undefined
    claims: Record<string, unknown>
    docFilters: AppliedFilter[] | undefined
    storageOwnerFilter: boolean | undefined
  }
}
