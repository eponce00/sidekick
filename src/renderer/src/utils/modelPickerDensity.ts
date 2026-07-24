const VISIBLE_MODEL_ROWS = 5

export function shouldOfferModelSearch(modelCount: number): boolean {
  return modelCount > VISIBLE_MODEL_ROWS
}
