import crypto from 'node:crypto'
import { isIP } from 'node:net'
import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { tradableUsdtPerpetuals, type BinanceExchangeSymbol } from '../src/binanceSymbols.js'
import { isMarketExecution, isStepAligned, toBinanceOrderParams, validateBinanceOrder, type BinanceOrderInput } from '../src/binanceOrders.js'

const app = Fastify({ logger: true })
const apiKey = process.env.BINANCE_API_KEY ?? ''
const apiSecret = process.env.BINANCE_API_SECRET ?? ''
const baseUrl = process.env.BINANCE_FUTURES_BASE_URL ?? 'https://fapi.binance.com'
const tradingEnabled = process.env.TRADING_ENABLED === 'true'
const aiKey = process.env.OPENAI_API_KEY ?? ''
const aiModel = process.env.OPENAI_MODEL ?? ''
const aiBaseUrl = (process.env.OPENAI_API_BASE ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
const aiChatUrl = aiBaseUrl.endsWith('/chat/completions') ? aiBaseUrl : `${aiBaseUrl}/chat/completions`

await app.register(cors, {
  origin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
})

type QueryValue = string | number | boolean | undefined

function queryString(params: Record<string, QueryValue>) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
}

async function binanceRequest<T>(method: string, path: string, params: Record<string, QueryValue> = {}, signed = false): Promise<T> {
  const values = signed ? { ...params, timestamp: Date.now(), recvWindow: 5000 } : params
  let query = queryString(values)
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (signed) {
    if (!apiKey || !apiSecret) throw new Error('Binance 私有 API 尚未配置')
    query += `${query ? '&' : ''}signature=${crypto.createHmac('sha256', apiSecret).update(query).digest('hex')}`
    headers['X-MBX-APIKEY'] = apiKey
  }
  const response = await fetch(`${baseUrl}${path}${query ? `?${query}` : ''}`, { method, headers })
  const body = await response.json() as T & { code?: number; msg?: string }
  if (!response.ok) throw new Error(`Binance ${body?.code ?? response.status}: ${body?.msg ?? response.statusText}`)
  return body
}

app.get('/api/health', async () => ({
  ok: true,
  privateApiConfigured: Boolean(apiKey && apiSecret),
  tradingEnabled,
  aiConfigured: Boolean(aiModel && aiBaseUrl),
  publicMarketAvailable: true,
  environment: 'binance-usdm-futures',
}))

app.get('/api/network/ip', async (_request, reply) => {
  const endpoints = ['https://checkip.amazonaws.com', 'https://api.ipify.org?format=json', 'https://ifconfig.me/ip', 'https://icanhazip.com']
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(4000) })
      if (!response.ok) continue
      const body = await response.text()
      let address = body.trim()
      if (address.startsWith('{')) address = (JSON.parse(address) as { ip?: string }).ip?.trim() ?? ''
      if (isIP(address)) return { ip: address }
    } catch { /* 单个公网检测源不可用时，继续尝试备用源。 */ }
  }
  return reply.code(502).send({ error: '公网 IP 检测源暂不可用，请稍后重试' })
})

app.get<{ Querystring: { symbol?: string; interval?: string; limit?: string; endTime?: string } }>('/api/market/klines', async (request, reply) => {
  const symbol = request.query.symbol?.toUpperCase()
  const interval = request.query.interval ?? '1h'
  const limit = Math.min(Number(request.query.limit ?? 150), 1000)
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) return reply.code(400).send({ error: 'A valid symbol is required' })
  if (!['1m', '5m', '15m', '1h', '4h', '1d'].includes(interval)) return reply.code(400).send({ error: 'Unsupported interval' })
  try {
    return await binanceRequest('GET', '/fapi/v1/klines', { symbol, interval, limit, endTime: request.query.endTime })
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '读取 Binance 行情失败' })
  }
})

app.get('/api/market/tickers', async (_request, reply) => {
  try {
    return await binanceRequest('GET', '/fapi/v1/ticker/24hr')
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '读取 Binance 公共行情失败' })
  }
})

