export const BINANCE_ORDER_TYPES = [
  'LIMIT',
  'MARKET',
  'STOP',
  'STOP_MARKET',
  'TAKE_PROFIT',
  'TAKE_PROFIT_MARKET',
  'TRAILING_STOP_MARKET',
] as const

export type BinanceOrderType = typeof BINANCE_ORDER_TYPES[number]
export type BinanceTimeInForce = 'GTC' | 'IOC' | 'FOK' | 'GTX'
export type BinanceWorkingType = 'MARK_PRICE' | 'CONTRACT_PRICE'
export type BinancePositionSide = 'BOTH' | 'LONG' | 'SHORT'

export type BinanceOrderInput = {
  symbol: string
  side: 'BUY' | 'SELL'
  type: BinanceOrderType
  quantity?: string
  price?: string
  stopPrice?: string
  timeInForce?: BinanceTimeInForce
  reduceOnly?: boolean
  closePosition?: boolean
  positionSide?: BinancePositionSide
  workingType?: BinanceWorkingType
  priceProtect?: boolean
  activationPrice?: string
  callbackRate?: string
}

export function isPriceOrder(type: BinanceOrderType) {
  return type === 'LIMIT' || type === 'STOP' || type === 'TAKE_PROFIT'
}

export function isTriggeredOrder(type: BinanceOrderType) {
  return type === 'STOP' || type === 'STOP_MARKET' || type === 'TAKE_PROFIT' || type === 'TAKE_PROFIT_MARKET'
}

export function requiresAlgoEndpoint(type: BinanceOrderType) {
  return isTriggeredOrder(type) || type === 'TRAILING_STOP_MARKET'
}

export function isMarketExecution(type: BinanceOrderType) {
  return type === 'MARKET' || type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET' || type === 'TRAILING_STOP_MARKET'
}

export function isStepAligned(value: string, step: string) {
  const decimal = (input: string) => {
    const match = /^(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))(?:[eE]([+-]?[0-9]+))?$/.exec(input)
    if (!match) return null
    let digits = `${match[1] ?? '0'}${match[2] ?? match[3] ?? ''}`.replace(/^0+(?=\d)/, '')
    let scale = (match[2] ?? match[3] ?? '').length - Number(match[4] ?? 0)
    if (scale < 0) { digits += '0'.repeat(-scale); scale = 0 }
    while (digits.length <= scale) digits = `0${digits}`
    return { digits, scale }
  }
  const valueDecimal = decimal(value)
  const stepDecimal = decimal(step)
  if (!valueDecimal || !stepDecimal) return false
  const places = Math.max(valueDecimal.scale, stepDecimal.scale)
  const integer = BigInt(valueDecimal.digits.padEnd(valueDecimal.digits.length + places - valueDecimal.scale, '0'))
  const increment = BigInt(stepDecimal.digits.padEnd(stepDecimal.digits.length + places - stepDecimal.scale, '0'))
  return integer !== null && increment !== null && increment > 0n && integer % increment === 0n
}

export function floorToStep(value: number, step: string): string {
  const decimal = (input: string): { units: bigint; scale: number } | null => {
    const match = /^(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))(?:[eE]([+-]?[0-9]+))?$/.exec(input)
    if (!match) return null
    let digits = `${match[1] ?? '0'}${match[2] ?? match[3] ?? ''}`.replace(/^0+(?=\d)/, '')
    let scale = (match[2] ?? match[3] ?? '').length - Number(match[4] ?? 0)
    if (scale < 0) { digits += '0'.repeat(-scale); scale = 0 }
    while (digits.length <= scale) digits = `0${digits}`
    return { units: BigInt(digits), scale }
  }
  if (!Number.isFinite(value) || value <= 0) return '0'
  const amountDecimal = decimal(String(value))
  const stepDecimal = decimal(step)
  if (!amountDecimal || !stepDecimal || stepDecimal.units <= 0n) return '0'
  const scale = Math.max(amountDecimal.scale, stepDecimal.scale)
  const amount = amountDecimal.units * 10n ** BigInt(scale - amountDecimal.scale)
  const increment = stepDecimal.units * 10n ** BigInt(scale - stepDecimal.scale)
  const floored = (amount / increment) * increment
  if (floored === 0n) return '0'
  const digits = floored.toString().padStart(scale + 1, '0')
  if (scale === 0) return digits
  const integer = digits.slice(0, -scale) || '0'
  const fraction = digits.slice(-scale).replace(/0+$/, '')
  return fraction ? `${integer}.${fraction}` : integer
}

