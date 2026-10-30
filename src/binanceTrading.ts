import { floorToStep } from './binanceOrders.js'

export type LeverageBracket = {
  bracket: number
  initialLeverage: number
  notionalFloor: string
  notionalCap: string
}

export type OrderAmountUnit = 'asset' | 'usdt'

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