app.get<{ Querystring: { symbol?: string } }>('/api/market/ticker', async (request, reply) => {
  const symbol = request.query.symbol?.toUpperCase()
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) return reply.code(400).send({ error: '请提供有效的交易对' })
  try {
    return await binanceRequest('GET', '/fapi/v1/ticker/24hr', { symbol })
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '读取 Binance 实时行情失败' })
  }
})

app.get('/api/market/exchange-info', async (_request, reply) => {
  try {
    return await binanceRequest('GET', '/fapi/v1/exchangeInfo')
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '读取 Binance 交易规则失败' })
  }
})

let cachedSymbols: { expiresAt: number; symbols: Array<{ symbol: string; baseAsset: string }> } | null = null

app.get('/api/market/symbols', async (_request, reply) => {
  if (cachedSymbols && cachedSymbols.expiresAt > Date.now()) return cachedSymbols.symbols
  try {
    const info = await binanceRequest<{ symbols: BinanceExchangeSymbol[] }>('GET', '/fapi/v1/exchangeInfo')
    const symbols = tradableUsdtPerpetuals(info.symbols)
    cachedSymbols = { expiresAt: Date.now() + 10 * 60 * 1000, symbols }
    return symbols
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '读取 Binance 合约列表失败' })
  }
})

app.get('/api/account', async (_request, reply) => {
  try {
    const account = await binanceRequest<{
      totalWalletBalance: string
      availableBalance: string
      totalUnrealizedProfit: string
      assets: Array<{ asset: string; walletBalance: string; availableBalance: string }>
    }>('GET', '/fapi/v2/account', {}, true)
    return { totalWalletBalance: account.totalWalletBalance, availableBalance: account.availableBalance, totalUnrealizedProfit: account.totalUnrealizedProfit, assets: account.assets }
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : '读取账户信息失败' })
  }
})

app.get('/api/positions', async (_request, reply) => {
  try {
    return await binanceRequest('GET', '/fapi/v2/positionRisk', {}, true)
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : '读取持仓失败' })
  }
})

app.get('/api/account/position-mode', async (_request, reply) => {
  try {
    return await binanceRequest('GET', '/fapi/v1/positionSide/dual', {}, true)
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : '读取持仓模式失败' })
  }
})

app.post<{ Body: { symbol?: string; leverage?: number } }>('/api/account/leverage', async (request, reply) => {
  if (!tradingEnabled) return reply.code(403).send({ error: '杠杆设置已关闭，请先启用实盘交易安全开关' })
  const symbol = request.body?.symbol?.toUpperCase()
  const leverage = Number(request.body?.leverage)
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) return reply.code(400).send({ error: '请提供有效的交易对' })
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) return reply.code(400).send({ error: '杠杆必须是 1 到 125 的整数' })
  try {
    return await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage }, true)
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '更新杠杆失败' })
  }
})

app.post<{ Body: { symbol?: string; marginType?: string } }>('/api/account/margin-type', async (request, reply) => {
  if (!tradingEnabled) return reply.code(403).send({ error: '保证金模式设置已关闭，请先启用实盘交易安全开关' })
  const symbol = request.body?.symbol?.toUpperCase()
  const marginType = request.body?.marginType
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) return reply.code(400).send({ error: '请提供有效的交易对' })
  if (marginType !== 'CROSSED' && marginType !== 'ISOLATED') return reply.code(400).send({ error: '保证金模式只能是全仓或逐仓' })
  try {
    return await binanceRequest('POST', '/fapi/v1/marginType', { symbol, marginType }, true)
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '更新保证金模式失败' })
  }
})

app.get<{ Querystring: { symbol?: string } }>('/api/open-orders', async (request, reply) => {
  const symbol = request.query.symbol?.toUpperCase()
  if (symbol && !/^[A-Z0-9]{3,20}$/.test(symbol)) return reply.code(400).send({ error: '请提供有效的交易对' })
  try {
    return await binanceRequest('GET', '/fapi/v1/openOrders', { symbol }, true)
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : '读取当前委托失败' })
  }
})