export function validateBinanceOrder(input: BinanceOrderInput): string | null {
  if (typeof input.symbol !== 'string' || !/^[A-Z0-9]{3,20}$/.test(input.symbol.toUpperCase())) return '请提供有效的交易对'
  if (!['BUY', 'SELL'].includes(input.side)) return '请选择有效的买卖方向'
  if (!BINANCE_ORDER_TYPES.includes(input.type)) return '不支持此订单类型'

  const closePosition = input.closePosition === true
  if (closePosition) {
    if (!['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(input.type)) return '仅止损市价单和止盈市价单支持全仓平仓'
    if (input.reduceOnly) return '全仓平仓不能同时启用只减仓'
    if (input.quantity !== undefined && input.quantity !== '') return '全仓平仓不需要填写数量'
  } else {
    const quantity = Number(input.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0) return '数量必须是大于 0 的数字'
  }

  if (input.type === 'TRAILING_STOP_MARKET' && closePosition) return '追踪止损单不能使用全仓平仓参数'

  if (isPriceOrder(input.type)) {
    const price = Number(input.price)
    if (!Number.isFinite(price) || price <= 0) return '限价类订单必须填写大于 0 的价格'
    if (!['GTC', 'IOC', 'FOK', 'GTX'].includes(input.timeInForce ?? 'GTC')) return '请选择有效的订单有效期'
  }

  if (isTriggeredOrder(input.type)) {
    const stopPrice = Number(input.stopPrice)
    if (!Number.isFinite(stopPrice) || stopPrice <= 0) return '条件单必须填写大于 0 的触发价格'
  }

  if (input.type === 'TRAILING_STOP_MARKET') {
    const callbackRate = Number(input.callbackRate)
    if (!Number.isFinite(callbackRate) || callbackRate < 0.1 || callbackRate > 5) return '追踪回调率须在 0.1% 至 5% 之间'
    if (input.activationPrice !== undefined && input.activationPrice !== '') {
      const activationPrice = Number(input.activationPrice)
      if (!Number.isFinite(activationPrice) || activationPrice <= 0) return '激活价格必须是大于 0 的数字'
    }
  }

  if (input.positionSide && !['BOTH', 'LONG', 'SHORT'].includes(input.positionSide)) return '请选择有效的持仓方向'
  if (input.reduceOnly && input.positionSide && input.positionSide !== 'BOTH') return '双向持仓模式不能使用只减仓参数'
  if (input.reduceOnly && input.closePosition) return '只减仓和全仓平仓不能同时使用'
  if (input.workingType && !['MARK_PRICE', 'CONTRACT_PRICE'].includes(input.workingType)) return '请选择有效的触发价格类型'
  return null
}

export function toBinanceOrderParams(input: BinanceOrderInput): Record<string, string | boolean | undefined> {
  const params: Record<string, string | boolean | undefined> = {
    symbol: input.symbol.toUpperCase(),
    side: input.side,
    type: input.type,
    quantity: input.closePosition ? undefined : input.quantity,
    price: isPriceOrder(input.type) ? input.price : undefined,
    timeInForce: isPriceOrder(input.type) ? input.timeInForce ?? 'GTC' : undefined,
    stopPrice: isTriggeredOrder(input.type) ? input.stopPrice : undefined,
    reduceOnly: input.reduceOnly || undefined,
    closePosition: input.closePosition || undefined,
    positionSide: input.positionSide && input.positionSide !== 'BOTH' ? input.positionSide : undefined,
    workingType: isTriggeredOrder(input.type) || input.type === 'TRAILING_STOP_MARKET' ? input.workingType ?? 'CONTRACT_PRICE' : undefined,
    priceProtect: input.priceProtect && isTriggeredOrder(input.type) ? true : undefined,
    activationPrice: input.type === 'TRAILING_STOP_MARKET' ? input.activationPrice : undefined,
    callbackRate: input.type === 'TRAILING_STOP_MARKET' ? input.callbackRate : undefined,
  }
  return params
}
