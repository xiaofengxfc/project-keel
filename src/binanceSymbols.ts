export type BinanceExchangeSymbol = {
  symbol: string
  baseAsset: string
  quoteAsset: string
  marginAsset: string
  contractType: string
  status: string
}

export type BinanceSymbolCatalogItem = Pick<BinanceExchangeSymbol, 'symbol' | 'baseAsset'>

export function tradableUsdtPerpetuals(rows: BinanceExchangeSymbol[]): BinanceSymbolCatalogItem[] {
  return rows
    .filter((item) => item.status === 'TRADING' && item.contractType === 'PERPETUAL' && item.quoteAsset === 'USDT' && item.marginAsset === 'USDT')
    .map(({ symbol, baseAsset }) => ({ symbol, baseAsset }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
}