app.get<{ Querystring: { symbol?: string; limit?: string; orderId?: string } }>('/api/order-history', async (request, reply) => {
  const symbol = request.query.symbol?.toUpperCase()
  const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 1000)
  const orderId = request.query.orderId
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) return reply.code(400).send({ error: '历史订单查询需要有效的交易对' })
  if (!Number.isInteger(limit)) return reply.code(400).send({ error: 'limit 必须是 1 到 1000 的整数' })
  try {
    return await binanceRequest('GET', '/fapi/v1/allOrders', { symbol, limit, orderId }, true)
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : '读取历史订单失败' })
  }
})

type OrderBody = BinanceOrderInput

app.post<{ Body: OrderBody }>('/api/order', async (request, reply) => {
  if (!tradingEnabled) return reply.code(403).send({ error: '实盘交易已关闭。请确认配置无误后，再在后端设置 TRADING_ENABLED=true。' })
  const body = request.body
  if (!body?.symbol || !body.side || !body.type) return reply.code(400).send({ error: 'symbol、side 和 type 为必填项' })
  const validationError = validateBinanceOrder(body)
  if (validationError) return reply.code(400).send({ error: validationError })
  try {
    const info = await binanceRequest<{ symbols: Array<{ symbol: string; filters: Array<{ filterType: string; minQty?: string; maxQty?: string; stepSize?: string; tickSize?: string; minPrice?: string; maxPrice?: string; notional?: string; minNotional?: string }> }> }>('GET', '/fapi/v1/exchangeInfo')
    const marketSymbol = info.symbols.find((item) => item.symbol === body.symbol.toUpperCase())
    if (!marketSymbol) return reply.code(400).send({ error: '该交易对不支持 Binance USDⓈ-M Futures' })
    const filter = (type: string) => marketSymbol.filters.find((item) => item.filterType === type)
    const qtyFilters = body.closePosition ? [] : [filter('LOT_SIZE'), ...(isMarketExecution(body.type) ? [filter('MARKET_LOT_SIZE')] : [])].filter((item): item is NonNullable<typeof item> => item !== undefined)
    const priceFilter = filter('PRICE_FILTER')
    const quantity = body.quantity === undefined ? undefined : Number(body.quantity)
    for (const qtyFilter of qtyFilters) {
      if (quantity !== undefined && qtyFilter.minQty && Number(qtyFilter.minQty) > 0 && quantity < Number(qtyFilter.minQty)) return reply.code(400).send({ error: `数量低于 Binance 最小值 (${qtyFilter.minQty})` })
      if (quantity !== undefined && qtyFilter.maxQty && Number(qtyFilter.maxQty) > 0 && quantity > Number(qtyFilter.maxQty)) return reply.code(400).send({ error: `数量超过 Binance 最大值 (${qtyFilter.maxQty})` })
      if (body.quantity !== undefined && qtyFilter.stepSize && Number(qtyFilter.stepSize) > 0 && !isStepAligned(body.quantity, qtyFilter.stepSize)) return reply.code(400).send({ error: `数量必须符合 Binance 步长 (${qtyFilter.stepSize})` })
    }
    const prices = [body.price, body.stopPrice, body.activationPrice].filter((value): value is string => Boolean(value))
    for (const value of prices) {
      const number = Number(value)
      if (priceFilter?.minPrice && Number(priceFilter.minPrice) > 0 && number < Number(priceFilter.minPrice)) return reply.code(400).send({ error: `价格低于 Binance 最小值 (${priceFilter.minPrice})` })
      if (priceFilter?.maxPrice && Number(priceFilter.maxPrice) > 0 && number > Number(priceFilter.maxPrice)) return reply.code(400).send({ error: `价格超过 Binance 最大值 (${priceFilter.maxPrice})` })
      if (priceFilter?.tickSize && Number(priceFilter.tickSize) > 0 && !isStepAligned(value, priceFilter.tickSize)) return reply.code(400).send({ error: `价格必须符合 Binance 最小变动单位 (${priceFilter.tickSize})` })
    }
    const notionalFilter = filter('MIN_NOTIONAL') ?? filter('NOTIONAL')
    const minimumNotional = Number(notionalFilter?.notional ?? notionalFilter?.minNotional)
    if (quantity !== undefined && minimumNotional > 0) {
      let referencePrice = Number(body.price ?? body.stopPrice)
      if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
        const ticker = await binanceRequest<{ price: string }>('GET', '/fapi/v1/ticker/price', { symbol: body.symbol.toUpperCase() })
        referencePrice = Number(ticker.price)
      }
      if (Number.isFinite(referencePrice) && referencePrice > 0 && quantity * referencePrice < minimumNotional) return reply.code(400).send({ error: `订单名义价值低于 Binance 最小值 (${minimumNotional} USDT)` })
    }
    const params = toBinanceOrderParams(body) as Record<string, QueryValue>
    return await binanceRequest('POST', '/fapi/v1/order', params, true)
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '订单被拒绝' })
  }
})

