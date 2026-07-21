/**
 * Public surface of the aircraft domain.
 *
 * Error contract: factory-core failures pass through untranslated. Callers
 * observe FactoryRegistryError with its stable `code` values (for example
 * INVALID_FACTORY_CONTEXT for a rejected build order) rather than an
 * aircraft-specific error vocabulary. This pass-through is a deliberate
 * decision, not an accident: the domain is a thin composition root over
 * factory-core, and the registry's codes are the supported way to branch on
 * failure.
 */
export * from './catalog'
export * from './registry'
