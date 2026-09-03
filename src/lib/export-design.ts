export function pickExportDesignLink(input: {
  lineDesignLink: string | null
  orderDesignLink: string | null
  productLineCount: number
  orderType: string
  sku: string | null
  skuDesignLink: string | null
}): string | null {
  return (
    input.lineDesignLink ??
    input.orderDesignLink ??
    (input.orderType !== 'CUSTOM' && input.sku ? input.skuDesignLink : null) ??
    null
  )
}
