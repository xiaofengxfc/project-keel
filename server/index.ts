import crypto from 'node:crypto'
import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'

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

app.get<{ Querystring: { symbol?: string } }>('/api/open-orders', async (request, reply) => {
  try {
    return await binanceRequest('GET', '/fapi/v1/openOrders', { symbol: request.query.symbol?.toUpperCase() }, true)
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : '读取当前委托失败' })
  }
})

type OrderBody = {
  symbol: string
  side: 'BUY' | 'SELL'
  type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'
  quantity?: string
  price?: string
  stopPrice?: string
  reduceOnly?: boolean
}

app.post<{ Body: OrderBody }>('/api/order', async (request, reply) => {
  if (!tradingEnabled) return reply.code(403).send({ error: '实盘交易已关闭。请确认配置无误后，再在后端设置 TRADING_ENABLED=true。' })
  const body = request.body
  if (!body?.symbol || !body.side || !body.type || !body.quantity) return reply.code(400).send({ error: 'symbol、side、type 和 quantity 为必填项' })
  if (body.type === 'LIMIT' && (!body.price || body.price.trim() === '')) return reply.code(400).send({ error: '限价单必须填写价格' })
  if ((body.type === 'STOP_MARKET' || body.type === 'TAKE_PROFIT_MARKET') && (!body.stopPrice || body.stopPrice.trim() === '')) return reply.code(400).send({ error: '止损或止盈单必须填写触发价格' })
  try {
    const info = await binanceRequest<{ symbols: Array<{ symbol: string; filters: Array<{ filterType: string; minQty?: string; maxQty?: string; stepSize?: string; tickSize?: string; minPrice?: string; maxPrice?: string; notional?: string }> }> }>('GET', '/fapi/v1/exchangeInfo')
    const marketSymbol = info.symbols.find((item) => item.symbol === body.symbol.toUpperCase())
    if (!marketSymbol) return reply.code(400).send({ error: '该交易对不支持 Binance USDⓈ-M Futures' })
    const filter = (type: string) => marketSymbol.filters.find((item) => item.filterType === type)
    const qtyFilter = filter(body.type === 'MARKET' ? 'MARKET_LOT_SIZE' : 'LOT_SIZE') ?? filter('LOT_SIZE')
    const priceFilter = filter('PRICE_FILTER')
    const quantity = Number(body.quantity)
    const priceValue = Number(body.price ?? body.stopPrice)
    if (!Number.isFinite(quantity) || quantity <= 0) return reply.code(400).send({ error: '数量必须是大于 0 的数字' })
    if (qtyFilter?.minQty && quantity < Number(qtyFilter.minQty)) return reply.code(400).send({ error: `数量低于 Binance 最小值 (${qtyFilter.minQty})` })
    if (qtyFilter?.maxQty && quantity > Number(qtyFilter.maxQty)) return reply.code(400).send({ error: `数量超过 Binance 最大值 (${qtyFilter.maxQty})` })
    if (qtyFilter?.stepSize && Number(qtyFilter.stepSize) > 0 && Math.abs(quantity / Number(qtyFilter.stepSize) - Math.round(quantity / Number(qtyFilter.stepSize))) > 1e-7) return reply.code(400).send({ error: `数量必须符合 Binance 步长 (${qtyFilter.stepSize})` })
    if (body.type !== 'MARKET' && (!Number.isFinite(priceValue) || priceValue <= 0)) return reply.code(400).send({ error: '价格必须是大于 0 的数字' })
    if (body.type !== 'MARKET' && priceFilter?.tickSize && Math.abs(priceValue / Number(priceFilter.tickSize) - Math.round(priceValue / Number(priceFilter.tickSize))) > 1e-7) return reply.code(400).send({ error: `价格必须符合 Binance 最小变动单位 (${priceFilter.tickSize})` })
    const params: Record<string, QueryValue> = { symbol: body.symbol.toUpperCase(), side: body.side, type: body.type, quantity: body.quantity, price: body.price, stopPrice: body.stopPrice, reduceOnly: body.reduceOnly }
    if (body.type === 'LIMIT') params.timeInForce = 'GTC'
    return await binanceRequest('POST', '/fapi/v1/order', params, true)
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '订单被拒绝' })
  }
})

app.post<{ Body: { question: string; context: { symbol: string; interval: string; price: number | null; analysis?: { environment: string; direction: string; status: string; entry: number | null; support: number | null; resistance: number | null; stopLoss: number | null; takeProfit: number | null; riskReward: number | null }; lines: Array<{ label: string; price: number }> } } }>('/api/assistant', async (request, reply) => {
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
          { role: 'system', content: '你是交易工作台中的信息助手。只基于用户提供的行情上下文回答，不编造实时数据，不保证收益，不替用户下单；明确标注不确定性。' },
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
  try {
    return await binanceRequest('DELETE', '/fapi/v1/order', { symbol: request.query.symbol.toUpperCase(), orderId: request.query.orderId }, true)
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '撤单被拒绝' })
  }
})

app.listen({ port: Number(process.env.PORT ?? 8788), host: '127.0.0.1' }).catch((error) => {
  app.log.error(error)
  process.exit(1)
})

