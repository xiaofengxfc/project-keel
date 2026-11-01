import crypto from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, resolve } from 'node:path'
import 'dotenv/config'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici'
import { tradableUsdtPerpetuals, type BinanceExchangeSymbol } from '../src/binanceSymbols.js'
import { isMarketExecution, isStepAligned, requiresAlgoEndpoint, toBinanceOrderParams, validateBinanceOrder, type BinanceOrderInput } from '../src/binanceOrders.js'
import { maximumLeverageForBrackets, protectionOrderDirection } from '../src/binanceTrading.js'
import { replaceProtectionOrderSet, type ProtectionOrderKind, type ProtectionOrderSnapshot, type ProtectionOrderValue } from '../src/protectionOrders.js'
import { getBinanceApiCredentials, getBinanceEnvironmentConfig } from '../src/binanceEnvironment.js'
import { parsePrediction, type PredictionResult } from '../src/prediction.js'

const app = Fastify({ logger: true })
const binanceConfig = getBinanceEnvironmentConfig(process.env.BINANCE_ENV, process.env.BINANCE_FUTURES_BASE_URL, process.env.BINANCE_FUTURES_WS_URL)
const { apiKey, apiSecret } = getBinanceApiCredentials(binanceConfig.environment, process.env)
const baseUrl = binanceConfig.restBaseUrl
const tradingEnabled = process.env.TRADING_ENABLED === 'true'
const aiKey = process.env.OPENAI_API_KEY ?? ''
const aiModel = process.env.OPENAI_MODEL ?? ''
const aiBaseUrl = (process.env.OPENAI_API_BASE ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
const aiChatUrl = aiBaseUrl.endsWith('/chat/completions') ? aiBaseUrl : `${aiBaseUrl}/chat/completions`

function configuredHttpsProxy() {
  const explicitProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy
  if (explicitProxy?.trim()) return explicitProxy.trim()
  if (process.platform !== 'win32') return ''
  try {
    const settingsKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const enabled = execFileSync('reg', ['query', settingsKey, '/v', 'ProxyEnable'], { encoding: 'utf8', windowsHide: true })
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled)) return ''
    const rawProxy = execFileSync('reg', ['query', settingsKey, '/v', 'ProxyServer'], { encoding: 'utf8', windowsHide: true })
      .match(/ProxyServer\s+REG_SZ\s+(.+)/i)?.[1]?.trim()
    if (!rawProxy) return ''
    const configured = rawProxy.split(';').map((entry) => entry.trim()).find((entry) => /^https=/i.test(entry))?.replace(/^https=/i, '') ?? rawProxy.split(';')[0].trim()
    if (!configured) return ''
    return /^[a-z][a-z\d+.-]*:\/\//i.test(configured) ? configured : `http://${configured}`
  } catch {
    return ''
  }
}

const httpsProxy = configuredHttpsProxy()
if (httpsProxy) setGlobalDispatcher(new ProxyAgent(httpsProxy))

// Reasoning models and compatible gateways can occasionally take longer than the
// 30 second default used by AbortSignal.timeout. Keep the request alive long
// enough for a normal completion, while allowing deployments to tune the limit.
const configuredAiTimeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? 120_000)
const aiTimeoutMs = Number.isFinite(configuredAiTimeoutMs) && configuredAiTimeoutMs >= 10_000
  ? Math.min(Math.round(configuredAiTimeoutMs), 300_000)
  : 120_000
const configuredAiMaxTokens = Number(process.env.OPENAI_MAX_TOKENS ?? 900)
const aiMaxTokens = Number.isFinite(configuredAiMaxTokens) && configuredAiMaxTokens >= 128
  ? Math.min(Math.round(configuredAiMaxTokens), 4_096)
  : 900
// The local prediction service is the default direction source. Set this to
// false explicitly when a deployment does not want model predictions.
const predictionEnabled = process.env.PREDICTION_ENABLED !== 'false'
const predictionServiceUrl = (process.env.PREDICTION_SERVICE_URL ?? 'http://127.0.0.1:8790/predict').replace(/\/$/, '')
const configuredPredictionTimeoutMs = Number(process.env.PREDICTION_TIMEOUT_MS ?? 10_000)
const predictionTimeoutMs = Number.isFinite(configuredPredictionTimeoutMs) && configuredPredictionTimeoutMs >= 2_000
  ? Math.min(Math.round(configuredPredictionTimeoutMs), 30_000)
  : 10_000
const predictionDispatcher = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::|\/)/i.test(predictionServiceUrl) ? new Agent() : undefined
let serverTimeOffsetMs = 0
let serverTimeSyncAt = 0

async function syncBinanceServerTime(force = false) {
  if (!force && Date.now() - serverTimeSyncAt < 60_000) return serverTimeOffsetMs
  try {
    const startedAt = Date.now()
    const response = await fetch(`${baseUrl}/fapi/v1/time`, { signal: AbortSignal.timeout(4000) })
    if (!response.ok) return serverTimeOffsetMs
    const body = await response.json() as { serverTime?: number }
    if (Number.isFinite(body.serverTime)) serverTimeOffsetMs = Number(body.serverTime) - Math.round((startedAt + Date.now()) / 2)
    serverTimeSyncAt = Date.now()
  } catch { /* 使用本机时间继续请求。 */ }
  return serverTimeOffsetMs
}

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
  const values = signed ? { ...params, timestamp: Date.now() + await syncBinanceServerTime(), recvWindow: 10000 } : params
  let query = queryString(values)
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (signed) {
    if (!apiKey || !apiSecret) throw new Error('Binance 私有 API 尚未配置')
    query += `${query ? '&' : ''}signature=${crypto.createHmac('sha256', apiSecret).update(query).digest('hex')}`
    headers['X-MBX-APIKEY'] = apiKey
  }
  const response = await fetch(`${baseUrl}${path}${query ? `?${query}` : ''}`, { method, headers, signal: AbortSignal.timeout(10000) })
  const body = await response.json() as T & { code?: number; msg?: string }
  if (!response.ok) {
    const code = body?.code ?? response.status
    if (code === -2015) throw new Error('Binance API Key 无效、未通过当前出口 IP 白名单，或未开启 USDⓈ-M 合约权限。请检查正式网 API 配置。')
    if (code === -4531) throw new Error('切换持仓模式失败：CM 合约账户仍有持仓或未完成订单，请先清理 CM 持仓和订单后重试。')
    throw new Error(`Binance ${code}: ${body?.msg ?? response.statusText}`)
  }
  return body
}

app.get('/api/health', async () => ({
  ok: true,
  privateApiConfigured: Boolean(apiKey && apiSecret),
  tradingEnabled,
  aiConfigured: Boolean(aiModel && aiBaseUrl),
  predictionConfigured: predictionEnabled && Boolean(predictionServiceUrl),
  publicMarketAvailable: true,
  environment: binanceConfig.environment,
  websocketBaseUrl: binanceConfig.websocketBaseUrl,
}))

