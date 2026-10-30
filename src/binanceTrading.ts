import { floorToStep } from './binanceOrders.js'

export type LeverageBracket = {
  bracket: number
  initialLeverage: number
  notionalFloor: string
  notionalCap: string
}

export type OrderAmountUnit = 'asset' | 'usdt'

export function percentageLeverageLimit(brackets: LeverageBracket[], balance: number, percent: number): number {
  const maximum = Math.max(0, ...brackets.map((item) => item.initialLeverage))
  const fraction = Math.max(0, Math.min(100, percent)) / 100
  let limit = 0
  for (let leverage = 1; leverage <= maximum; leverage += 1) {
    const notional = Math.max(0, balance) * fraction * leverage
    const bracket = brackets.find((item) => notional >= Number(item.notionalFloor) && notional <= Number(item.notionalCap))
    if (bracket && leverage <= bracket.initialLeverage) limit = leverage
  }
  return limit
}

export function leverageForBalancePercent(brackets: LeverageBracket[], balance: number, percent: number, requestedLeverage: number) {
  const requested = Math.max(1, Math.floor(Number.isFinite(requestedLeverage) ? requestedLeverage : 1))
  const maximum = percentageLeverageLimit(brackets, balance, percent)
  return { maximum, effective: maximum > 0 ? Math.min(requested, maximum) : requested, clamped: maximum > 0 && requested > maximum }
}

export function quantityAtPercent(balance: number, leverage: number, percent: number, price: number, stepSize: string): string {
  return orderSizeAtBalancePercent(balance, leverage, percent, price, stepSize, 'asset').quantity
}

export function partialCloseQuantity(positionQuantity: number, percent: number, stepSize: string): string {
  return floorToStep(Math.abs(positionQuantity) * Math.max(0, Math.min(100, percent)) / 100, stepSize)
}

export function quoteAsset(symbol: string): string {
  const knownQuotes = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'BTC', 'ETH', 'BNB']
  return knownQuotes.find((quote) => symbol.toUpperCase().endsWith(quote)) ?? 'USDT'
}

export function leverageLimitForNotional(brackets: LeverageBracket[], notional: number): number | null {
  if (!brackets.length) return null
  const ordered = [...brackets].sort((left, right) => Number(left.notionalFloor) - Number(right.notionalFloor))
  const tier = ordered.find((item) => notional >= Number(item.notionalFloor) && notional <= Number(item.notionalCap))
  return tier?.initialLeverage ?? null
}

export function allowedLeverageOptions(brackets: LeverageBracket[], availableBalance: number, balancePercent = 100): number[] {
  const maximum = Math.max(0, ...brackets.map((item) => item.initialLeverage))
  if (!maximum || !Number.isFinite(availableBalance) || availableBalance <= 0) return []
  const fraction = Math.min(100, Math.max(0, balancePercent)) / 100
  return Array.from({ length: maximum }, (_, index) => index + 1)
    .filter((leverage) => leverage <= (leverageLimitForNotional(brackets, availableBalance * fraction * leverage) ?? 0))
}

export function allSymbolLeverageOptions(brackets: LeverageBracket[]): number[] {
  const maximum = Math.max(0, ...brackets.map((item) => item.initialLeverage))
  return Array.from({ length: maximum }, (_, index) => index + 1)
}

export function quantityFromAmount(amount: number, unit: OrderAmountUnit, price: number, stepSize: string): string {
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(price) || price <= 0) return '0'
  return floorToStep(unit === 'usdt' ? amount / price : amount, stepSize)
}

export function orderSizeAtBalancePercent(availableBalance: number, leverage: number, percent: number, price: number, stepSize: string, unit: OrderAmountUnit) {
  const fraction = Math.min(100, Math.max(0, percent)) / 100
  const targetNotional = Math.max(0, availableBalance) * Math.max(0, leverage) * fraction
  const quantity = quantityFromAmount(targetNotional, 'usdt', price, stepSize)
  const actualNotional = Number(quantity) * price
  return { quantity, notional: actualNotional, inputAmount: unit === 'usdt' ? actualNotional : Number(quantity) }
}

export function buildCloseOrder(position: { positionAmt: number; positionSide: string }) {
  if (!Number.isFinite(position.positionAmt) || position.positionAmt === 0) return null
  const positionSide = position.positionSide === 'LONG' || position.positionSide === 'SHORT' ? position.positionSide : 'BOTH'
  return {
    side: position.positionAmt > 0 ? 'SELL' as const : 'BUY' as const,
    positionSide,
    reduceOnly: positionSide === 'BOTH',
    quantity: String(Math.abs(position.positionAmt)),
  }
}

export function protectionOrderDirection(positionSide: string, positionAmount: number | null, requestedSide?: 'BUY' | 'SELL') {
  const hasPosition = positionAmount !== null && Number.isFinite(positionAmount) && positionAmount !== 0
  if (hasPosition) {
    const isLong = positionSide === 'LONG' || positionSide === 'BOTH' && positionAmount! > 0
    const side = isLong ? 'SELL' as const : 'BUY' as const
    return requestedSide && requestedSide !== side ? null : { side, isLong }
  }
  if (!requestedSide || positionSide === 'LONG' && requestedSide !== 'SELL' || positionSide === 'SHORT' && requestedSide !== 'BUY') return null
  return { side: requestedSide, isLong: positionSide === 'LONG' || positionSide === 'BOTH' && requestedSide === 'SELL' }
}
