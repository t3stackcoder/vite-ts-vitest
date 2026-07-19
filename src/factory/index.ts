/**
 * Curated public surface of the factory harness. Every export here is a
 * supported API; anything not re-exported (internal Zod schemas, error
 * normalization helpers) is an implementation detail that may change without
 * notice. The public-API test pins this list — additions are deliberate,
 * reviewed decisions.
 */
export {
  factoryAlias,
  factoryAliasSet,
  factoryKey,
  factoryKeySet,
  factoryNamespace,
  isFactoryAlias,
  isFactoryKey,
  modulePath,
} from './brand'
export type {
  Brand,
  FactoryAlias,
  FactoryAliasSet,
  FactoryKey,
  FactoryKeySegment,
  FactoryKeySet,
  FactoryKeyValue,
  FactoryLookupLiteral,
  FactoryNamespace,
  ModulePath,
} from './brand'
export {
  defineFactoryCatalog,
  defineFactoryFor,
  factoryCatalogEntry,
  factoryContract,
} from './contracts'
export type {
  AbstractFactory,
  Awaitable,
  CanonicalFactoryKey,
  CatalogFactory,
  CatalogFactoryModule,
  EmptyFactoryAliasMap,
  FactoryAliasMap,
  FactoryCatalog,
  FactoryCatalogEntry,
  FactoryCatalogKey,
  FactoryContextForLookup,
  FactoryContract,
  FactoryCreateOptions,
  FactoryFor,
  FactoryForLookup,
  FactoryLookupKey,
  FactoryMetadata,
  FactoryModule,
  FactoryRawResultForLookup,
  FactoryResultForLookup,
  FactorySource,
  FactoryValidatedContextForLookup,
  InferFactoryContext,
  InferFactoryInput,
  InferFactoryRawResult,
  InferFactoryResult,
} from './contracts'
export {
  FACTORY_REGISTRY_ERROR_CODES,
  FactoryRegistryError,
  isFactoryRegistryError,
} from './errors'
export type {
  FactoryRegistryErrorCode,
  FactoryRegistryErrorOptions,
} from './errors'
export { createFilenameKeyResolver, createGlobFactorySources } from './glob'
export type {
  FilenameKeyResolverOptions,
  GlobFactorySourceOptions,
  GlobLoaderMap,
} from './glob'
export { factoryHarnessFor } from './harness'
export type { FactoryHarnessOptions } from './harness'
export { SmartFactoryRegistry, smartFactoryRegistryFor } from './registry'
export type {
  CircuitBreakerOptions,
  FactoryAttempt,
  FactoryCircuitSnapshot,
  FactoryCircuitStatus,
  FactoryLoadStatus,
  FactoryPolicyMap,
  FactoryPolicyOverrides,
  FactoryPreloadFailure,
  FactoryPreloadReport,
  FactoryRegistrationSnapshot,
  FactoryRegistryEvent,
  FactoryRegistryEventListener,
  FactoryRegistrySnapshot,
  SmartFactoryRegistryOptions,
} from './registry'
