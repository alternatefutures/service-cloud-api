/* eslint-disable @typescript-eslint/no-unused-vars */
declare module 'graphql-validation-complexity' {
  import { ValidationRule } from 'graphql'

  interface ComplexityOptions {
    scalarCost?: number
    objectCost?: number
    listFactor?: number
  }

  export function createComplexityLimitRule(
    maxCost: number,
    options?: ComplexityOptions
  ): ValidationRule
}
