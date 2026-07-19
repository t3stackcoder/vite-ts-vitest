import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  AIRLINER_FACTORY_ALIAS,
  FREIGHT_AIRCRAFT_FACTORY,
  PASSENGER_AIRCRAFT_FACTORY,
  aircraftOrderId,
  type FreightAircraftFamily,
  type PassengerAircraftFamily,
} from './catalog'
import { createAircraftFactoryRegistry } from './registry'

describe('aircraft factory composition root', () => {
  it('discovers both modules lazily through the literal Vite glob', () => {
    const registry = createAircraftFactoryRegistry()

    expect(registry.snapshot()).toEqual({
      factories: [
        {
          activeCreations: 0,
          aliases: [],
          circuit: { consecutiveFailures: 0, status: 'closed' },
          key: FREIGHT_AIRCRAFT_FACTORY,
          modulePath: './factories/freight.factory.ts',
          status: 'idle',
        },
        {
          activeCreations: 0,
          aliases: [AIRLINER_FACTORY_ALIAS],
          circuit: { consecutiveFailures: 0, status: 'closed' },
          key: PASSENGER_AIRCRAFT_FACTORY,
          modulePath: './factories/passenger.factory.ts',
          status: 'idle',
        },
      ],
    })
  })

  it('creates distinct, strongly inferred product families', async () => {
    const registry = createAircraftFactoryRegistry()

    const passengerFamily = await registry.create(AIRLINER_FACTORY_ALIAS, {
      orderId: aircraftOrderId('AO-100001'),
      rangeNauticalMiles: 5_500,
      seats: 220,
    })
    const freightFamily = await registry.create(FREIGHT_AIRCRAFT_FACTORY, {
      orderId: aircraftOrderId('AO-100002'),
      payloadKilograms: 130_000,
      rangeNauticalMiles: 4_300,
    })

    expect(passengerFamily).toMatchObject({
      airframe: { role: 'passenger', seatCapacity: 220 },
      cabin: { emergencyExits: 5 },
      kind: 'passenger-aircraft-family',
    })
    expect(freightFamily).toMatchObject({
      airframe: { role: 'freight' },
      cargoDeck: { payloadKilograms: 130_000 },
      kind: 'freight-aircraft-family',
    })
    expectTypeOf(passengerFamily).toEqualTypeOf<PassengerAircraftFamily>()
    expectTypeOf(freightFamily).toEqualTypeOf<FreightAircraftFamily>()
  })

  it('reports domain schema failures with registry context', async () => {
    const registry = createAircraftFactoryRegistry()

    await expect(
      registry.create(PASSENGER_AIRCRAFT_FACTORY, {
        orderId: aircraftOrderId('AO-100003'),
        rangeNauticalMiles: 5_500,
        seats: 0,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FACTORY_CONTEXT' })
  })
})
