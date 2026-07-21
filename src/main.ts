import {
  aircraftFactorySet,
  aircraftOrderId,
  getAircraftFactoryRegistry,
} from './aircraft'

async function demonstrateDynamicFactoryLoading(): Promise<void> {
  const aircraft = await getAircraftFactoryRegistry().create(
    aircraftFactorySet.passenger,
    {
      orderId: aircraftOrderId('AO-000001'),
      rangeNauticalMiles: 5_200,
      seats: 180,
    },
    { correlationId: 'vite-demo' },
  )

  console.info('Dynamically created aircraft product family:', aircraft)
}

void demonstrateDynamicFactoryLoading().catch((error: unknown) => {
  console.error('Factory harness demonstration failed:', error)
})
