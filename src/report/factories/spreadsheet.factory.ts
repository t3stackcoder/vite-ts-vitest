import { factoryProductType } from '../../factory-core'
import { SPREADSHEET_REPORT_FACTORY, defineReportFactory } from '../catalog'

export const productType = factoryProductType('csv')

export default defineReportFactory(SPREADSHEET_REPORT_FACTORY)({
  metadata: {
    description: 'Exports tabular report data as CSV metadata.',
    displayName: 'Spreadsheet Report Factory',
    version: '1.0.0',
  },
  productType,
  create(request, options) {
    options?.signal?.throwIfAborted()

    return Object.freeze({
      columnCount: request.columns.length,
      format: productType,
      rowCount: request.rows.length,
    })
  },
})