const detectCurrentIp = async (_request: FastifyRequest, reply: FastifyReply) => {
  const endpoints = ['https://checkip.amazonaws.com', 'https://api.ipify.org?format=json', 'https://ifconfig.me/ip', 'https://icanhazip.com']
  let ipv6Address = ''
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(4000) })
      if (!response.ok) continue
      const body = await response.text()
      let address = body.trim()
      if (address.startsWith('{')) address = (JSON.parse(address) as { ip?: string }).ip?.trim() ?? ''
      if (isIP(address) === 4) return { ip: address }
      if (!ipv6Address && isIP(address) === 6) ipv6Address = address
    } catch { /* 单个公网检测源不可用时，继续尝试备用源。 */ }
  }
  if (ipv6Address) return { ip: ipv6Address }
  return reply.code(502).send({ error: '当前 IP 检测源暂不可用，请稍后重试' })
}

app.get('/api/network/ip', detectCurrentIp)
app.get('/api/network/current-ip', detectCurrentIp)

app.get<{ Querystring: { symbol?: string; interval?: string; limit?: string; endTime?: string } }>('/api/market/klines', async (request, reply) => {
  const symbol = request.query.symbol?.toUpperCase()
  const interval = request.query.interval ?? '1h'
  const rawLimit = Number(request.query.limit ?? 150)
  const limit = Math.min(Math.max(rawLimit, 1), 1000)
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) return reply.code(400).send({ error: 'A valid symbol is required' })
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || !['1m', '5m', '15m', '1h', '4h', '1d'].includes(interval)) return reply.code(400).send({ error: 'Unsupported interval or limit' })
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
const protectionLocks = new Map<string, Promise<void>>()

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

type PredictionCandleInput = { time?: number; open?: number; high?: number; low?: number; close?: number; volume?: number }
type PredictionRequestBody = { symbol?: string; interval?: string; candles?: PredictionCandleInput[]; horizonBars?: number }
type PredictionTrainingMetrics = { accuracy?: number; brier?: number; testSamples?: number }
type PredictionTrainingIntervalResult = {
  phase: 'pending' | 'running' | 'completed' | 'not-promoted' | 'failed' | 'stopped'
  error?: string | null
  metrics?: PredictionTrainingMetrics
  finishedAt?: number
}
type PredictionTrainingJob = {
  jobId: string | null
  running: boolean
  phase: 'idle' | 'running' | 'partial' | 'completed' | 'not-promoted' | 'failed' | 'stopped'
  stage?: string
  output: string
  error: string | null
  startedAt: number | null
  finishedAt: number | null
  intervals?: string[]
  currentInterval?: string
  completedIntervals?: string[]
  finishedIntervals?: string[]
  intervalResults?: Record<string, PredictionTrainingIntervalResult>
  currentSymbol?: string
  symbolIndex?: number
  symbolCount?: number
  pagesFetched?: number
  rowsFetched?: number
  intervalIndex?: number
  workerPid?: number
  interval?: string
  symbols?: string[]
  metrics?: PredictionTrainingMetrics
}
const trainingStatePath = resolve(process.env.PREDICTION_TRAINING_STATE_FILE ?? 'prediction/validation/training-state.json')
const trainingLogPath = resolve(process.env.PREDICTION_TRAINING_LOG_FILE ?? 'prediction/validation/training.log')
const trainingProgressPath = resolve(dirname(trainingStatePath), 'training-progress.json')
let predictionTrainingJob: PredictionTrainingJob = { jobId: null, running: false, phase: 'idle', output: '', error: null, startedAt: null, finishedAt: null }
let predictionTrainingProcess: ChildProcess | null = null
let predictionTrainingStartInFlight = false
let predictionTrainingStopInFlight = false

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM still means the process exists; only ESRCH proves it has exited.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForPidExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (isPidRunning(pid)) throw new Error(`训练进程 ${pid} 在停止信号后仍未退出。`)
}

async function stopProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) throw new Error('找不到训练工作进程，无法停止。')
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGTERM') } catch { /* The worker may already have exited. */ }
    await waitForPidExit(pid)
    return
  }
  await new Promise<void>((resolve, reject) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.once('error', (error) => {
      if (!isPidRunning(pid)) resolve()
      else reject(new Error(`无法启动 taskkill：${error.message}`))
    })
    killer.once('close', (code) => {
      if (code === 0 || !isPidRunning(pid)) resolve()
      else reject(new Error(`taskkill 未能终止训练进程树（退出代码 ${code ?? 'unknown'}）。`))
    })
  })
  await waitForPidExit(pid)
}

