import { factoryDomainFor, type CatalogFactoryModule } from '../factory-core'
import {
  AIRCRAFT_FACTORY_CATALOG,
  type AircraftFactoryCatalog,
} from './catalog'

type AircraftFactoryModule = CatalogFactoryModule<AircraftFactoryCatalog>

// Vite requires this literal glob at the composition root so it can transform it.
// The <AircraftFactoryModule> type argument is an unchecked assertion — Vite
// cannot verify it — but factory-core's module boundary schema re-validates
// every loaded module at runtime, so a module that lies about this type is
// rejected at load rather than trusted.
const aircraftFactoryModules = import.meta.glob<AircraftFactoryModule>(
  './factories/*.factory.ts',
)

const domain = factoryDomainFor(AIRCRAFT_FACTORY_CATALOG)

export function createAircraftFactoryRegistry() {
  return domain.createRegistry(aircraftFactoryModules)
}

/**
 * Lazily memoized shared registry. Nothing is constructed at import time, so
 * importing the barrel for a type or an order schema stays side-effect-free,
 * and a composition failure (empty glob, unmapped stem) surfaces at the
 * first call instead of during module evaluation.
 */
export const getAircraftFactoryRegistry = domain.lazyRegistry(
  aircraftFactoryModules,
)