app.post<{ Body: { question: string; context: { symbol: string; interval: string; price: number | null; analysis?: { environment: string; direction: string; status: string; entry: number | null; support: number | null; resistance: number | null; stopLoss: number | null; takeProfit: number | null; riskReward: number | null }; lines: Array<{ label: string; price: number }>; trends?: Array<{ id: number; start: { time: number; price: number }; end: { time: number; price: number } }>; candles?: Array<{ time: number; open: number; high: number; low: number; close: number }> } } }>('/api/assistant', async (request, reply) => {
  if (!aiModel || !aiBaseUrl) return reply.code(503).send({ error: '本地服务器尚未配置 OpenAI 兼容 AI 服务。' })
  const question = request.body?.question?.trim()
  if (!question) return reply.code(400).send({ error: '请输入问题' })
  const context = request.body.context
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (aiKey) headers.Authorization = `Bearer ${aiKey}`
    const response = await fetch(aiChatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: aiModel,
        messages: [
          { role: 'system', content: '你是 KEEL 个人交易工作台里的中文市场分析助手，服务于 Binance USDⓈ-M Futures 图表。用户主动调用你做复核和解释；本地程序已提供交易对、周期、价格、近期K线、支撑阻力、市场环境、参考入场/止盈/止损/盈亏比及用户画线。只使用本次上下文，不声称拿到了未提供的实时行情，不编造价格、指标或消息。先区分本地程序计算结果与自己的判断；若数据不足、K线不完整或上下文矛盾，明确说明。分析震荡区间时区分下沿、上沿和区间中部：边缘确认后才讨论反弹/回落计划，中部原则上观望；止损应在失效边界之外，止盈优先看区间另一侧，并核对参考盈亏比，空间不足时提示观望。输出简洁、可核对的中文小节：市场状态与依据、计划方向/入场条件、参考止损、参考止盈、参考盈亏比、失效条件与不确定性；没有可用方向时明确写观望。所有价位仅供参考，不保证收益，不替用户下单，也不把建议写成确定预测。' },
          { role: 'user', content: `当前上下文：${JSON.stringify(context)}\n\n问题：${question}` },
        ],
        temperature: 0.4,
      }),
    })
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
    if (!response.ok) return reply.code(502).send({ error: payload.error?.message ?? 'AI 服务请求失败' })
    return { answer: payload.choices?.[0]?.message?.content ?? '' }
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '无法连接 AI 服务' })
  }
})

app.delete<{ Querystring: { symbol?: string; orderId?: string } }>('/api/order', async (request, reply) => {
  if (!tradingEnabled) return reply.code(403).send({ error: '本地服务器已关闭实盘交易。' })
  if (!request.query.symbol || !request.query.orderId) return reply.code(400).send({ error: 'symbol 和 orderId 为必填项' })
  const symbol = request.query.symbol.toUpperCase()
  if (!/^[A-Z0-9]{3,20}$/.test(symbol) || !/^\d+$/.test(request.query.orderId)) return reply.code(400).send({ error: 'symbol 或 orderId 格式无效' })
  try {
    return await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId: request.query.orderId }, true)
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '撤单被拒绝' })
  }
})

app.listen({ port: Number(process.env.PORT ?? 8788), host: '127.0.0.1' }).catch((error) => {
  app.log.error(error)
  process.exit(1)
})

