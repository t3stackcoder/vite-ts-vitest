import { defineConfig } from 'vite'
import {
  generateFactorySet,
  isFactoryModulePath,
} from './scripts/generate-factory-set.mjs'

function factorySetCodegen() {
  return {
    name: 'factory-set-codegen',

    async buildStart() {
      await generateFactorySet()
    },

    configureServer(server) {
      let pendingGeneration = Promise.resolve()

      const regenerate = (filePath) => {
        if (!isFactoryModulePath(filePath)) {
          return
        }

        pendingGeneration = pendingGeneration
          .then(() => generateFactorySet())
          .then(({ changed, outputPath }) => {
            if (changed) {
              server.config.logger.info(`regenerated ${outputPath}`)
            }
          })
          .catch((error) => {
            const message =
              error instanceof Error ? (error.stack ?? error.message) : error
            server.config.logger.error(String(message))
          })
      }

      server.watcher.on('add', regenerate)
      server.watcher.on('change', regenerate)
      server.watcher.on('unlink', regenerate)
    },
  }
}

export default defineConfig({
  plugins: [factorySetCodegen()],
})
