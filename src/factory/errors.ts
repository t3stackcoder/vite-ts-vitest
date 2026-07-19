export const FACTORY_REGISTRY_ERROR_CODES = [
  'ABORTED',
  'ALIAS_COLLISION',
  'CIRCUIT_OPEN',
  'DUPLICATE_FACTORY',
  'FACTORY_BUSY',
  'FACTORY_CREATION_FAILED',
  'FACTORY_CREATION_TIMEOUT',
  'FACTORY_KEY_MISMATCH',
  'FACTORY_PRODUCT_TYPE_MISMATCH',
  'INTERNAL_ERROR',
  'INVALID_EXECUTION_OPTIONS',
  'INVALID_FACTORY_CONTEXT',
  'INVALID_FACTORY_MODULE',
  'INVALID_FACTORY_RESULT',
  'INVALID_POLICY',
  'INVALID_SOURCE',
  'MODULE_LOAD_FAILED',
  'MODULE_LOAD_TIMEOUT',
  'UNKNOWN_ALIAS_TARGET',
  'UNKNOWN_FACTORY',
] as const

export type FactoryRegistryErrorCode =
  (typeof FACTORY_REGISTRY_ERROR_CODES)[number]

export interface FactoryRegistryErrorOptions {
  readonly cause?: unknown
  readonly details?: Readonly<Record<string, unknown>>
}

export class FactoryRegistryError extends Error {
  readonly code: FactoryRegistryErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: FactoryRegistryErrorCode,
    message: string,
    options: FactoryRegistryErrorOptions = {},
  ) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined)
    this.name = 'FactoryRegistryError'
    this.code = code
    this.details = Object.freeze({ ...options.details })
  }
}

export function isFactoryRegistryError(
  error: unknown,
): error is FactoryRegistryError {
  return error instanceof FactoryRegistryError
}

export function normalizeFactoryRegistryError(
  error: unknown,
  message = 'The factory registry failed unexpectedly.',
): FactoryRegistryError {
  if (isFactoryRegistryError(error)) {
    return error
  }

  return new FactoryRegistryError('INTERNAL_ERROR', message, { cause: error })
}
