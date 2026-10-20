// F-WH fix — withholding-at-source is an ASSET, never part of trade receivables.
// The dedicated account is seeded/migrated additively (code 1114); no historical
// 1105 balance is reclassified by this mapping change.
export const withholdingAccountMapping = {
  informationalPreviewAccount: 'acc-1114',
  withholdingReceivableAccount: 'acc-1114',
  isSeparateWithholdingAccountConfigured: true,
};
