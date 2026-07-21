import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  FREIGHT_AIRCRAFT_FACTORY,
  PASSENGER_AIRCRAFT_FACTORY,
  aircraftFactorySet,
  aircraftOrderId,
  aircraftType,
  type Aircraft,
  type Airliner,
  type Freighter,
} from './catalog'
import {
  createAircraftFactoryRegistry,
  getAircraftFactoryRegistry,
} from './registry'

describe('aircraft factory composition root', () => {
  it('exposes filename-derived keys through the generated namespace set', () => {
    expect(aircraftFactorySet.passenger).toBe(PASSENGER_AIRCRAFT_FACTORY)
    expect(aircraftFactorySet.freight).toBe(FREIGHT_AIRCRAFT_FACTORY)
    expect(aircraftType.airliner).toBe('airliner')
    expect(aircraftType.freighter).toBe('freighter')
    expectTypeOf(aircraftFactorySet.passenger).toEqualTypeOf<
      typeof PASSENGER_AIRCRAFT_FACTORY
    >()
  })

  it('discovers both modules lazily through the literal Vite glob', () => {
    const registry = createAircraftFactoryRegistry()

    // Module paths are matched loosely: their exact spelling is the
    // bundler's path normalization, not this domain's contract.
    expect(registry.snapshot()).toEqual({
      factories: [
        {
          activeCreations: 0,
          aliases: [],
          circuit: { consecutiveFailures: 0, status: 'closed' },
          key: FREIGHT_AIRCRAFT_FACTORY,
          modulePath: expect.stringContaining('freight.factory.ts'),
          status: 'idle',
        },
        {
          activeCreations: 0,
          aliases: [],
          circuit: { consecutiveFailures: 0, status: 'closed' },
          key: PASSENGER_AIRCRAFT_FACTORY,
          modulePath: expect.stringContaining('passenger.factory.ts'),
          status: 'idle',
        },
      ],
    })
  })

  it('memoizes the shared registry behind a lazy accessor', () => {
    expect(getAircraftFactoryRegistry()).toBe(getAircraftFactoryRegistry())
  })

  it('creates distinct, strongly inferred product families', async () => {
    const registry = createAircraftFactoryRegistry()

    const passengerFamily = await registry.create(
      aircraftFactorySet.passenger,
      {
        orderId: aircraftOrderId('AO-100001'),
        rangeNauticalMiles: 5_500,
        seats: 220,
      },
    )
    const freightFamily = await registry.create(FREIGHT_AIRCRAFT_FACTORY, {
      orderId: aircraftOrderId('AO-100002'),
      payloadKilograms: 130_000,
      rangeNauticalMiles: 4_300,
    })

    expect(passengerFamily).toMatchObject({
      airframe: { role: 'passenger', seatCapacity: 220 },
      cabin: { emergencyExits: 5 },
      type: aircraftType.airliner,
    })
    expect(freightFamily).toMatchObject({
      airframe: { role: 'freight' },
      cargoDeck: { payloadKilograms: 130_000 },
      type: aircraftType.freighter,
    })
    expectTypeOf(passengerFamily).toEqualTypeOf<Airliner>()
    expectTypeOf(freightFamily).toEqualTypeOf<Freighter>()
  })

  it('narrows mixed products by their generated product type', async () => {
    const registry = createAircraftFactoryRegistry()
    const products: Aircraft[] = [
      await registry.create(aircraftFactorySet.passenger, {
        orderId: aircraftOrderId('AO-100004'),
        rangeNauticalMiles: 5_500,
        seats: 220,
      }),
      await registry.create(aircraftFactorySet.freight, {
        orderId: aircraftOrderId('AO-100005'),
        payloadKilograms: 130_000,
        rangeNauticalMiles: 4_300,
      }),
    ]

    for (const aircraft of products) {
      if (aircraft.type === aircraftType.airliner) {
        expectTypeOf(aircraft).toEqualTypeOf<Airliner>()
        expect(aircraft.cabin.pressureControlled).toBe(true)
        // @ts-expect-error - cargo decks do not exist on the airliner branch
        void aircraft.cargoDeck
      } else {
        expectTypeOf(aircraft).toEqualTypeOf<Freighter>()
        expect(aircraft.cargoDeck.payloadKilograms).toBe(130_000)
        // @ts-expect-error - cabins do not exist on the freighter branch
        void aircraft.cabin
      }
    }
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

  it('rejects airliner-only fields from freighter build orders', async () => {
    const registry = createAircraftFactoryRegistry()

    await expect(
      registry.create(aircraftFactorySet.freight, {
        orderId: aircraftOrderId('AO-100006'),
        payloadKilograms: 130_000,
        rangeNauticalMiles: 4_300,
        // @ts-expect-error - freighter orders do not accept passenger seating
        seats: 12,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FACTORY_CONTEXT' })
  })
})
