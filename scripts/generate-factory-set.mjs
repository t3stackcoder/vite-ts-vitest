import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRepositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const factorySegmentPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/

function formatPropertyName(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : `'${value}'`
}

function formatString(value) {
  return `'${value}'`
}

function formatPropertyAccess(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
    ? `.${value}`
    : `[${formatString(value)}]`
}

async function readFactoryDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined
    }

    throw error
  }
}

export async function discoverFactoryNamespaces(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot
  const sourceDirectory =
    options.sourceDirectory ?? path.join(repositoryRoot, 'src')
  const sourceEntries = await readdir(sourceDirectory, { withFileTypes: true })
  const namespaces = []

  for (const sourceEntry of sourceEntries) {
    if (!sourceEntry.isDirectory()) {
      continue
    }

    const namespace = sourceEntry.name
    const factoryDirectory = path.join(
      sourceDirectory,
      namespace,
      'factories',
    )
    const factoryEntries = await readFactoryDirectory(factoryDirectory)

    if (factoryEntries === undefined) {
      continue
    }

    const factoryFiles = factoryEntries
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith('.factory.ts'),
      )
      .sort((left, right) => left.name.localeCompare(right.name))

    if (factoryFiles.length === 0) {
      continue
    }

    if (!factorySegmentPattern.test(namespace)) {
      throw new TypeError(
        `Factory namespace directory "${namespace}" must be a lowercase kebab-case segment.`,
      )
    }

    const factories = await Promise.all(
      factoryFiles.map(async (entry) => {
        const name = entry.name.slice(0, -'.factory.ts'.length)

        if (!factorySegmentPattern.test(name)) {
          throw new TypeError(
            `Factory filename "${entry.name}" must start with a lowercase kebab-case segment.`,
          )
        }

        const productType = await readFactoryProductType(
          path.join(factoryDirectory, entry.name),
          repositoryRoot,
        )

        return { name, productType }
      }),
    )

    namespaces.push({ factories, namespace })
  }

  return namespaces.sort((left, right) =>
    left.namespace.localeCompare(right.namespace),
  )
}

async function readFactoryProductType(filePath, repositoryRoot) {
  const sourceText = await readFile(filePath, 'utf8')
  const relativePath = path
    .relative(repositoryRoot, filePath)
    .replaceAll('\\', '/')
  return parseFactoryProductType(sourceText, relativePath)
}

