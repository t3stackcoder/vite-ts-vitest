import { z } from 'zod'
import {
  factoryDefinitionSet,
  factorySet,
  productTypeSet,
} from '../generated/factory-set.generated'
import {
  defineFactoryCatalog,
  factoryCatalogEntry,
  factoryContract,
  type Brand,
} from '../factory-core'

// Canonical keys are generated from *.factory.ts filenames. Every other
// mention is compiler-checked; an undiscovered name cannot compile.
const aircraft = factorySet.aircraft
const aircraftFactories = factoryDefinitionSet.aircraft
export const aircraftType = productTypeSet.aircraft

export { factoryDefinitionSet, factorySet, productTypeSet }

export const PASSENGER_AIRCRAFT_FACTORY = aircraftFactories.passenger.key
export const FREIGHT_AIRCRAFT_FACTORY = aircraftFactories.freight.key

export type AircraftOrderId = Brand<string, 'AircraftOrderId'>

const aircraftOrderIdPattern = /^AO-[0-9]{6}$/

export const AIRCRAFT_ORDER_ID_SCHEMA = z.custom<AircraftOrderId>(
  (value) =>
    typeof value === 'string' && aircraftOrderIdPattern.test(value),
  { error: 'Aircraft order id must use the form "AO-000000".' },
)

export function aircraftOrderId(value: string): AircraftOrderId {
  return AIRCRAFT_ORDER_ID_SCHEMA.parse(value)
}

export const PASSENGER_BUILD_ORDER_SCHEMA = z
  .strictObject({
    orderId: AIRCRAFT_ORDER_ID_SCHEMA,
    rangeNauticalMiles: z.number().finite().positive(),
    seats: z.number().int().positive(),
  })
  .readonly()

export const FREIGHT_BUILD_ORDER_SCHEMA = z
  .strictObject({
    orderId: AIRCRAFT_ORDER_ID_SCHEMA,
    payloadKilograms: z.number().finite().positive(),
    rangeNauticalMiles: z.number().finite().positive(),
  })
  .readonly()

export const PASSENGER_AIRCRAFT_FAMILY_SCHEMA = z
  .strictObject({
    airframe: z
      .strictObject({
        material: z.literal('carbon-composite'),
        role: z.literal('passenger'),
        seatCapacity: z.number().int().positive(),
      })
      .readonly(),
    avionics: z
      .strictObject({
        autopilot: z.literal(true),
        suite: z.literal('civil-integrated'),
      })
      .readonly(),
    cabin: z
      .strictObject({
        emergencyExits: z.number().int().positive(),
        pressureControlled: z.literal(true),
      })
      .readonly(),
    orderId: AIRCRAFT_ORDER_ID_SCHEMA,
    propulsion: z
      .strictObject({
        engineCount: z.literal(2),
        engineType: z.literal('high-bypass-turbofan'),
        rangeNauticalMiles: z.number().finite().positive(),
      })
      .readonly(),
    type: z.literal(aircraftType.airliner),
  })
  .readonly()

export const FREIGHT_AIRCRAFT_FAMILY_SCHEMA = z
  .strictObject({
    airframe: z
      .strictObject({
        material: z.literal('aluminum-lithium'),
        role: z.literal('freight'),
      })
      .readonly(),
    avionics: z
      .strictObject({
        autopilot: z.literal(true),
        suite: z.literal('cargo-integrated'),
      })
      .readonly(),
    cargoDeck: z
      .strictObject({
        loadingSystem: z.literal('powered-roller'),
        payloadKilograms: z.number().finite().positive(),
      })
      .readonly(),
    orderId: AIRCRAFT_ORDER_ID_SCHEMA,
    propulsion: z
      .strictObject({
        engineCount: z.literal(4),
        engineType: z.literal('high-thrust-turbofan'),
        rangeNauticalMiles: z.number().finite().positive(),
      })
      .readonly(),
    type: z.literal(aircraftType.freighter),
  })
  .readonly()

export type PassengerBuildOrder = z.output<
  typeof PASSENGER_BUILD_ORDER_SCHEMA
>
export type FreightBuildOrder = z.output<typeof FREIGHT_BUILD_ORDER_SCHEMA>
export const AIRCRAFT_FAMILY_SCHEMA = z.discriminatedUnion('type', [
  PASSENGER_AIRCRAFT_FAMILY_SCHEMA,
  FREIGHT_AIRCRAFT_FAMILY_SCHEMA,
])

export type Airliner = z.output<typeof PASSENGER_AIRCRAFT_FAMILY_SCHEMA>
export type Freighter = z.output<typeof FREIGHT_AIRCRAFT_FAMILY_SCHEMA>
export type Aircraft = z.output<typeof AIRCRAFT_FAMILY_SCHEMA>

export const AIRCRAFT_FACTORY_CATALOG = defineFactoryCatalog({
  ...factoryCatalogEntry(
    PASSENGER_AIRCRAFT_FACTORY,
    factoryContract({
      contextSchema: PASSENGER_BUILD_ORDER_SCHEMA,
      discriminator: 'type',
      productType: aircraftFactories.passenger.productType,
      resultSchema: PASSENGER_AIRCRAFT_FAMILY_SCHEMA,
    }),
  ),
  ...factoryCatalogEntry(
    FREIGHT_AIRCRAFT_FACTORY,
    factoryContract({
      contextSchema: FREIGHT_BUILD_ORDER_SCHEMA,
      discriminator: 'type',
      productType: aircraftFactories.freight.productType,
      resultSchema: FREIGHT_AIRCRAFT_FAMILY_SCHEMA,
    }),
  ),
})

export type AircraftFactoryCatalog = typeof AIRCRAFT_FACTORY_CATALOG

export const AIRCRAFT_FACTORY_KEYS_BY_FILE = aircraft
