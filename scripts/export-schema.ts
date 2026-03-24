import { writeFileSync } from 'node:fs'
import { typeDefs } from '../src/schema/typeDefs.js'

const outPath = process.argv[2] || 'schema.graphql'
writeFileSync(outPath, typeDefs, 'utf-8')
console.log(`Schema written to ${outPath}`)