async function persistPredictionTrainingJob(job: PredictionTrainingJob) {
  await mkdir(dirname(trainingStatePath), { recursive: true })
  const temporaryPath = `${trainingStatePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, JSON.stringify(job), 'utf8')
  await rename(temporaryPath, trainingStatePath)
  predictionTrainingJob = job
}

async function mergePredictionTrainingProgress(job: PredictionTrainingJob): Promise<PredictionTrainingJob> {
  if (!job.jobId) return job
  try {
    const progress = JSON.parse(await readFile(trainingProgressPath, 'utf8')) as Record<string, unknown>
    if (!progress || progress.jobId !== job.jobId) return job
    const merged = { ...job }
    if (job.running) {
      if (typeof progress.phase === 'string') merged.stage = progress.phase
      if (typeof progress.interval === 'string') merged.currentInterval = progress.interval
      if (typeof progress.currentSymbol === 'string') merged.currentSymbol = progress.currentSymbol
      if (typeof progress.symbolIndex === 'number') merged.symbolIndex = progress.symbolIndex
      if (typeof progress.symbolCount === 'number') merged.symbolCount = progress.symbolCount
    }
    if (typeof progress.pagesFetched === 'number') merged.pagesFetched = Math.max(job.pagesFetched ?? 0, progress.pagesFetched)
    if (typeof progress.rowsFetched === 'number') merged.rowsFetched = Math.max(job.rowsFetched ?? 0, progress.rowsFetched)
    return merged
  } catch {
    return job
  }
}

async function readPredictionTrainingJob(): Promise<PredictionTrainingJob> {
  try {
    let value = JSON.parse(await readFile(trainingStatePath, 'utf8')) as PredictionTrainingJob
    if (!value || typeof value !== 'object' || typeof value.running !== 'boolean' || !['idle', 'running', 'partial', 'completed', 'not-promoted', 'failed', 'stopped'].includes(value.phase)) throw new Error('训练状态文件格式无效')
    value = await mergePredictionTrainingProgress(value)
    if (value.running && predictionTrainingProcess === null && !predictionTrainingStopInFlight) {
      let alive = false
      if (value.workerPid && Number.isInteger(value.workerPid)) {
        try { process.kill(value.workerPid, 0); alive = true } catch { alive = false }
      } else if (value.startedAt && Date.now() - value.startedAt < 30_000) {
        alive = true
      }
      if (!alive) {
        const recovered = { ...value, running: false, phase: 'failed' as const, stage: 'interrupted', error: '后端重启期间训练工作进程已退出；请查看已保存日志后重新启动。', finishedAt: Date.now() }
        await persistPredictionTrainingJob(recovered)
        return recovered
      }
    }
    try { value.output = (await readFile(trainingLogPath, 'utf8')).slice(-12_000) } catch { value.output = '' }
    predictionTrainingJob = value
    return value
  } catch {
    return predictionTrainingJob
  }
}

app.post<{ Body: PredictionRequestBody }>('/api/prediction', async (request, reply) => {
  if (!predictionEnabled) return reply.code(503).send({ error: '本地预测模型已被配置关闭，请设置 PREDICTION_ENABLED=true 后重启后端。' })
  const symbol = request.body?.symbol?.toUpperCase()
  const interval = request.body?.interval
  const candles = request.body?.candles
  const horizonBars = request.body?.horizonBars ?? 3
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) return reply.code(400).send({ error: '请提供有效的预测交易对' })
  if (!interval || !['15m', '1h', '4h', '1d'].includes(interval)) return reply.code(400).send({ error: '请提供有效的预测周期' })
  if (!Array.isArray(candles) || candles.length < 50 || candles.length > 500) return reply.code(400).send({ error: '预测至少需要 50 根、最多 500 根已收盘 K 线' })
  if (!Number.isInteger(horizonBars) || horizonBars < 1 || horizonBars > 20) return reply.code(400).send({ error: '预测跨度必须是 1 到 20 根 K 线' })
  const normalizedCandles = candles.map((candle) => ({
    time: Number(candle.time),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume ?? 0),
  }))
  const validCandles = normalizedCandles.every((candle, index) => {
    const previous = normalizedCandles[index - 1]
    return Number.isFinite(candle.time) && candle.time > 0 && (!previous || candle.time > previous.time)
      && [candle.open, candle.high, candle.low, candle.close, candle.volume].every((value) => Number.isFinite(value) && value >= 0)
      && candle.open > 0 && candle.high >= Math.max(candle.open, candle.close, candle.low) && candle.low <= Math.min(candle.open, candle.close, candle.high)
  })
  if (!validCandles) return reply.code(400).send({ error: '预测 K 线数据格式无效或时间顺序错误' })
  try {
    const response = await fetch(predictionServiceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(predictionTimeoutMs),
      ...(predictionDispatcher ? { dispatcher: predictionDispatcher } : {}),
      body: JSON.stringify({ symbol, interval, candles: normalizedCandles, horizonBars }),
    })
    let payload: unknown = null
    try { payload = await response.json() } catch { /* 将由统一错误响应处理。 */ }
    if (!response.ok) {
      const message = payload && typeof payload === 'object'
        ? 'error' in payload && typeof payload.error === 'string' ? payload.error : 'detail' in payload && typeof payload.detail === 'string' ? payload.detail : `预测服务返回 ${response.status}`
        : `预测服务返回 ${response.status}`
      return reply.code(503).send({ error: message })
    }
    const prediction = parsePrediction(payload)
    if (!prediction) return reply.code(503).send({ error: '预测服务返回的数据格式无效' })
    return prediction satisfies PredictionResult
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') return reply.code(504).send({ error: `预测模型响应超时（${Math.round(predictionTimeoutMs / 1000)} 秒）` })
    return reply.code(503).send({ error: error instanceof Error ? `预测服务不可用：${error.message}` : '预测服务不可用' })
  }
})

app.get('/api/prediction/train/status', async () => readPredictionTrainingJob())

app.post('/api/prediction/train/stop', async (_request, reply) => {
  if (predictionTrainingStopInFlight) return reply.code(409).send({ error: '正在停止模型训练，请稍候。', jobId: predictionTrainingJob.jobId })
  if (predictionTrainingStartInFlight) return reply.code(409).send({ error: '模型训练正在准备启动，请稍候再停止。', jobId: predictionTrainingJob.jobId })
  predictionTrainingStopInFlight = true
  let current: PredictionTrainingJob | null = null
  try {
    current = await readPredictionTrainingJob()
    if (!current.running) return reply.code(409).send({ error: '当前没有正在运行的模型训练任务。', jobId: current.jobId })
    const pid = predictionTrainingProcess?.pid ?? current.workerPid
    await persistPredictionTrainingJob({ ...current, stage: 'stopping', error: null })
    await stopProcessTree(pid)
    const latest = await readPredictionTrainingJob()
    const intervalResults = { ...(latest.intervalResults ?? {}) }
    const stoppedAt = Date.now()
    for (const [interval, result] of Object.entries(intervalResults)) {
      if (result && ['pending', 'running'].includes(result.phase)) {
        intervalResults[interval] = { ...result, phase: 'stopped', error: '训练已由用户停止', finishedAt: stoppedAt }
      }
    }
    const finishedIntervals = [...new Set([
      ...(latest.finishedIntervals ?? []),
      ...Object.entries(intervalResults).filter(([, result]) => result?.phase === 'stopped').map(([interval]) => interval),
    ])]
    const stopped = {
      ...latest,
      running: false,
      phase: 'stopped' as const,
      stage: 'stopped',
      error: '训练已由用户停止。已保存的 K 线数据和模型文件保持不变。',
      finishedAt: stoppedAt,
      currentSymbol: undefined,
      intervalResults,
      finishedIntervals,
      workerPid: undefined,
    }
    await persistPredictionTrainingJob(stopped)
    predictionTrainingProcess = null
    return stopped
  } catch (error) {
    return reply.code(500).send({ error: error instanceof Error ? `停止模型训练失败：${error.message}` : '停止模型训练失败', jobId: current?.jobId ?? predictionTrainingJob.jobId })
  } finally {
    predictionTrainingStopInFlight = false
  }
})

app.get<{ Querystring: { symbol?: string; interval?: string; horizonBars?: string } }>('/api/prediction/validation/metrics', async (request, reply) => {
  const { symbol, interval, horizonBars } = request.query
  if (symbol && !/^[A-Z0-9]{3,20}$/i.test(symbol)) return reply.code(400).send({ error: 'symbol 格式无效' })
  if (interval && !['15m', '1h', '4h', '1d'].includes(interval)) return reply.code(400).send({ error: 'interval 必须是 15m、1h、4h 或 1d' })
  const parsedHorizon = horizonBars === undefined ? undefined : Number(horizonBars)
  if (parsedHorizon !== undefined && (!Number.isInteger(parsedHorizon) || parsedHorizon < 1 || parsedHorizon > 100)) return reply.code(400).send({ error: 'horizonBars 必须是 1 到 100' })
  try {
    const predictionUrl = new URL(predictionServiceUrl)
    const metricsUrl = new URL('/validation/metrics', predictionUrl)
    if (symbol) metricsUrl.searchParams.set('symbol', symbol.toUpperCase())
    if (interval) metricsUrl.searchParams.set('interval', interval)
    if (parsedHorizon !== undefined) metricsUrl.searchParams.set('horizonBars', String(parsedHorizon))
    const response = await fetch(metricsUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(predictionTimeoutMs),
      ...(predictionDispatcher ? { dispatcher: predictionDispatcher } : {}),
    })
    const payload = await response.json() as unknown
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && 'detail' in payload && typeof payload.detail === 'string' ? payload.detail : `验证服务返回 ${response.status}`
      return reply.code(503).send({ error: message })
    }
    return payload
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? `前向验证暂不可用：${error.message}` : '前向验证暂不可用' })
  }
})

app.post<{ Body: { interval?: string; intervals?: string[]; symbolCount?: number; symbols?: string[] } }>('/api/prediction/train', async (request, reply) => {
  const currentJob = await readPredictionTrainingJob()
  if (currentJob.running || predictionTrainingStartInFlight || predictionTrainingStopInFlight) return reply.code(409).send({ error: '模型训练正在运行或准备中，请等待完成。', jobId: currentJob.jobId })
  const intervalInput = request.body?.intervals ?? (request.body?.interval ? [request.body.interval] : [])
  if (!Array.isArray(intervalInput) || intervalInput.length < 1 || intervalInput.length > 4) return reply.code(400).send({ error: '请选择 1 到 4 个训练周期。' })
  const intervals = [...new Set(intervalInput.map((value) => String(value).trim()))]
  if (!intervals.length || intervals.some((value) => !['15m', '1h', '4h', '1d'].includes(value))) return reply.code(400).send({ error: '请选择有效周期：15m、1h、4h 或 1d。' })
  const symbolCount = Number(request.body?.symbolCount)
  if (!Number.isInteger(symbolCount) || symbolCount < 2 || symbolCount > 30) return reply.code(400).send({ error: '币种数量必须是 2 到 30 之间的整数。' })
  if (request.body?.symbols !== undefined && !Array.isArray(request.body.symbols)) return reply.code(400).send({ error: '手动币种列表格式无效。' })
  const requestedSymbols = [...new Set((request.body?.symbols ?? []).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))]
  if (requestedSymbols.some((symbol) => !/^[A-Z0-9]{3,20}$/.test(symbol))) return reply.code(400).send({ error: '手动填写的交易对格式无效。' })
  if (requestedSymbols.length > symbolCount) return reply.code(400).send({ error: `手动填写的交易对不能超过 ${symbolCount} 个。` })
  predictionTrainingStartInFlight = true
  let symbols: string[] = []
  try {
    let catalog: Array<{ symbol: string; baseAsset: string }>
    if (cachedSymbols && cachedSymbols.expiresAt > Date.now()) {
      catalog = cachedSymbols.symbols
    } else {
      const info = await binanceRequest<{ symbols: BinanceExchangeSymbol[] }>('GET', '/fapi/v1/exchangeInfo')
      const next = tradableUsdtPerpetuals(info.symbols)
      cachedSymbols = { expiresAt: Date.now() + 10 * 60 * 1000, symbols: next }
      catalog = next
    }
    symbols = catalog.map(({ symbol }) => symbol.toUpperCase())
    const available = new Set(symbols)
    const unavailable = requestedSymbols.filter((symbol) => !available.has(symbol))
    if (unavailable.length) return reply.code(400).send({ error: `交易对当前不可用：${unavailable.join(', ')}` })
    const pool = symbols.filter((symbol) => !requestedSymbols.includes(symbol))
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swapIndex = crypto.randomInt(index + 1)
      ;[pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]]
    }
    symbols = [...requestedSymbols, ...pool.slice(0, symbolCount - requestedSymbols.length)]
    if (symbols.length < symbolCount) return reply.code(502).send({ error: `Binance 当前仅返回 ${symbols.length} 个可训练交易对。` })
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? `获取 Binance 训练币种失败：${error.message}` : '获取 Binance 训练币种失败' })
  } finally {
    predictionTrainingStartInFlight = false
  }
  // Keep the start lock through durable state creation and worker spawn so a
  // concurrent request cannot slip into the small async gap above.
  predictionTrainingStartInFlight = true
  const configuredPythonPath = process.env.PREDICTION_PYTHON?.trim()
  const virtualenvPython = resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const virtualenvPythonw = resolve('.venv', process.platform === 'win32' ? 'Scripts/pythonw.exe' : 'bin/python')
  const pythonPath = configuredPythonPath
    || (process.platform === 'win32' && existsSync(virtualenvPythonw) ? virtualenvPythonw : existsSync(virtualenvPython) ? virtualenvPython : process.platform === 'win32' ? 'pythonw' : 'python')
  const jobId = crypto.randomUUID()
  const progressPath = resolve(dirname(trainingStatePath), 'training-progress.json')
  const initialJob: PredictionTrainingJob = {
    jobId,
    running: true,
    phase: 'running',
    stage: 'starting',
    output: '',
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    intervals,
    interval: intervals.length === 1 ? intervals[0] : undefined,
    currentInterval: intervals[0],
    completedIntervals: [],
    finishedIntervals: [],
    intervalResults: Object.fromEntries(intervals.map((value) => [value, { phase: 'pending' }])),
    symbols,
    symbolCount: symbols.length,
    symbolIndex: 0,
    pagesFetched: 0,
    rowsFetched: 0,
  }
  try {
    await mkdir(dirname(trainingStatePath), { recursive: true })
    await writeFile(trainingLogPath, `任务 ${jobId} 已创建\n币种：${symbols.join(', ')}\n周期：${intervals.join(', ')}\n`, 'utf8')
    await writeFile(progressPath, JSON.stringify({ jobId, phase: 'starting', interval: intervals[0] }), 'utf8')
    await persistPredictionTrainingJob(initialJob)
    const child = spawn(pythonPath, [
      '-u', '-m', 'prediction.training_worker',
      '--job-id', jobId,
      '--intervals', intervals.join(','),
      '--symbols', symbols.join(','),
      '--state-file', trainingStatePath,
      '--progress-file', progressPath,
      '--log-file', trainingLogPath,
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      detached: true,
      env: { ...process.env, PREDICTION_TRAINING_PROGRESS_FILE: progressPath },
      stdio: 'ignore',
    })
    predictionTrainingProcess = child
    child.on('error', (error) => {
      void (async () => {
        const latest = await readPredictionTrainingJob()
        if (latest.jobId !== jobId) return
        const failed = { ...latest, running: false, phase: 'failed' as const, stage: 'worker-start-failed', error: `无法启动训练工作进程：${error.message}`, finishedAt: Date.now() }
        await persistPredictionTrainingJob(failed)
        await writeFile(trainingLogPath, `${failed.error}\n`, { flag: 'a' })
        predictionTrainingProcess = null
      })()
    })
    child.once('close', () => {
      if (predictionTrainingProcess === child) predictionTrainingProcess = null
    })
    child.unref()
    predictionTrainingStartInFlight = false
    return reply.code(202).send(await readPredictionTrainingJob())
  } catch (error) {
    predictionTrainingStartInFlight = false
    predictionTrainingProcess = null
    const message = error instanceof Error ? error.message : '无法启动模型训练'
    const failed = { ...initialJob, running: false, phase: 'failed' as const, stage: 'worker-start-failed', error: message, finishedAt: Date.now() }
    await persistPredictionTrainingJob(failed)
    return reply.code(503).send({ error: message, jobId })
  }
})

app.get('/api/account', async (_request, reply) => {
  try {
    const account = await binanceRequest<{
      totalWalletBalance: string
      availableBalance: string
      totalUnrealizedProfit: string
      assets: Array<{ asset: string; walletBalance: string; availableBalance: string }>
    }>('GET', '/fapi/v3/account', {}, true)
    return { totalWalletBalance: account.totalWalletBalance, availableBalance: account.availableBalance, totalUnrealizedProfit: account.totalUnrealizedProfit, assets: account.assets }
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : '读取账户信息失败' })
  }
})

app.get('/api/positions', async (_request, reply) => {
  try {
    return await binanceRequest('GET', '/fapi/v3/positionRisk', {}, true)
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

app.post<{ Body: { dualSidePosition?: boolean } }>('/api/account/position-mode', async (request, reply) => {
  if (!tradingEnabled) return reply.code(403).send({ error: '持仓模式设置已关闭，请先启用交易安全开关' })
  if (typeof request.body?.dualSidePosition !== 'boolean') return reply.code(400).send({ error: '请选择单向或双向持仓模式' })
  try {
    return await binanceRequest('POST', '/fapi/v1/positionSide/dual', { dualSidePosition: request.body.dualSidePosition }, true)
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '更新持仓模式失败' })
  }
})

app.post<{ Body: { symbol?: string; leverage?: number } }>('/api/account/leverage', async (request, reply) => {
  if (!tradingEnabled) return reply.code(403).send({ error: '杠杆设置已关闭，请先启用实盘交易安全开关' })
  const symbol = request.body?.symbol?.toUpperCase()
  const leverage = Number(request.body?.leverage)
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) return reply.code(400).send({ error: '请提供有效的交易对' })
  if (!Number.isInteger(leverage) || leverage < 1) return reply.code(400).send({ error: '杠杆必须是大于等于 1 的整数' })
  try {
    const rows = await binanceRequest<Array<{ symbol: string; brackets: Array<{ initialLeverage: number; notionalFloor?: string; notionalCap?: string }> }>>('GET', '/fapi/v1/leverageBracket', { symbol }, true)
    const row = rows.find((item) => item.symbol === symbol)
    const maximum = maximumLeverageForBrackets((row?.brackets ?? []).map((item, index) => ({ bracket: index + 1, initialLeverage: Number(item.initialLeverage), notionalFloor: item.notionalFloor ?? '0', notionalCap: item.notionalCap ?? Number.MAX_SAFE_INTEGER.toString() })))
    if (!maximum) return reply.code(503).send({ error: '未读取到该币种的真实杠杆上限' })
    if (leverage > maximum) return reply.code(400).send({ error: `杠杆超过 ${symbol} 的真实最大值 ${maximum}x` })
    return await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage }, true)
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '更新杠杆失败' })
  }
})

app.get<{ Querystring: { symbol?: string } }>('/api/account/leverage-brackets', async (request, reply) => {
  const symbol = request.query.symbol?.toUpperCase()
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) return reply.code(400).send({ error: '请提供有效的交易对' })
  try {
    const rows = await binanceRequest<Array<{ symbol: string; brackets: Array<{ bracket: number; initialLeverage: number; notionalFloor?: string; notionalCap: string }> }>>('GET', '/fapi/v1/leverageBracket', { symbol }, true)
    const row = rows.find((item) => item.symbol === symbol)
    if (!row) return reply.code(404).send({ error: '未找到该合约的杠杆档位' })
    return { symbol: row.symbol, brackets: row.brackets.map((bracket, index) => ({ ...bracket, notionalFloor: bracket.notionalFloor ?? (index === 0 ? '0' : row.brackets[index - 1]?.notionalCap ?? '0') })) }
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : '读取杠杆档位失败' })
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
    const fetchPart = (requestPromise: Promise<Array<Record<string, unknown>>>) => requestPromise
      .then((data) => ({ data, error: null as Error | null }))
      .catch((error: unknown) => ({ data: null, error: error instanceof Error ? error : new Error('请求失败') }))
    const [standardResult, algoResult] = await Promise.all([
      fetchPart(binanceRequest<Array<Record<string, unknown>>>('GET', '/fapi/v1/openOrders', { symbol }, true)),
      fetchPart(binanceRequest<Array<Record<string, unknown>>>('GET', '/fapi/v1/openAlgoOrders', { symbol }, true)),
    ])
    if (!standardResult.data && !algoResult.data) {
      throw new Error(`普通委托：${standardResult.error?.message ?? '读取失败'}；条件委托：${algoResult.error?.message ?? '读取失败'}`)
    }
    if (!standardResult.data) app.log.warn({ err: standardResult.error, symbol }, '读取普通委托失败，返回条件委托')
    if (!algoResult.data) app.log.warn({ err: algoResult.error, symbol }, '读取条件委托失败，返回普通委托')
    const orders = standardResult.data ?? []
    const algoOrders = algoResult.data ?? []
    const normalizedAlgoOrders = algoOrders.map((order) => ({
      orderId: order.algoId,
      symbol: order.symbol,
      side: order.side,
      type: order.orderType ?? order.type,
      positionSide: order.positionSide,
      closePosition: order.closePosition,
      price: order.price ?? '0',
      stopPrice: order.triggerPrice ?? order.stopPrice ?? '0',
      origQty: order.quantity ?? order.origQty ?? order.baseQty ?? '0',
      executedQty: order.executedQty ?? '0',
      status: order.algoStatus ?? order.status ?? 'NEW',
      time: order.createTime ?? order.time ?? 0,
      updateTime: order.updateTime ?? order.createTime ?? order.time ?? 0,
      isAlgoOrder: true,
    }))
    return [...orders, ...normalizedAlgoOrders]
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

app.get<{ Querystring: { symbol?: string; limit?: string; fromId?: string } }>('/api/account/trades', async (request, reply) => {
  const symbol = request.query.symbol?.toUpperCase()
  const limit = Math.min(Math.max(Number(request.query.limit ?? 100), 1), 1000)
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) return reply.code(400).send({ error: '请提供有效的交易对' })
  if (!Number.isInteger(limit)) return reply.code(400).send({ error: 'limit 必须是 1 到 1000 的整数' })
  try {
    return await binanceRequest('GET', '/fapi/v1/userTrades', { symbol, limit, fromId: request.query.fromId }, true)
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : '读取成交记录失败' })
  }
})

app.post<{ Body: { symbol?: string; positionSide?: string; quantity?: string } }>('/api/account/close-position', async (request, reply) => {
  if (!tradingEnabled) return reply.code(403).send({ error: '平仓功能已关闭，请先启用实盘交易安全开关' })
  const symbol = request.body?.symbol?.toUpperCase()
  const positionSide = request.body?.positionSide
  const quantity = request.body?.quantity
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) return reply.code(400).send({ error: '请提供有效的交易对' })
  if (!['BOTH', 'LONG', 'SHORT'].includes(positionSide ?? '')) return reply.code(400).send({ error: '请提供有效的持仓方向' })
  if (quantity !== undefined && (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0)) return reply.code(400).send({ error: '平仓数量必须大于 0' })
  try {
    const positions = await binanceRequest<Array<{ symbol: string; positionAmt: string; positionSide: string; markPrice: string }>>('GET', '/fapi/v3/positionRisk', { symbol }, true)
    const position = positions.find((row) => row.symbol === symbol && row.positionSide === positionSide)
    const currentAmount = Number(position?.positionAmt)
    if (!position || !Number.isFinite(currentAmount) || currentAmount === 0) return reply.code(400).send({ error: '该方向当前没有可平仓位' })
    const closeQuantity = quantity === undefined ? Math.abs(currentAmount) : Number(quantity)
    if (closeQuantity > Math.abs(currentAmount)) return reply.code(400).send({ error: '平仓数量不能大于当前持仓数量' })
    const info = await binanceRequest<{ symbols: Array<{ symbol: string; filters: Array<{ filterType: string; minQty?: string; maxQty?: string; stepSize?: string; notional?: string; minNotional?: string; maxNotional?: string }> }> }>('GET', '/fapi/v1/exchangeInfo')
    const filters = info.symbols.find((item) => item.symbol === symbol)?.filters ?? []
    const quantityText = quantity === undefined ? String(Math.abs(currentAmount)) : quantity
    // A market close uses MARKET_LOT_SIZE when Binance provides it. Checking
    // both filters can reject a valid close if the two step sizes differ.
    const quantityFilter = filters.find((item) => item.filterType === 'MARKET_LOT_SIZE') ?? filters.find((item) => item.filterType === 'LOT_SIZE')
    if (quantityFilter) {
      const filter = quantityFilter
      if (filter.minQty && Number(filter.minQty) > 0 && closeQuantity < Number(filter.minQty)) return reply.code(400).send({ error: `平仓数量低于 Binance 最小值 (${filter.minQty})` })
      if (filter.maxQty && Number(filter.maxQty) > 0 && closeQuantity > Number(filter.maxQty)) return reply.code(400).send({ error: `平仓数量超过 Binance 最大值 (${filter.maxQty})` })
      if (filter.stepSize && Number(filter.stepSize) > 0 && !isStepAligned(quantityText, filter.stepSize)) return reply.code(400).send({ error: `平仓数量必须符合 Binance 步长 (${filter.stepSize})` })
    }
    const notionalFilter = filters.find((item) => item.filterType === 'MIN_NOTIONAL' || item.filterType === 'NOTIONAL')
    const minimumNotional = Number(notionalFilter?.notional ?? notionalFilter?.minNotional)
    const maximumNotional = Number(notionalFilter?.maxNotional)
    const markPrice = Number(position.markPrice)
    if (minimumNotional > 0 && Number.isFinite(markPrice) && closeQuantity * markPrice < minimumNotional) return reply.code(400).send({ error: `平仓名义价值低于 Binance 最小值 (${minimumNotional} USDT)` })
    if (maximumNotional > 0 && Number.isFinite(markPrice) && closeQuantity * markPrice > maximumNotional) return reply.code(400).send({ error: `平仓名义价值超过 Binance 最大值 (${maximumNotional} USDT)` })
    const side = currentAmount > 0 ? 'SELL' : 'BUY'
    const params: Record<string, QueryValue> = { symbol, side, type: 'MARKET', quantity: quantityText }
    if (positionSide === 'LONG' || positionSide === 'SHORT') params.positionSide = positionSide
    else params.reduceOnly = true
    return await binanceRequest('POST', '/fapi/v1/order', params, true)
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '平仓失败' })
  }
})

app.post<{ Body: { symbol?: string; positionSide?: string; side?: string; stopLoss?: string; takeProfit?: string; workingType?: string } }>('/api/account/position-tpsl', async (request, reply) => {
  if (!tradingEnabled) return reply.code(403).send({ error: '止盈止损设置已关闭，请先启用交易安全开关' })
  const symbol = request.body?.symbol?.toUpperCase()
  const positionSide = request.body?.positionSide
  const stopLossProvided = typeof request.body?.stopLoss === 'string'
  const takeProfitProvided = typeof request.body?.takeProfit === 'string'
  const stopLoss = typeof request.body?.stopLoss === 'string' ? request.body.stopLoss.trim() || undefined : undefined
  const takeProfit = typeof request.body?.takeProfit === 'string' ? request.body.takeProfit.trim() || undefined : undefined
  const workingType = request.body?.workingType ?? 'CONTRACT_PRICE'
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) return reply.code(400).send({ error: '请提供有效的交易对' })
  if (!['BOTH', 'LONG', 'SHORT'].includes(positionSide ?? '')) return reply.code(400).send({ error: '请提供有效的持仓方向' })
  if (request.body?.side !== undefined && !['BUY', 'SELL'].includes(request.body.side)) return reply.code(400).send({ error: '保护单方向无效' })
  if (!stopLossProvided && !takeProfitProvided) return reply.code(400).send({ error: '请至少提供一个需要更新或清除的保护价格' })
  if ([stopLoss, takeProfit].some((value) => value !== undefined && (!Number.isFinite(Number(value)) || Number(value) <= 0))) return reply.code(400).send({ error: '止盈止损价格必须大于 0' })
  if (!['MARK_PRICE', 'CONTRACT_PRICE'].includes(workingType)) return reply.code(400).send({ error: '触发参考价格无效' })
  const lockKey = `${symbol}:${positionSide}`
  const previousLock = protectionLocks.get(lockKey) ?? Promise.resolve()
  let releaseLock!: () => void
  const currentLock = new Promise<void>((resolve) => { releaseLock = resolve })
  protectionLocks.set(lockKey, currentLock)
  await previousLock
  try {
    const positions = await binanceRequest<Array<{ symbol: string; positionAmt: string; positionSide: string; markPrice: string }>>('GET', '/fapi/v3/positionRisk', { symbol }, true)
    const position = positions.find((row) => row.symbol === symbol && row.positionSide === positionSide && Number.isFinite(Number(row.positionAmt)) && Number(row.positionAmt) !== 0)
    const amount = Number(position?.positionAmt)
    if (!position && !request.body?.side) return reply.code(400).send({ error: '没有持仓时需要提供保护单方向' })
    const direction = protectionOrderDirection(positionSide!, position ? amount : null, request.body?.side as 'BUY' | 'SELL' | undefined)
    if (!direction) return reply.code(400).send({ error: position ? '保护单方向与当前持仓方向不匹配' : '保护单方向与持仓模式不匹配' })
    const { side, isLong } = direction
    const info = await binanceRequest<{ symbols: Array<{ symbol: string; filters: Array<{ filterType: string; tickSize?: string; minPrice?: string; maxPrice?: string }> }> }>('GET', '/fapi/v1/exchangeInfo')
    const priceFilter = info.symbols.find((item) => item.symbol === symbol)?.filters.find((item) => item.filterType === 'PRICE_FILTER')
    for (const value of [stopLoss, takeProfit]) {
      if (!value) continue
      const price = Number(value)
      if (priceFilter?.minPrice && Number(priceFilter.minPrice) > 0 && price < Number(priceFilter.minPrice)) return reply.code(400).send({ error: `价格低于 Binance 最小值 (${priceFilter.minPrice})` })
      if (priceFilter?.maxPrice && Number(priceFilter.maxPrice) > 0 && price > Number(priceFilter.maxPrice)) return reply.code(400).send({ error: `价格超过 Binance 最大值 (${priceFilter.maxPrice})` })
      if (priceFilter?.tickSize && Number(priceFilter.tickSize) > 0 && !isStepAligned(value, priceFilter.tickSize)) return reply.code(400).send({ error: `价格必须符合 Binance 最小变动单位 (${priceFilter.tickSize})` })
    }
    const referencePrice = workingType === 'MARK_PRICE'
      ? Number(position?.markPrice ?? (await binanceRequest<{ markPrice: string }>('GET', '/fapi/v1/premiumIndex', { symbol })).markPrice)
      : Number((await binanceRequest<{ price: string }>('GET', '/fapi/v1/ticker/price', { symbol })).price)
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) return reply.code(502).send({ error: '无法读取当前触发参考价格，请稍后重试' })
    if (stopLoss && (isLong ? Number(stopLoss) >= referencePrice : Number(stopLoss) <= referencePrice)) return reply.code(400).send({ error: isLong ? `多仓止损价必须低于${workingType === 'MARK_PRICE' ? '标记' : '最新'}价格 (${referencePrice})` : `空仓止损价必须高于${workingType === 'MARK_PRICE' ? '标记' : '最新'}价格 (${referencePrice})` })
    if (takeProfit && (isLong ? Number(takeProfit) <= referencePrice : Number(takeProfit) >= referencePrice)) return reply.code(400).send({ error: isLong ? `多仓止盈价必须高于${workingType === 'MARK_PRICE' ? '标记' : '最新'}价格 (${referencePrice})` : `空仓止盈价必须低于${workingType === 'MARK_PRICE' ? '标记' : '最新'}价格 (${referencePrice})` })
    const [standardOrders, algoOrders] = await Promise.all([
      binanceRequest<Array<Record<string, unknown>>>('GET', '/fapi/v1/openOrders', { symbol }, true),
      binanceRequest<Array<Record<string, unknown>>>('GET', '/fapi/v1/openAlgoOrders', { symbol }, true),
    ])
    const existingOrders = [...standardOrders, ...algoOrders.map((order) => ({ ...order, orderId: order.algoId, type: order.orderType ?? order.type, stopPrice: order.triggerPrice ?? order.stopPrice, isAlgoOrder: true }))] as Array<{ orderId: number; symbol: string; type: string; side: string; positionSide?: string; closePosition?: boolean | string; stopPrice?: string | number; workingType?: string; isAlgoOrder?: boolean }>
    const protectSide = side
    const matchingProtectionOrders = existingOrders.filter((order) => order.symbol === symbol && order.side === protectSide && ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(order.type) && (order.closePosition === true || order.closePosition === 'true') && (order.positionSide ?? 'BOTH') === positionSide)
    const snapshotProtectionOrder = (order: (typeof matchingProtectionOrders)[number]): ProtectionOrderSnapshot<typeof order> => {
      if (order.type !== 'STOP_MARKET' && order.type !== 'TAKE_PROFIT_MARKET') throw new Error('保护单类型无效')
      if (order.stopPrice === undefined || !Number.isFinite(Number(order.stopPrice)) || Number(order.stopPrice) <= 0) throw new Error('读取到缺少有效触发价格的旧保护单，已停止更新')
      return {
        order,
        value: {
          kind: order.type as ProtectionOrderKind,
          triggerPrice: String(order.stopPrice),
          workingType: order.workingType === 'MARK_PRICE' ? 'MARK_PRICE' : 'CONTRACT_PRICE',
        },
      }
    }
    const previous = matchingProtectionOrders.map(snapshotProtectionOrder)
    const previousStop = previous.find(({ value }) => value.kind === 'STOP_MARKET')?.value
    const previousTarget = previous.find(({ value }) => value.kind === 'TAKE_PROFIT_MARKET')?.value
    const replacementValues: Array<ProtectionOrderValue | undefined> = [
      stopLossProvided ? stopLoss ? { kind: 'STOP_MARKET', triggerPrice: stopLoss, workingType } : undefined : previousStop,
      takeProfitProvided ? takeProfit ? { kind: 'TAKE_PROFIT_MARKET', triggerPrice: takeProfit, workingType } : undefined : previousTarget,
    ]
    // Binance rejects another closePosition conditional order while any order in
    // the same direction is open (-4130). Replace the complete protection set.
    const placeProtection = async ({ kind, triggerPrice, workingType: orderWorkingType }: ProtectionOrderValue) => {
      const algoParams: Record<string, QueryValue> = { algoType: 'CONDITIONAL', symbol, side, type: kind, triggerPrice, closePosition: true, workingType: orderWorkingType }
      if (positionSide === 'LONG' || positionSide === 'SHORT') algoParams.positionSide = positionSide
      const result = await binanceRequest<{ algoId: number }>('POST', '/fapi/v1/algoOrder', algoParams, true)
      return { orderId: result.algoId }
    }
    const waitForProtectionCancellation = async () => {
      if (!matchingProtectionOrders.length) return
      const oldStandardIds = new Set(matchingProtectionOrders.filter((order) => !order.isAlgoOrder).map((order) => String(order.orderId)))
      const oldAlgoIds = new Set(matchingProtectionOrders.filter((order) => order.isAlgoOrder).map((order) => String(order.orderId)))
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const [currentStandard, currentAlgo] = await Promise.all([
          binanceRequest<Array<Record<string, unknown>>>('GET', '/fapi/v1/openOrders', { symbol }, true),
          binanceRequest<Array<Record<string, unknown>>>('GET', '/fapi/v1/openAlgoOrders', { symbol }, true),
        ])
        const standardStillOpen = currentStandard.some((order) => oldStandardIds.has(String(order.orderId)))
        const algoStillOpen = currentAlgo.some((order) => oldAlgoIds.has(String(order.algoId)))
        if (!standardStillOpen && !algoStillOpen) return
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      throw new Error('Binance 保护单撤销尚未生效，请稍后重试')
    }
    return await replaceProtectionOrderSet({
      previous,
      replacements: replacementValues.filter((value): value is ProtectionOrderValue => value !== undefined),
      cancel: (order) => binanceRequest('DELETE', order.isAlgoOrder ? '/fapi/v1/algoOrder' : '/fapi/v1/order', order.isAlgoOrder ? { symbol, algoId: order.orderId } : { symbol, orderId: order.orderId }, true),
      afterCancel: waitForProtectionCancellation,
      place: placeProtection,
      remove: (order) => binanceRequest('DELETE', '/fapi/v1/algoOrder', { symbol, algoId: order.orderId }, true),
      restore: placeProtection,
    })
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '设置止盈止损失败' })
  } finally {
    releaseLock()
    if (protectionLocks.get(lockKey) === currentLock) protectionLocks.delete(lockKey)
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
    const info = await binanceRequest<{ symbols: Array<{ symbol: string; filters: Array<{ filterType: string; minQty?: string; maxQty?: string; stepSize?: string; tickSize?: string; minPrice?: string; maxPrice?: string; notional?: string; minNotional?: string; maxNotional?: string }> }> }>('GET', '/fapi/v1/exchangeInfo')
    const marketSymbol = info.symbols.find((item) => item.symbol === body.symbol.toUpperCase())
    if (!marketSymbol) return reply.code(400).send({ error: '该交易对不支持 Binance USDⓈ-M Futures' })
    const filter = (type: string) => marketSymbol.filters.find((item) => item.filterType === type)
    // Binance applies MARKET_LOT_SIZE to market and market-triggered orders;
    // using both filters can reject a valid market quantity when their steps
    // differ. Limit orders use LOT_SIZE.
    const quantityFilter = body.closePosition ? undefined : filter(isMarketExecution(body.type) ? 'MARKET_LOT_SIZE' : 'LOT_SIZE') ?? filter('LOT_SIZE')
    const qtyFilters = quantityFilter ? [quantityFilter] : []
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
    const maximumNotional = Number(notionalFilter?.maxNotional)
    if (quantity !== undefined && (minimumNotional > 0 || maximumNotional > 0)) {
      let referencePrice = Number(body.price ?? body.stopPrice)
      if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
        const ticker = await binanceRequest<{ price: string }>('GET', '/fapi/v1/ticker/price', { symbol: body.symbol.toUpperCase() })
        referencePrice = Number(ticker.price)
      }
      if (Number.isFinite(referencePrice) && referencePrice > 0) {
        const notional = quantity * referencePrice
        if (notional < minimumNotional) return reply.code(400).send({ error: `订单名义价值低于 Binance 最小值 (${minimumNotional} USDT)` })
        if (maximumNotional > 0 && notional > maximumNotional) return reply.code(400).send({ error: `订单名义价值超过 Binance 最大值 (${maximumNotional} USDT)` })
      }
    }
    const params = toBinanceOrderParams(body) as Record<string, QueryValue>
    if (requiresAlgoEndpoint(body.type)) {
      const algoParams: Record<string, QueryValue> = {
        algoType: 'CONDITIONAL', symbol: body.symbol.toUpperCase(), side: body.side, type: body.type,
        quantity: params.quantity as string | undefined, price: params.price as string | undefined,
        timeInForce: params.timeInForce as string | undefined,
        triggerPrice: params.stopPrice as string | undefined,
        reduceOnly: params.reduceOnly as boolean | undefined,
        closePosition: params.closePosition as boolean | undefined,
        positionSide: body.positionSide === 'BOTH' ? undefined : body.positionSide,
        workingType: params.workingType as string | undefined,
        priceProtect: params.priceProtect as boolean | undefined,
        activationPrice: params.activationPrice as string | undefined,
        callbackRate: params.callbackRate as string | undefined,
      }
      return await binanceRequest('POST', '/fapi/v1/algoOrder', algoParams, true)
    }
    return await binanceRequest('POST', '/fapi/v1/order', params, true)
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '订单被拒绝' })
  }
})

type ExplanationPredictionContext = {
  model?: string
  version?: string
  direction?: 'UP' | 'DOWN' | 'NEUTRAL' | string
  probabilityUp?: number
  probabilityDown?: number
  probabilityNeutral?: number
  confidence?: number
  horizonBars?: number
  dataThrough?: number
  generatedAt?: number
  validation?: { accuracy?: number; brier?: number; coverage?: number; testSamples?: number }
}
type ExplanationContext = {
  symbol: string
  interval: string
  price: number | null
  prediction?: ExplanationPredictionContext | null
  candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>
  indicators?: Record<string, unknown>
  manualLines?: Array<{ label: string; price: number }>
  trends?: Array<{ id: number; start: { time: number; price: number }; end: { time: number; price: number } }>
}

app.post<{ Body: { question?: string; context?: ExplanationContext } }>('/api/assistant', async (request, reply) => {
  if (!aiModel || !aiBaseUrl) return reply.code(503).send({ error: '本地服务器尚未配置 OpenAI 兼容 AI 服务。' })
  const context = request.body.context
  if (!context?.prediction) return { answer: '当前还没有可解释的模型预测，请等待最新已收盘 K 线和预测结果。' }
  const question = request.body?.question?.trim() || '请自动解释当前模型预测的方向、上涨下跌中性概率、主要数据依据、风险和失效条件。只解释当前上下文，不生成交易指令。'
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (aiKey) headers.Authorization = `Bearer ${aiKey}`
    const requestBody = {
      model: aiModel,
      messages: [
        { role: 'system', content: '你是 KEEL 的自动 AI 解释层，服务于 Binance USDⓈ-M Futures K 线预测。你不是独立预测器，也不是下单顾问；只能解释上下文中本地通用模型给出的方向、概率、置信度、预测周期、验证指标和近期已收盘 K 线。上涨、下跌、中性概率已经由数值模型计算并在界面单独显示；不要重复这些数字、不要改写或计算概率。绝对不要补造数据、声称保证正确率、生成买卖指令、入场价、止盈止损、杠杆或仓位。只使用本次上下文，不声称拿到了未提供的实时行情。验证准确率偏低、样本不足、输入数据不足、模型过期或概率接近时，应明确说明模型表现/证据有限并指出不确定性，不要隐藏或夸大预测。用简短中文纯文本回答，固定包含四段：预测解读、数据依据、风险与失效条件、解释边界。方向为 NEUTRAL 时解释为信号不明确；禁止给出交易建议。所有内容仅用于理解模型，不构成投资建议，也不会自动下单。不要使用 Markdown、星号、井号、反引号、项目符号或代码围栏。' },
        { role: 'user', content: `当前上下文：${JSON.stringify(context)}\n\n问题：${question}` },
      ],
      temperature: 0.4,
      max_tokens: aiMaxTokens,
    }
    let response = await fetch(aiChatUrl, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(aiTimeoutMs),
      body: JSON.stringify(requestBody),
    })
    let payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
    // Newer OpenAI-compatible gateways renamed max_tokens. Retry only for that
    // specific validation error so ordinary provider errors are not duplicated.
    if (!response.ok && response.status === 400 && /max[_ ]tokens|unsupported parameter/i.test(payload.error?.message ?? '')) {
      const compatibilityBody = { ...requestBody, max_tokens: undefined, max_completion_tokens: aiMaxTokens }
      response = await fetch(aiChatUrl, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(aiTimeoutMs),
        body: JSON.stringify(compatibilityBody),
      })
      payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
    }
    if (!response.ok) return reply.code(502).send({ error: payload.error?.message ?? 'AI 服务请求失败' })
    return { answer: payload.choices?.[0]?.message?.content ?? '' }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return reply.code(504).send({ error: `AI 服务响应超时（${Math.round(aiTimeoutMs / 1000)} 秒），请稍后重试或检查模型服务。` })
    }
    return reply.code(502).send({ error: error instanceof Error ? error.message : '无法连接 AI 服务' })
  }
})

app.delete<{ Querystring: { symbol?: string; orderId?: string; algoId?: string } }>('/api/order', async (request, reply) => {
  if (!tradingEnabled) return reply.code(403).send({ error: '本地服务器已关闭实盘交易。' })
  if (!request.query.symbol || (!request.query.orderId && !request.query.algoId)) return reply.code(400).send({ error: 'symbol 和订单编号为必填项' })
  const symbol = request.query.symbol.toUpperCase()
  if (!/^[A-Z0-9]{3,20}$/.test(symbol) || (request.query.orderId && !/^\d+$/.test(request.query.orderId)) || (request.query.algoId && !/^\d+$/.test(request.query.algoId))) return reply.code(400).send({ error: 'symbol 或订单编号格式无效' })
  try {
    if (request.query.algoId) return await binanceRequest('DELETE', '/fapi/v1/algoOrder', { symbol, algoId: request.query.algoId }, true)
    return await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId: request.query.orderId }, true)
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '撤单被拒绝' })
  }
})

app.listen({ port: Number(process.env.PORT ?? 8788), host: '127.0.0.1' }).catch((error) => {
  app.log.error(error)
  process.exit(1)
})

