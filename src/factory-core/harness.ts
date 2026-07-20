import type {
  CatalogFactoryModule,
  EmptyFactoryAliasMap,
  FactoryAliasMap,
  FactoryCatalog,
  FactoryCatalogKey,
} from './contracts'
import {
  createGlobFactorySources,
  type GlobFactorySourceOptions,
  type GlobLoaderMap,
} from './glob'
import {
  type CircuitBreakerOptions,
  type FactoryPolicyMap,
  type FactoryRegistryEventListener,
  SmartFactoryRegistry,
  type SmartFactoryRegistryOptions,
} from './registry'

export interface FactoryHarnessOptions<
  Catalog extends FactoryCatalog,
  Aliases extends FactoryAliasMap<Catalog> = EmptyFactoryAliasMap,
> extends GlobFactorySourceOptions<Catalog> {
  readonly aliases?: Aliases
  readonly cacheFailures?: boolean
  readonly circuitBreaker?: CircuitBreakerOptions
  readonly creationTimeoutMs?: number
  readonly loadTimeoutMs?: number
  readonly maxConcurrentCreations?: number
  readonly modules: GlobLoaderMap<CatalogFactoryModule<Catalog>>
  readonly onEvent?: FactoryRegistryEventListener<FactoryCatalogKey<Catalog>>
  readonly policies?: FactoryPolicyMap<Catalog>
}

export function factoryHarnessFor<const Catalog extends FactoryCatalog>(
  catalog: Catalog,
) {
  return <
    const Aliases extends FactoryAliasMap<Catalog> = EmptyFactoryAliasMap,
  >(
    options: FactoryHarnessOptions<Catalog, Aliases>,
  ): SmartFactoryRegistry<Catalog, Aliases> => {
    const sources = createGlobFactorySources(options.modules, {
      ...(options.allowEmpty === undefined
        ? {}
        : { allowEmpty: options.allowEmpty }),
      keyFromPath: options.keyFromPath,
    })

    const registryOptions: SmartFactoryRegistryOptions<Catalog, Aliases> = {
      ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
      ...(options.cacheFailures === undefined
        ? {}
        : { cacheFailures: options.cacheFailures }),
      ...(options.circuitBreaker === undefined
        ? {}
        : { circuitBreaker: options.circuitBreaker }),
      ...(options.creationTimeoutMs === undefined
        ? {}
        : { creationTimeoutMs: options.creationTimeoutMs }),
      ...(options.loadTimeoutMs === undefined
        ? {}
        : { loadTimeoutMs: options.loadTimeoutMs }),
      ...(options.maxConcurrentCreations === undefined
        ? {}
        : { maxConcurrentCreations: options.maxConcurrentCreations }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.policies === undefined
        ? {}
        : { policies: options.policies }),
      sources,
      catalog,
    }

    return new SmartFactoryRegistry(registryOptions)
  }
}
