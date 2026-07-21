import {
  factoryKeySchema,
  isFactoryKey,
  modulePath,
  type FactoryKey,
  type ModulePath,
} from './brand'
import type {
  CatalogFactoryModule,
  FactoryCatalog,
  FactoryCatalogKey,
  FactorySource,
} from './contracts'
import { FactoryRegistryError } from './errors'

/**
 * The loader map produced by a bare (lazy) import.meta.glob call. Lazy-only
 * by design: every value must be a `() => Promise` loader so the registry
 * can code-split, deduplicate, and cache loads itself; an `{ eager: true }`
 * glob provides already-loaded modules instead of loaders and is rejected
 * at source creation.
 */
export type GlobLoaderMap<Module> = Readonly<
  Record<string, () => Promise<Module>>
>

export interface GlobFactorySourceOptions<Catalog extends FactoryCatalog> {
  readonly allowEmpty?: boolean
  readonly keyFromPath: (path: ModulePath) => FactoryCatalogKey<Catalog>
}

export function createGlobFactorySources<Catalog extends FactoryCatalog>(
  modules: GlobLoaderMap<CatalogFactoryModule<Catalog>>,
  options: GlobFactorySourceOptions<Catalog>,
): readonly FactorySource<Catalog>[] {
  // Code-unit comparison keeps the ordering host-locale-independent.
  const entries = Object.entries(modules).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )

  if (entries.length === 0 && options.allowEmpty !== true) {
    throw new FactoryRegistryError(
      'INVALID_SOURCE',
      'The import.meta.glob call matched no factory modules.',
    )
  }

  const claimedKeys = new Map<string, ModulePath>()
  const sources = entries.map(([rawPath, load]) => {
    if (typeof load !== 'function') {
      throw new FactoryRegistryError(
        'INVALID_SOURCE',
        `The glob entry "${rawPath}" does not contain a module loader. ` +
          'Pass a lazy import.meta.glob map: a glob called with ' +
          '{ eager: true } provides already-loaded modules instead of ' +
          'loaders and is not supported.',
      )
    }

    const path = modulePath(rawPath)
    let key: FactoryCatalogKey<Catalog>

    try {
      key = options.keyFromPath(path)
    } catch (cause) {
      throw new FactoryRegistryError(
        'INVALID_SOURCE',
        `Could not map factory module "${path}" to a catalog key.`,
        { cause, details: { modulePath: path } },
      )
    }

    if (!isFactoryKey(key)) {
      throw new FactoryRegistryError(
        'INVALID_SOURCE',
        `The glob entry "${path}" resolved to an invalid factory key.`,
        { details: { key, modulePath: path } },
      )
    }

    const previousPath = claimedKeys.get(key)
    if (previousPath !== undefined) {
      throw new FactoryRegistryError(
        'DUPLICATE_FACTORY',
        `Factory key "${key}" is claimed by both "${previousPath}" and "${path}".`,
        { details: { key, modulePath: path, previousModulePath: previousPath } },
      )
    }

    claimedKeys.set(key, path)

    return Object.freeze({
      key,
      load: async (): Promise<CatalogFactoryModule<Catalog>> => load(),
      modulePath: path,
    })
  })

  return Object.freeze(sources)
}

export interface FilenameKeyResolverOptions {
  readonly suffix?: string
}

export function createFilenameKeyResolver<
  const KeyByStem extends Readonly<Record<string, FactoryKey>>,
>(
  keyByStem: KeyByStem,
  options: FilenameKeyResolverOptions = {},
): (path: ModulePath) => KeyByStem[keyof KeyByStem] {
  const suffix = options.suffix ?? '.factory.ts'

  if (suffix.length === 0) {
    throw new TypeError('The factory filename suffix cannot be empty.')
  }

  return (path): KeyByStem[keyof KeyByStem] => {
    const normalizedPath = path.replaceAll('\\', '/')
    const filename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1)

    if (!filename.endsWith(suffix)) {
      throw new TypeError(
        `Factory module "${path}" must end with "${suffix}".`,
      )
    }

    const stem = filename.slice(0, -suffix.length)
    if (!Object.hasOwn(keyByStem, stem)) {
      throw new TypeError(
        `Factory module "${path}" has no key mapping for stem "${stem}".`,
      )
    }

    const parsedKey = factoryKeySchema.safeParse(Reflect.get(keyByStem, stem))
    if (!parsedKey.success) {
      throw new TypeError(`The key mapping for "${stem}" is invalid.`)
    }

    return parsedKey.data as KeyByStem[keyof KeyByStem]
  }
}
