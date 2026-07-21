import { isFactoryKey, type FactoryKey, type ModulePath } from './brand'
import type {
  CatalogFactoryModule,
  EmptyFactoryAliasMap,
  FactoryAliasMap,
  FactoryCatalog,
  FactoryCatalogKey,
} from './contracts'
import { FactoryRegistryError } from './errors'
import {
  createFilenameKeyResolver,
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

    // Catalog-coverage check: every other misconfiguration (unknown stem,
    // duplicate key, empty glob, bad metadata) already fails at composition
    // time, but a catalog key whose module the glob never matched — for
    // example a factory file moved outside a non-recursive pattern — would
    // otherwise surface only as UNKNOWN_FACTORY at first create(). allowEmpty
    // is the explicit opt-out for globs that legitimately have no modules
    // yet. register() on the raw registry stays incremental; this assertion
    // belongs to the harness, whose contract is "the glob covers the
    // catalog".
    if (options.allowEmpty !== true) {
      const registeredKeys = new Set<string>(
        sources.map((source) => source.key),
      )
      const uncoveredKeys = Object.keys(catalog)
        .filter((key) => !registeredKeys.has(key))
        .sort()

      if (uncoveredKeys.length > 0) {
        throw new FactoryRegistryError(
          'INVALID_SOURCE',
          `The import.meta.glob call discovered no factory module for catalog ${
            uncoveredKeys.length === 1 ? 'key' : 'keys'
          } ${uncoveredKeys.map((key) => `"${key}"`).join(', ')}.`,
          { details: { uncoveredKeys } },
        )
      }
    }

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

export interface FactoryDomainRegistryOptions<
  Catalog extends FactoryCatalog,
  Aliases extends FactoryAliasMap<Catalog> = EmptyFactoryAliasMap,
> extends Omit<
    FactoryHarnessOptions<Catalog, Aliases>,
    'keyFromPath' | 'modules'
  > {
  /** Override for domains whose filenames deviate from key-name stems. */
  readonly keyFromPath?: GlobFactorySourceOptions<Catalog>['keyFromPath']
}

/**
 * Derives the filename-stem→key map from the catalog itself: keys are
 * "namespace:name" and the generator names each factory file after the name
 * segment, so the catalog already carries the mapping the resolver needs.
 * Two keys sharing a name segment cannot both map to one filename, so a
 * collision fails fast instead of silently shadowing.
 */
function keyByStemFromCatalog<Catalog extends FactoryCatalog>(
  catalog: Catalog,
): Readonly<Record<string, FactoryKey>> {
  const record: Record<string, FactoryKey> = {}

  for (const key of Object.keys(catalog)) {
    if (!isFactoryKey(key)) {
      throw new FactoryRegistryError(
        'INVALID_SOURCE',
        `Catalog key "${key}" is not a valid factory key, so no filename stem can be derived from it.`,
        { details: { key } },
      )
    }

    const stem = key.slice(key.indexOf(':') + 1)
    const previousKey = record[stem]
    if (previousKey !== undefined) {
      throw new FactoryRegistryError(
        'INVALID_SOURCE',
        `Filename stem "${stem}" is claimed by both catalog keys "${previousKey}" and "${key}"; pass an explicit keyFromPath to disambiguate.`,
        { details: { key, previousKey, stem } },
      )
    }

    record[stem] = key
  }

  return record
}

/**
 * Packages the composition-root pattern for one domain. A single call binds
 * the catalog; the returned builders need only the literal import.meta.glob
 * map, which Vite requires to stay at the consumer. The filename→key
 * resolver is derived from the catalog's own key names by default (the
 * convention the generator enforces), and lazyRegistry() provides the
 * shared-registry accessor without import-time construction: nothing runs —
 * and no composition failure can throw — until the first call.
 */
export function factoryDomainFor<const Catalog extends FactoryCatalog>(
  catalog: Catalog,
) {
  const createHarness = factoryHarnessFor(catalog)
  let derivedKeyFromPath:
    | ((path: ModulePath) => FactoryCatalogKey<Catalog>)
    | undefined

  // Derived on first use, not at domain construction: a domain that always
  // supplies its own keyFromPath never pays for (or trips over) derivation.
  // The cast re-asserts what construction guarantees — every stored value
  // came from Object.keys(catalog), so it is a catalog key.
  const defaultKeyFromPath = (): ((
    path: ModulePath,
  ) => FactoryCatalogKey<Catalog>) =>
    (derivedKeyFromPath ??= createFilenameKeyResolver(
      keyByStemFromCatalog(catalog),
    ) as (path: ModulePath) => FactoryCatalogKey<Catalog>)

  const createRegistry = <
    const Aliases extends FactoryAliasMap<Catalog> = EmptyFactoryAliasMap,
  >(
    modules: GlobLoaderMap<CatalogFactoryModule<Catalog>>,
    options: FactoryDomainRegistryOptions<Catalog, Aliases> = {},
  ): SmartFactoryRegistry<Catalog, Aliases> => {
    const { keyFromPath, ...harnessOptions } = options
    return createHarness<Aliases>({
      ...harnessOptions,
      keyFromPath: keyFromPath ?? defaultKeyFromPath(),
      modules,
    })
  }

  const lazyRegistry = <
    const Aliases extends FactoryAliasMap<Catalog> = EmptyFactoryAliasMap,
  >(
    modules: GlobLoaderMap<CatalogFactoryModule<Catalog>>,
    options: FactoryDomainRegistryOptions<Catalog, Aliases> = {},
  ): (() => SmartFactoryRegistry<Catalog, Aliases>) => {
    let registry: SmartFactoryRegistry<Catalog, Aliases> | undefined
    return () => (registry ??= createRegistry(modules, options))
  }

  return Object.freeze({ createRegistry, lazyRegistry })
}