export function parseFactoryProductType(sourceText, sourcePath = '<factory>') {
  const declarationPattern =
    /^\s*export\s+const\s+productType\s*=\s*factoryProductType\(\s*(['"])([^'"]+)\1\s*\)\s*;?\s*$/gm
  const declarations = [...sourceText.matchAll(declarationPattern)]

  if (declarations.length !== 1) {
    throw new TypeError(
      `${sourcePath} must export const productType = factoryProductType('type-name').`,
    )
  }

  const productType = declarations[0][2]

  if (productType === undefined || !factorySegmentPattern.test(productType)) {
    throw new TypeError(
      `Product type "${productType}" in ${sourcePath} must be a lowercase kebab-case segment.`,
    )
  }

  return productType
}

export function renderFactoryVocabulary(namespaces) {
  const namespaceLines = namespaces.map(({ factories, namespace }) => {
    const names = factories.map(({ name }) => name)
    const renderedNames = names.map(formatString).join(', ')

    return `  ${formatPropertyName(namespace)}: factoryKeySet(${formatString(namespace)}, [${renderedNames}]),`
  })
  const productTypeLines = namespaces.map(({ factories, namespace }) => {
    const productTypes = [
      ...new Set(factories.map(({ productType }) => productType)),
    ].sort((left, right) => left.localeCompare(right))
    const renderedProductTypes = productTypes.map(formatString).join(', ')

    return `  ${formatPropertyName(namespace)}: factoryProductTypeSet([${renderedProductTypes}]),`
  })
  const factoryDefinitionLines = namespaces.flatMap(
    ({ factories, namespace }) => {
      const namespaceAccess = formatPropertyAccess(namespace)

      return [
        `  ${formatPropertyName(namespace)}: Object.freeze({`,
        ...factories.flatMap(({ name, productType }) => {
          const factoryAccess = formatPropertyAccess(name)
          const productTypeAccess = formatPropertyAccess(productType)

          return [
            `    ${formatPropertyName(name)}: Object.freeze({`,
            `      key: factorySet${namespaceAccess}${factoryAccess},`,
            `      productType: productTypeSet${namespaceAccess}${productTypeAccess},`,
            '    }),',
          ]
        }),
        '  }),',
      ]
    },
  )

  return [
    '// This file is generated by scripts/generate-factory-set.mjs.',
    '// Add/remove a factory or change its productType declaration, then regenerate.',
    '',
    "import { factoryKeySet, factoryProductTypeSet } from '../factory-core'",
    '',
    'export const factorySet = Object.freeze({',
    ...namespaceLines,
    '})',
    '',
    'export type FactorySet = typeof factorySet',
    '',
    'export const productTypeSet = Object.freeze({',
    ...productTypeLines,
    '})',
    '',
    'export type ProductTypeSet = typeof productTypeSet',
    '',
    'export const factoryDefinitionSet = Object.freeze({',
    ...factoryDefinitionLines,
    '})',
    '',
    'export type FactoryDefinitionSet = typeof factoryDefinitionSet',
    '',
  ].join('\n')
}

async function readCurrentOutput(outputPath) {
  try {
    return await readFile(outputPath, 'utf8')
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined
    }

    throw error
  }
}

export function isFactoryModulePath(filePath) {
  const normalizedPath = filePath.replaceAll('\\', '/')

  return /(?:^|\/)src\/[^/]+\/factories\/[^/]+\.factory\.ts$/.test(
    normalizedPath,
  )
}

export async function generateFactorySet(options = {}) {
  const check = options.check ?? false
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot
  const sourceDirectory =
    options.sourceDirectory ?? path.join(repositoryRoot, 'src')
  const outputPath =
    options.outputPath ??
    path.join(sourceDirectory, 'generated', 'factory-set.generated.ts')
  const namespaces = await discoverFactoryNamespaces({
    repositoryRoot,
    sourceDirectory,
  })
  const expectedOutput = renderFactoryVocabulary(namespaces)
  const currentOutput = await readCurrentOutput(outputPath)
  const relativeOutputPath = path
    .relative(repositoryRoot, outputPath)
    .replaceAll('\\', '/')

  if (currentOutput === expectedOutput) {
    return { changed: false, outputPath: relativeOutputPath }
  }

  if (check) {
    throw new Error(
      `${relativeOutputPath} is stale. Run "npm run generate:factories".`,
    )
  }

  const temporaryPath = `${outputPath}.${process.pid}.tmp`

  try {
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(temporaryPath, expectedOutput, 'utf8')
    await rename(temporaryPath, outputPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }

  return { changed: true, outputPath: relativeOutputPath }
}

const invokedPath = process.argv[1]
const isCommandLineEntry =
  invokedPath !== undefined &&
  path.resolve(invokedPath) === fileURLToPath(import.meta.url)

if (isCommandLineEntry) {
  const argumentsAfterEntry = process.argv.slice(2)
  const unsupportedArgument = argumentsAfterEntry.find(
    (argument) => argument !== '--check',
  )

  if (unsupportedArgument !== undefined) {
    console.error(`Unknown argument: ${unsupportedArgument}`)
    process.exitCode = 1
  } else {
    generateFactorySet({ check: argumentsAfterEntry.includes('--check') })
      .then(({ changed, outputPath: generatedPath }) => {
        console.info(
          changed
            ? `Generated ${generatedPath}.`
            : `Factory vocabulary is current: ${generatedPath}.`,
        )
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error)
        process.exitCode = 1
      })
  }
}
