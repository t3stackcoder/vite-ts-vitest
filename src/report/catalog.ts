import { z } from 'zod'
import {
  factoryDefinitionSet,
  factorySet,
  productTypeSet,
} from '../generated/factory-set.generated'
import {
  defineFactoryCatalog,
  defineFactoryFor,
  factoryCatalogEntry,
  factoryContract,
} from '../factory-core'

const reportFactories = factoryDefinitionSet.report
export const reportType = productTypeSet.report

// Only the report slice of the generated vocabulary is part of this
// domain's surface. Other domains' keys and product types live in the
// generated module; consumers who need them import it directly instead of
// reaching through report's barrel.
export const reportFactorySet = factorySet.report
export const reportFactoryDefinitionSet = reportFactories

export const PRINT_REPORT_FACTORY = reportFactories.print.key
export const SPREADSHEET_REPORT_FACTORY = reportFactories.spreadsheet.key

export const PRINT_REPORT_REQUEST_SCHEMA = z
  .strictObject({
    sections: z.array(z.string().min(1)).min(1).readonly(),
    title: z.string().min(1),
  })
  .readonly()

export const SPREADSHEET_REPORT_REQUEST_SCHEMA = z
  .strictObject({
    columns: z.array(z.string().min(1)).min(1).readonly(),
    rows: z.array(z.array(z.string()).readonly()).readonly(),
  })
  .readonly()

export const PDF_REPORT_SCHEMA = z
  .strictObject({
    format: z.literal(reportType.pdf),
    pageCount: z.number().int().positive(),
    title: z.string().min(1),
  })
  .readonly()

export const CSV_REPORT_SCHEMA = z
  .strictObject({
    columnCount: z.number().int().positive(),
    format: z.literal(reportType.csv),
    rowCount: z.number().int().nonnegative(),
  })
  .readonly()

export const REPORT_SCHEMA = z.discriminatedUnion('format', [
  PDF_REPORT_SCHEMA,
  CSV_REPORT_SCHEMA,
])

export type PdfReport = z.output<typeof PDF_REPORT_SCHEMA>
export type CsvReport = z.output<typeof CSV_REPORT_SCHEMA>
export type Report = z.output<typeof REPORT_SCHEMA>

export const REPORT_FACTORY_CATALOG = defineFactoryCatalog({
  ...factoryCatalogEntry(
    PRINT_REPORT_FACTORY,
    factoryContract({
      contextSchema: PRINT_REPORT_REQUEST_SCHEMA,
      discriminator: 'format',
      productType: reportFactories.print.productType,
      resultSchema: PDF_REPORT_SCHEMA,
    }),
  ),
  ...factoryCatalogEntry(
    SPREADSHEET_REPORT_FACTORY,
    factoryContract({
      contextSchema: SPREADSHEET_REPORT_REQUEST_SCHEMA,
      discriminator: 'format',
      productType: reportFactories.spreadsheet.productType,
      resultSchema: CSV_REPORT_SCHEMA,
    }),
  ),
})

export type ReportFactoryCatalog = typeof REPORT_FACTORY_CATALOG

/** Curried once for the domain; factory modules import this instead of re-deriving it. */
export const defineReportFactory = defineFactoryFor<ReportFactoryCatalog>()
