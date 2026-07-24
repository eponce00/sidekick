/* eslint-disable @typescript-eslint/explicit-function-return-type */

export const populationRows = []

export function latestPopulation() {
  return populationRows.at(-1)?.population ?? null
}
