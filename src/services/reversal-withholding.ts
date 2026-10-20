export function isWithholdingReversalAllowed(hasDocumentedWithholding: boolean, isPartOfSettlementCycle: boolean) {
  return hasDocumentedWithholding && isPartOfSettlementCycle;
}
