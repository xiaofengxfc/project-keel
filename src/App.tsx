import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import './training.css'
import LiveChart from './LiveChart'
import type { BinanceSymbolCatalogItem } from './binanceSymbols'
import { isMarketExecution, isPriceOrder, isTriggeredOrder, requiresAlgoEndpoint, toBinanceOrderParams, validateBinanceOrder, type BinanceOrderInput, type BinanceOrderType } from './binanceOrders'
import { allSymbolLeverageOptions, leverageForBalancePercent, leverageLimitForNotional, maximumLeverageForBrackets, orderSizeAtBalancePercent, partialCloseQuantity, quantityFromAmount, quoteAsset, type LeverageBracket, type OrderAmountUnit } from './binanceTrading'
import { parseWatchlist, reorderWatchlist, WATCHLIST_STORAGE_KEY } from './watchlist'
import { DEFAULT_CHART_INDICATORS, type ChartIndicatorKey, calculateTechnicalIndicators } from './technicalIndicators'
import { parsePrediction, type PredictionResult } from './prediction'

type Candle = { time: number; open: number; high: number; low: number; close: number; volume?: number }
type Tool = 'cursor' | 'horizontal' | 'trend'
type Line = { id: number; price: number; label: string; color: string; deletable?: boolean }
type Trend = { id: number; start: { time: number; price: number }; end: { time: number; price: number } }
type Health = { privateApiConfigured: boolean; tradingEnabled: boolean; aiConfigured: boolean; predictionConfigured: boolean; environment?: string; websocketBaseUrl?: string }
type TrainingMetrics = { accuracy?: number; balancedAccuracy?: number; macroF1?: number; confidenceCoverage?: number; selectiveAccuracy?: number; brier?: number; testSamples?: number }
type TrainingIntervalResult = { status?: string; phase?: string; metrics?: TrainingMetrics; error?: string | null; output?: string; notice?: string }
type TrainingStatus = { jobId?: string; running: boolean; phase?: string; stage?: string; currentInterval?: Interval; currentSymbol?: string; symbolIndex?: number; symbolCount?: number; pagesFetched?: number; rowsFetched?: number; intervals?: Interval[]; completedIntervals?: Interval[]; finishedIntervals?: Interval[]; intervalResults?: Record<string, TrainingIntervalResult>; results?: Record<string, TrainingIntervalResult>; output?: string; error?: string | null; startedAt?: number; finishedAt?: number; interval?: Interval; symbols?: string[]; metrics?: TrainingMetrics }
type ForwardValidationMetricSet = { predictions: number; settled: number; pending: number; accuracy: number | null; balancedAccuracy: number | null; brier: number | null; byClass?: Record<string, { actual: number; recall: number }> }
type ForwardValidationMetrics = ForwardValidationMetricSet & { byModelVersion?: Record<string, ForwardValidationMetricSet> }
type MarketQuote = { price: number; change: number }
type Interval = '15m' | '1h' | '4h' | '1d'
type MarketTransport = 'connecting' | 'websocket' | 'rest' | 'offline'
type WorkspaceView = 'markets' | 'training'
type PositionRow = { symbol: string; positionAmt: number; entryPrice: number; markPrice: number; liquidationPrice: number; unrealizedProfit: number; leverage: number; marginType: string; positionSide: string }
type OrderRow = { orderId: number; symbol: string; side: string; type: string; positionSide?: string; closePosition?: boolean | string; isAlgoOrder?: boolean; price: number; stopPrice: number; origQty: number; executedQty: number; status: string; time: number; updateTime: number }
type TradeRow = { id: number; symbol: string; orderId: number; side: 'BUY' | 'SELL'; positionSide: string; price: number; qty: number; time: number }

type SymbolInfo = { symbol: string; name: string; icon: string; color: string }
const chartIndicatorOptions: Array<{ key: ChartIndicatorKey; label: string }> = [
  { key: 'ema20', label: 'EMA 20' }, { key: 'ema50', label: 'EMA 50' }, { key: 'sma200', label: 'SMA 200' },
  { key: 'bollinger', label: '布林带' }, { key: 'vwap', label: 'VWAP' }, { key: 'volume', label: '成交量' },
  { key: 'rsi', label: 'RSI' }, { key: 'macd', label: 'MACD' }, { key: 'stochastic', label: '随机指标' },
  { key: 'atr', label: 'ATR' }, { key: 'adx', label: 'ADX' }, { key: 'obv', label: 'OBV' },
]
const modelTrainingIntervals: Array<{ value: Interval; label: string; horizon: string }> = [
  { value: '15m', label: '15 分钟', horizon: '45 分钟' },
  { value: '1h', label: '1 小时', horizon: '3 小时' },
  { value: '4h', label: '4 小时', horizon: '12 小时' },
  { value: '1d', label: '1 天', horizon: '3 天' },
]
const orderTypeOptions: Array<{ value: BinanceOrderType; label: string }> = [
  { value: 'LIMIT', label: '限价单' }, { value: 'MARKET', label: '市价单' },
  { value: 'STOP_MARKET', label: '止损市价' }, { value: 'TAKE_PROFIT_MARKET', label: '止盈市价' },
  { value: 'STOP', label: '止损限价' }, { value: 'TAKE_PROFIT', label: '止盈限价' }, { value: 'TRAILING_STOP_MARKET', label: '追踪止损' },
]
const workingTypeOptions: Array<{ value: 'MARK_PRICE' | 'CONTRACT_PRICE'; label: string }> = [{ value: 'CONTRACT_PRICE', label: '最新价格' }, { value: 'MARK_PRICE', label: '标记价格' }]

const defaultLines: Line[] = []
const defaultTrends: Trend[] = []
function formatPrice(value: number | null) {
  return value === null || !Number.isFinite(value) ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: value > 100 ? 2 : 5 })
}

const KLINE_PAGE_SIZE = 1000
const KLINE_REFRESH_MS: Record<Interval, number> = { '15m': 5_000, '1h': 8_000, '4h': 15_000, '1d': 15_000 }
// Binance can keep a stream open briefly without sending the selected kline
// event. Use a longer watchdog and only reconnect when the selected kline
// stream itself has gone stale.
const KLINE_WATCHDOG_MS = 45_000
const WEBSOCKET_CONNECT_TIMEOUT_MS = 12_000
const WEBSOCKET_RECONNECT_COOLDOWN_MS = 120_000
const MAX_AI_DISPLAY_CHARACTERS = 4500
const klineCache = new Map<string, { rows: unknown[][]; fetchedAt: number }>()
const klineRequests = new Map<string, Promise<unknown[][]>>()

function cleanAiText(value: string) {
  return value.replace(/```[\s\S]*?```/g, '').replace(/^\s*[#*>`]+\s?/gm, '').replace(/\*+/g, '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function limitAiText(value: string) {
  const characters = Array.from(value)
  if (characters.length <= MAX_AI_DISPLAY_CHARACTERS) return value
  return `${characters.slice(0, MAX_AI_DISPLAY_CHARACTERS).join('').trimEnd()}\n\n（回复较长，已截取前 ${MAX_AI_DISPLAY_CHARACTERS} 个字符）`
}

function aiErrorText(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  if (/abort|timeout|timed out/i.test(message)) return 'AI 服务响应超时，请稍后重试。'
  return message || '请求失败，请检查 OpenAI 兼容接口配置。'
}

async function requestKlines(symbol: string, interval: Interval, endTime?: number, limit = KLINE_PAGE_SIZE, forceRefresh = false) {
  const cacheKey = `${symbol}:${interval}:${endTime ?? 'latest'}:${limit}`
  const cached = klineCache.get(cacheKey)
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < 90_000) return cached.rows
  const pending = klineRequests.get(cacheKey)
  if (pending) return pending
  const params = new URLSearchParams({ symbol, interval, limit: String(Math.min(Math.max(limit, 1), KLINE_PAGE_SIZE)) })
  if (endTime !== undefined) params.set('endTime', String(endTime))
  const query = params.toString()
  const request = (async () => {
    const response = await fetch(`/api/market/klines?${query}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Binance 行情请求失败：${response.status}`)
    const rows = await response.json() as unknown
    if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row) || row.length < 6)) throw new Error('Binance K 线数据格式无效')
    return rows as unknown[][]
  })()
  klineRequests.set(cacheKey, request)
  try {
    const rows = await request
    klineCache.set(cacheKey, { rows, fetchedAt: Date.now() })
    return rows
  } finally {
    klineRequests.delete(cacheKey)
  }
}

function parseKlines(rows: unknown[][]): Candle[] {
  return rows.map((row) => {
    const time = Number(row[0]) / 1000
    const open = Number(row[1])
    const high = Number(row[2])
    const low = Number(row[3])
    const close = Number(row[4])
    const volume = Number(row[5])
    return { time, open, high, low, close, volume }
  }).filter((candle) => Number.isFinite(candle.time) && candle.time > 0 && [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0) && candle.high >= Math.max(candle.open, candle.close, candle.low) && candle.low <= Math.min(candle.open, candle.close, candle.high))
}

function symbolVisual(baseAsset: string): Pick<SymbolInfo, 'icon' | 'color'> {
  const palette = ['#627eea', '#8b5cf6', '#e8b923', '#15976c', '#e07070', '#2387c8', '#8a6d3b']
  const hash = [...baseAsset].reduce((sum, character) => sum + character.charCodeAt(0), 0)
  return { icon: baseAsset.slice(0, 1) || '◆', color: palette[hash % palette.length] }
}

type MarketListProps = {
  symbols: SymbolInfo[]
  availableSymbols: SymbolInfo[]
  favoriteSymbols: string[]
  active: string
  quotes: Record<string, MarketQuote>
  search: string
  loading: boolean
  error: string
  mobileOpen: boolean
  view: WorkspaceView
  onCloseMobile: () => void
  onSearchChange: (value: string) => void
  onSelect: (symbol: string) => void
  onToggleFavorite: (symbol: string) => void
  onMoveFavorite: (symbol: string, offset: -1 | 1) => void
  onReorder: (from: string, over: string) => void
  onOpenTraining: () => void
  onOpenMarkets: () => void
}

function MarketList({ symbols, availableSymbols, favoriteSymbols, active, quotes, search, loading, error, mobileOpen, view, onCloseMobile, onSearchChange, onSelect, onToggleFavorite, onMoveFavorite, onReorder, onOpenTraining, onOpenMarkets }: MarketListProps) {
  const dragRef = useRef<{ from: string; over: string } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const showFavorites = search.trim().length === 0
  const stopDrag = () => {
    const drag = dragRef.current
    if (drag && drag.from !== drag.over) onReorder(drag.from, drag.over)
    dragRef.current = null
    setDragging(null)
  }
  const handleDragStart = (event: React.PointerEvent<HTMLButtonElement>, symbol: string) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { from: symbol, over: symbol }
    setDragging(symbol)
  }
  const handleDragMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return
    const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-watch-symbol]')
    const over = element?.dataset.watchSymbol
    if (over && favoriteSymbols.includes(over)) dragRef.current.over = over
  }
  const filteredRows = loading && !symbols.length
    ? <div className="watch-empty">正在读取 Binance 交易对…</div>
    : error && !symbols.length
      ? <div className="watch-empty">{error}</div>
      : symbols.length
        ? symbols.map((item) => {
          const favorite = favoriteSymbols.includes(item.symbol)
          const available = availableSymbols.some((symbol) => symbol.symbol === item.symbol)
          const quote = quotes[item.symbol]
          const orderIndex = favoriteSymbols.indexOf(item.symbol)
          return <div key={item.symbol} data-watch-symbol={item.symbol} className={`watch-item ${active === item.symbol ? 'active' : ''} ${dragging === item.symbol ? 'dragging' : ''} ${!available ? 'watch-unavailable' : ''}`}>
            {showFavorites && <button type="button" className="watch-drag-handle" aria-label={`拖动排序 ${item.symbol}`} title="按住拖动排序" onPointerDown={(event) => handleDragStart(event, item.symbol)} onPointerMove={handleDragMove} onPointerUp={stopDrag} onPointerCancel={stopDrag}>⠿</button>}
            <button type="button" className="watch-item-main" disabled={!available} onClick={() => { if (available) onSelect(item.symbol) }}>
              <span className="coin-icon" style={{ background: item.color }}>{item.icon}</span>
              <span className="coin-name"><b>{item.symbol.replace('USDT', '')}<small>/USDT</small></b><small>{available ? item.name : '当前 Binance 环境中不可用'}</small></span>
              <span className="coin-price">{formatPrice(quote?.price ?? null)}<small className={quote && quote.change < 0 ? 'down' : 'up'}>{quote ? `${quote.change >= 0 ? '+' : ''}${quote.change.toFixed(2)}%` : '—'}</small></span>
            </button>
            {showFavorites && <div className="watch-order-actions"><button type="button" aria-label={`将 ${item.symbol} 上移`} disabled={orderIndex <= 0} onClick={() => onMoveFavorite(item.symbol, -1)}>↑</button><button type="button" aria-label={`将 ${item.symbol} 下移`} disabled={orderIndex < 0 || orderIndex >= favoriteSymbols.length - 1} onClick={() => onMoveFavorite(item.symbol, 1)}>↓</button></div>}
            <button type="button" className={`watch-favorite ${favorite ? 'is-favorite' : ''}`} aria-label={favorite ? `取消收藏 ${item.symbol}` : `收藏 ${item.symbol}`} aria-pressed={favorite} onClick={() => onToggleFavorite(item.symbol)}>{favorite ? '★' : '☆'}</button>
          </div>
        })
        : <div className="watch-empty">{showFavorites ? '暂无自选币种。搜索 Binance 交易对并点 ☆ 收藏。' : '没有匹配的 Binance USDT 永续合约'}</div>

  return <>
    {mobileOpen && <button type="button" className="mobile-market-backdrop" aria-label="关闭自选列表" onClick={onCloseMobile} />}
    <aside className={`watchlist panel ${mobileOpen ? 'mobile-markets-open' : ''}`}>
      <div className="panel-head"><div><span className="eyebrow">MARKETS</span><h2>自选行情</h2></div><button type="button" className="market-close" aria-label="关闭行情列表" onClick={onCloseMobile}>×</button></div>
      <div className="workspace-nav" aria-label="工作区导航">
        <button type="button" className={view === 'markets' ? 'active' : ''} onClick={onOpenMarkets}>⌁ <span>行情与交易</span></button>
        <button type="button" className={view === 'training' ? 'active' : ''} onClick={onOpenTraining}>◈ <span>模型训练</span></button>
      </div>
      <div className="search">⌕ <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="搜索 Binance USDT 永续" aria-label="搜索 Binance USDT 永续交易对" autoFocus={mobileOpen} /></div>
      {showFavorites && favoriteSymbols.length > 1 && <small className="watch-sort-hint">按住 ⠿ 拖动排序，也可用箭头调整</small>}
      <div className="watch-items">{filteredRows}</div>
      <div className="watch-footer"><span>{showFavorites ? '搜索并收藏币种' : '仅显示可交易 USDT 永续'}</span><b>USⓈ-M Futures</b></div>
    </aside>
  </>
}

function App() {
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('markets')
  const [watchlist, setWatchlist] = useState<string[]>(() => parseWatchlist(localStorage.getItem(WATCHLIST_STORAGE_KEY)))
  const watchlistRef = useRef(watchlist)
  const [active, setActive] = useState(() => parseWatchlist(localStorage.getItem(WATCHLIST_STORAGE_KEY))[0] ?? '')
  const [availableSymbols, setAvailableSymbols] = useState<SymbolInfo[]>([])
  const [symbolCatalogLoading, setSymbolCatalogLoading] = useState(true)
  const [symbolCatalogError, setSymbolCatalogError] = useState('')
  const [price, setPrice] = useState<number | null>(null)
  const [change, setChange] = useState<number | null>(null)
  const [marketQuotes, setMarketQuotes] = useState<Record<string, MarketQuote>>({})
  const [candles, setCandles] = useState<Candle[]>([])
  const [interval, setInterval] = useState<Interval>('1h')
  const [autoTimeframe, setAutoTimeframe] = useState(false)
  const [hasOlderCandles, setHasOlderCandles] = useState(true)
  const [loadingOlderCandles, setLoadingOlderCandles] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [loadedMarketKey, setLoadedMarketKey] = useState('')
  const [marketTransport, setMarketTransport] = useState<MarketTransport>('connecting')
  const [loading, setLoading] = useState(false)
  const [tool, setTool] = useState<Tool>('cursor')
  const [indicatorsOpen, setIndicatorsOpen] = useState(false)
  const [chartIndicators, setChartIndicators] = useState<Record<ChartIndicatorKey, boolean>>(() => {
    try { return { ...DEFAULT_CHART_INDICATORS, ...(JSON.parse(localStorage.getItem('keel-chart-indicators') ?? '{}') as Partial<Record<ChartIndicatorKey, boolean>>) } } catch { return DEFAULT_CHART_INDICATORS }
  })
  const levelLabel = '支撑位'
  const [storedLines, setStoredLines] = useState<Record<string, Line[]>>(() => {
    try { return JSON.parse(localStorage.getItem('keel-lines') ?? '{}') as Record<string, Line[]> } catch { return {} }
  })
  const [storedTrends, setStoredTrends] = useState<Record<string, Trend[]>>(() => {
    try { return JSON.parse(localStorage.getItem('keel-trends') ?? '{}') as Record<string, Trend[]> } catch { return {} }
  })
  const [tab, setTab] = useState<'order' | 'ai'>('order')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [qty, setQty] = useState('0.01')
  const [amountUnit, setAmountUnit] = useState<OrderAmountUnit>('asset')
  const [orderPercent, setOrderPercent] = useState(0)
  const [orderType, setOrderType] = useState<BinanceOrderType>('LIMIT')
  const [orderPrice, setOrderPrice] = useState<string | null>(null)
  const [stopPrice, setStopPrice] = useState('')
  const [timeInForce, setTimeInForce] = useState<'GTC' | 'IOC' | 'FOK' | 'GTX'>('GTC')
  const [reduceOnly, setReduceOnly] = useState(false)
  const [closePosition, setClosePosition] = useState(false)
  const [positionSide, setPositionSide] = useState<'BOTH' | 'LONG' | 'SHORT'>('BOTH')
  const [hedgeMode, setHedgeMode] = useState(false)
  const [workingType, setWorkingType] = useState<'MARK_PRICE' | 'CONTRACT_PRICE'>('CONTRACT_PRICE')
  const [priceProtect, setPriceProtect] = useState(true)
  const [activationPrice, setActivationPrice] = useState('')
  const [callbackRate, setCallbackRate] = useState('1')
  const [marginType, setMarginType] = useState<'CROSSED' | 'ISOLATED'>('CROSSED')
  const [leverage, setLeverage] = useState('10')
  const [leverageSelections, setLeverageSelections] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('keel-leverage-selections') ?? '{}') as Record<string, number> } catch { return {} }
  })
  const [leverageBrackets, setLeverageBrackets] = useState<LeverageBracket[]>([])
  const [leverageBracketsSymbol, setLeverageBracketsSymbol] = useState('')
  const [leverageBracketsLoading, setLeverageBracketsLoading] = useState(false)
  const [leverageBracketsError, setLeverageBracketsError] = useState('')
  const [leverageBracketsReloadKey, setLeverageBracketsReloadKey] = useState(0)
  const [symbolRules, setSymbolRules] = useState<Record<string, { stepSize: string; minQty: string; marketStepSize?: string; marketMinQty?: string }>>({})
  const [aiBusy, setAiBusy] = useState(false)
  const [aiExplanationRefreshKey, setAiExplanationRefreshKey] = useState(0)
  const aiExplanationRequestKeyRef = useRef('')
  const [symbolSearch, setSymbolSearch] = useState('')
  const [mobileMarketsOpen, setMobileMarketsOpen] = useState(false)
  const [aiExplanation, setAiExplanation] = useState('等待最新模型预测后自动生成解释。')
  const [health, setHealth] = useState<Health>({ privateApiConfigured: false, tradingEnabled: false, aiConfigured: false, predictionConfigured: false })
  const [orderMessage, setOrderMessage] = useState('')
  const [accountBalance, setAccountBalance] = useState<string | null>(null)
  const [bottomTab, setBottomTab] = useState<'positions' | 'openOrders' | 'history' | 'trades'>('positions')
  const [positions, setPositions] = useState<PositionRow[]>([])
  const [openOrders, setOpenOrders] = useState<OrderRow[]>([])
  const [orderHistory, setOrderHistory] = useState<OrderRow[]>([])
  const [trades, setTrades] = useState<TradeRow[]>([])
  const [managePosition, setManagePosition] = useState<PositionRow | null>(null)
  const [manageStopLoss, setManageStopLoss] = useState('')
  const [manageTakeProfit, setManageTakeProfit] = useState('')
  const [manageStopLossChanged, setManageStopLossChanged] = useState(false)
  const [manageTakeProfitChanged, setManageTakeProfitChanged] = useState(false)
  const [manageQuantity, setManageQuantity] = useState('')
  const [manageClosePercent, setManageClosePercent] = useState(0)
  const [manageMessage, setManageMessage] = useState('')
  const [manageBusy, setManageBusy] = useState(false)
  const [protectionMode] = useState<'program' | 'manual'>('manual')
  const [manualStopLoss, setManualStopLoss] = useState('')
  const [manualTakeProfit, setManualTakeProfit] = useState('')
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [ordersError, setOrdersError] = useState('')
  const [cancellingOrderId, setCancellingOrderId] = useState<number | null>(null)
  const [moreActionsOpen, setMoreActionsOpen] = useState(false)
  const [publicIp, setPublicIp] = useState('')
  const [ipLoading, setIpLoading] = useState(false)
  const [ipError, setIpError] = useState('')
  const [privateDataRefreshKey, setPrivateDataRefreshKey] = useState(0)
  const [prediction, setPrediction] = useState<PredictionResult | null>(null)
  const [predictionLoading, setPredictionLoading] = useState(false)
  const [predictionError, setPredictionError] = useState('')
  const predictionRequestKeyRef = useRef('')
  const [trainingIntervals, setTrainingIntervals] = useState<Interval[]>(['1h'])
  const [trainingSymbolCount, setTrainingSymbolCount] = useState('4')
  const [trainingSymbols, setTrainingSymbols] = useState('')
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus>({ running: false })
  const [trainingRequestError, setTrainingRequestError] = useState('')
  const [trainingStatusError, setTrainingStatusError] = useState('')
  const [trainingStopInFlight, setTrainingStopInFlight] = useState(false)
  const trainingStatusRequestInFlightRef = useRef(false)
  const trainingSubmitInFlightRef = useRef(false)
  const trainingProgressRef = useRef<{ jobId: string | null; interval: string | null; rowsFetched: number; pagesFetched: number }>({ jobId: null, interval: null, rowsFetched: 0, pagesFetched: 0 })
  const trainingInterval = trainingIntervals[0] ?? '1h'
  const [forwardMetrics, setForwardMetrics] = useState<ForwardValidationMetrics | null>(null)
  const [forwardMetricsError, setForwardMetricsError] = useState('')
  const [forwardMetricsLoading, setForwardMetricsLoading] = useState(false)
  const historyRequestId = useRef(0)
  const tradingSettingsSymbol = useRef('')
  const tickerMessageAt = useRef<Record<string, number>>({})
  const loadingOlderRef = useRef(false)
  const hasOlderRef = useRef(true)
  const retryAfterRef = useRef(0)
  const lastMarketKeyRef = useRef('')
  const currentMarketKey = `${active}:${interval}`
  const marketAvailable = marketTransport === 'websocket' || marketTransport === 'rest'
  const marketDataIsCurrent = loadedMarketKey === currentMarketKey
  const marketTransportLabel = marketTransport === 'websocket'
    ? '实时行情 · Binance'
    : marketTransport === 'rest'
      ? 'REST 实时补偿 · Binance'
      : marketTransport === 'offline'
        ? '行情暂时断开'
        : '行情连接中'
  const selected = availableSymbols.find((item) => item.symbol === active) ?? { symbol: active, name: '等待选择交易对', icon: '◆', color: '#5f6c7b' }
  const lines = storedLines[active] ?? defaultLines
  const trends = storedTrends[active] ?? defaultTrends
  const filteredSymbols = useMemo(() => {
    const query = symbolSearch.trim().toLowerCase()
    if (!query) return watchlist.map((symbol) => availableSymbols.find((item) => item.symbol === symbol) ?? { symbol, name: '当前 Binance 环境中不可用', ...symbolVisual(symbol.replace(/USDT$/, '')) })
    const symbolQuery = query.replace(/[^a-z0-9]/g, '')
    return availableSymbols.filter((item) => (symbolQuery.length > 0 && item.symbol.toLowerCase().includes(symbolQuery)) || item.name.toLowerCase().includes(query))
  }, [availableSymbols, symbolSearch, watchlist])

  useEffect(() => {
    fetch('/api/health').then((response) => response.ok ? response.json() as Promise<Health> : null).then((value) => value && setHealth(value)).catch(() => undefined)
  }, [])

  useEffect(() => { watchlistRef.current = watchlist }, [watchlist])

  useEffect(() => {
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlist))
  }, [watchlist])

  useEffect(() => {
    let cancelled = false
    const loadSymbolCatalog = async (): Promise<BinanceSymbolCatalogItem[]> => {
      const response = await fetch('/api/market/symbols')
      if (!response.ok) throw new Error('无法读取 Binance 合约列表')
      return await response.json() as BinanceSymbolCatalogItem[]
    }
    void loadSymbolCatalog()
      .then((catalog) => {
        if (cancelled) return
        const symbols = catalog.map(({ symbol, baseAsset }) => ({ symbol, name: baseAsset, ...symbolVisual(baseAsset) }))
        const validSymbols = new Set(symbols.map((item) => item.symbol))
        setAvailableSymbols(symbols)
        setActive((current) => validSymbols.has(current) ? current : watchlistRef.current.find((symbol) => validSymbols.has(symbol)) ?? '')
        setSymbolCatalogError('')
      })
      .catch((error) => { if (!cancelled) setSymbolCatalogError(error instanceof Error ? error.message : '合约列表暂不可用') })
      .finally(() => { if (!cancelled) setSymbolCatalogLoading(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => { localStorage.setItem('keel-chart-indicators', JSON.stringify(chartIndicators)) }, [chartIndicators])
  useEffect(() => { localStorage.setItem('keel-leverage-selections', JSON.stringify(leverageSelections)) }, [leverageSelections])

  const toggleFavorite = (symbol: string) => {
    if (watchlist.includes(symbol)) {
      const next = watchlist.filter((item) => item !== symbol)
      setWatchlist(next)
      if (active === symbol) {
        const nextActive = next.find((item) => availableSymbols.some((available) => available.symbol === item)) ?? ''
        setActive(nextActive)
        if (!nextActive) {
          setPrice(null)
          setChange(null)
          setCandles([])
          setLoadedMarketKey('')
        }
      }
      return
    }
    setWatchlist((current) => current.includes(symbol) ? current : [...current, symbol])
    if (!active) setActive(symbol)
  }

  const moveFavorite = (symbol: string, offset: -1 | 1) => {
    const index = watchlist.indexOf(symbol)
    const destination = index + offset
    if (index < 0 || destination < 0 || destination >= watchlist.length) return
    const next = [...watchlist]
    ;[next[index], next[destination]] = [next[destination], next[index]]
    setWatchlist(next)
  }

  useEffect(() => {
    if (!mobileMarketsOpen) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileMarketsOpen(false) }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [mobileMarketsOpen])


  useEffect(() => {
    if (!active && watchlist.length === 0) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const allowed = new Set([...watchlist, active].filter(Boolean))
    const loadQuotes = async () => {
      const response = await fetch('/api/market/tickers')
      if (!response.ok) throw new Error('公共行情请求失败')
      return await response.json() as Array<{ symbol: string; lastPrice: string; priceChangePercent: string }>
    }
    const refreshQuotes = async () => {
      try {
        const rows = await loadQuotes()
        if (cancelled) return
        const next = rows.filter((row) => allowed.has(row.symbol)).reduce<Record<string, MarketQuote>>((current, row) => {
          const price = Number(row.lastPrice)
          const change = Number(row.priceChangePercent)
          if (Number.isFinite(price) && Number.isFinite(change)) current[row.symbol] = { price, change }
          return current
        }, {})
        setMarketQuotes((current) => ({ ...current, ...next }))
      } catch { /* WebSocket 行情仍可继续更新当前交易对。 */ }
      finally { if (!cancelled) timer = setTimeout(refreshQuotes, 30_000) }
    }
    void refreshQuotes()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [active, watchlist])

  useEffect(() => {
    if (!active) return
    const requestId = ++historyRequestId.current
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    let watchdogTimer: number | undefined
    let refreshInFlight = false
    let socket: WebSocket | null = null
    let reconnectAttempt = 0
    let lastKlineMessageAt = 0
    let socketOpenedAt = 0
    let socketConnectTimer: ReturnType<typeof setTimeout> | undefined
    let reconnectCooldownUntil = 0
    if (lastMarketKeyRef.current !== currentMarketKey) {
      lastMarketKeyRef.current = currentMarketKey
      setLoading(true)
      setPrice(null)
      setChange(null)
      setCandles([])
      setOrderMessage('')
      setLoadedMarketKey('')
      setHasOlderCandles(true)
      setLoadingOlderCandles(false)
      setHistoryError('')
    }
    setMarketTransport('connecting')
    loadingOlderRef.current = false
    hasOlderRef.current = true
    retryAfterRef.current = 0

    const mergeCandles = (incoming: Candle[], replaceExisting = false) => {
      const validIncoming = incoming.filter((candle) => Number.isFinite(candle.time) && candle.time > 0 && [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0) && Number.isFinite(candle.volume ?? 0) && (candle.volume ?? 0) >= 0 && candle.high >= Math.max(candle.open, candle.close, candle.low) && candle.low <= Math.min(candle.open, candle.close, candle.high))
      if (!validIncoming.length || cancelled) return
      setCandles((current) => {
        const merged = new Map(current.map((candle) => [candle.time, candle]))
        validIncoming.forEach((candle) => { if (replaceExisting || !merged.has(candle.time)) merged.set(candle.time, candle) })
        return [...merged.values()].sort((left, right) => left.time - right.time)
      })
    }
    const refreshLatestCandles = async () => {
      if (cancelled || refreshInFlight) return
      // A healthy kline stream already delivers the live candle. Avoid opening
      // a REST request on every refresh tick while the WebSocket is healthy;
      // REST remains the fallback when the stream is still connecting or stale.
      if (socket?.readyState === WebSocket.OPEN && lastKlineMessageAt > 0 && Date.now() - lastKlineMessageAt < KLINE_WATCHDOG_MS) {
        if (refreshTimer) {
          clearTimeout(refreshTimer)
          refreshTimer = undefined
        }
        return
      }
      refreshInFlight = true
      try {
        const rows = await requestKlines(active, interval, undefined, 2, true)
        if (cancelled) return
        mergeCandles(parseKlines(rows), true)
        const streamHealthy = socket?.readyState === WebSocket.OPEN && lastKlineMessageAt > 0 && Date.now() - lastKlineMessageAt < KLINE_WATCHDOG_MS
        if (!streamHealthy) setMarketTransport('rest')
      } catch {
        const streamHealthy = socket?.readyState === WebSocket.OPEN && lastKlineMessageAt > 0 && Date.now() - lastKlineMessageAt < KLINE_WATCHDOG_MS
        if (!cancelled && !streamHealthy) setMarketTransport('offline')
      } finally {
        refreshInFlight = false
        if (!cancelled) {
          if (refreshTimer) clearTimeout(refreshTimer)
          const streamHealthy = socket?.readyState === WebSocket.OPEN && lastKlineMessageAt > 0 && Date.now() - lastKlineMessageAt < KLINE_WATCHDOG_MS
          refreshTimer = streamHealthy ? undefined : setTimeout(refreshLatestCandles, KLINE_REFRESH_MS[interval])
        }
      }
    }
    requestKlines(active, interval)
      .then((rows) => { if (!cancelled) { const parsed = parseKlines(rows); mergeCandles(parsed); hasOlderRef.current = parsed.length === KLINE_PAGE_SIZE; setHasOlderCandles(hasOlderRef.current); setLoadedMarketKey(currentMarketKey) } })
      .catch(() => { if (!cancelled) setCandles([]) })
      .finally(() => { if (!cancelled) setLoading(false) })

      // The watchlist can contain many symbols. Subscribe only to the active
      // ticker and kline; the 30-second ticker snapshot keeps other favorites
      // updated without creating an oversized combined-stream URL.
      const streams = [`${active.toLowerCase()}@ticker`]
    const streamBaseUrl = health.websocketBaseUrl
    const streamUrl = streamBaseUrl ? `${streamBaseUrl}/stream?streams=${[...streams, `${active.toLowerCase()}@kline_${interval}`].join('/')}` : ''
    const connect = () => {
      if (cancelled || !streamUrl) return
      socket = new WebSocket(streamUrl)
      const currentSocket = socket
      if (socketConnectTimer) clearTimeout(socketConnectTimer)
      socketConnectTimer = setTimeout(() => {
        if (cancelled || socket !== currentSocket || currentSocket.readyState !== WebSocket.CONNECTING) return
        setMarketTransport('rest')
        currentSocket.close()
      }, WEBSOCKET_CONNECT_TIMEOUT_MS)
      socket.onopen = () => {
        if (socketConnectTimer) {
          clearTimeout(socketConnectTimer)
          socketConnectTimer = undefined
        }
        socketOpenedAt = Date.now()
        lastKlineMessageAt = 0
        if (!cancelled) setMarketTransport('websocket')
      }
      socket.onmessage = (event) => {
        try {
          const envelope = JSON.parse(event.data) as { data?: { e?: string; s?: string; c?: string; P?: string; k?: { s?: string; i?: string; t: number; o: string; h: string; l: string; c: string; v?: string } }; s?: string; c?: string; P?: string; k?: { s?: string; i?: string; t: number; o: string; h: string; l: string; c: string; v?: string } }
          const data = (envelope.data ?? envelope) as typeof envelope
          if (data.k) {
            // 只接收当前交易对和周期，按开盘时间更新正在形成的K线。
            if (data.k.s?.toUpperCase() !== active || data.k.i !== interval) return
            lastKlineMessageAt = Date.now()
            if (refreshTimer) {
              clearTimeout(refreshTimer)
              refreshTimer = undefined
            }
            reconnectAttempt = 0
            reconnectCooldownUntil = 0
            if (!cancelled) {
              setMarketTransport('websocket')
            }
            mergeCandles([{ time: data.k.t / 1000, open: Number(data.k.o), high: Number(data.k.h), low: Number(data.k.l), close: Number(data.k.c), volume: Number(data.k.v ?? 0) }], true)
            return
          }
          const symbol = data.s?.toUpperCase()
          if (!cancelled && symbol && data.c) {
            tickerMessageAt.current[symbol] = Date.now()
            const quote = { price: Number(data.c), change: data.P ? Number(data.P) : 0 }
            setMarketQuotes((current) => ({ ...current, [symbol]: quote }))
            if (symbol === active) { setPrice(quote.price); setChange(quote.change) }
          }
        } catch { /* 忽略无法解析的行情消息，等待下一条推送。 */ }
      }
      socket.onerror = () => { if (!cancelled && socket === currentSocket) setMarketTransport('rest') }
      socket.onclose = () => {
        if (cancelled || socket !== currentSocket) return
        if (socketConnectTimer) {
          clearTimeout(socketConnectTimer)
          socketConnectTimer = undefined
        }
        setMarketTransport('rest')
        // 断线后先用强制 REST 请求补齐最近 K 线，再指数退避重连 WebSocket。
        if (refreshTimer) clearTimeout(refreshTimer)
        void refreshLatestCandles()
        if (reconnectTimer) return
        reconnectAttempt += 1
        const now = Date.now()
        if (reconnectAttempt > 5) reconnectCooldownUntil = now + WEBSOCKET_RECONNECT_COOLDOWN_MS
        const delay = reconnectCooldownUntil > now
          ? reconnectCooldownUntil - now
          : Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt, 5))
        reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect() }, delay)
      }
    }
    connect()
    void refreshLatestCandles()
    watchdogTimer = window.setInterval(() => {
      const lastKlineActivityAt = lastKlineMessageAt || socketOpenedAt
      if (cancelled || !lastKlineActivityAt || Date.now() - lastKlineActivityAt < KLINE_WATCHDOG_MS) return
      setMarketTransport('rest')
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close()
    }, 3000)
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (refreshTimer) clearTimeout(refreshTimer)
      if (socketConnectTimer) clearTimeout(socketConnectTimer)
      if (watchdogTimer) window.clearInterval(watchdogTimer)
      socket?.close()
      if (requestId === historyRequestId.current) historyRequestId.current += 1
    }
  }, [active, currentMarketKey, health.websocketBaseUrl, interval])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const refreshPrice = async () => {
      try {
        if (Date.now() - (tickerMessageAt.current[active] ?? 0) < 5000) return
        const response = await fetch(`/api/market/ticker?symbol=${active}`)
        if (!response.ok) throw new Error('Binance 行情请求失败')
        const quote = await response.json() as { price?: string; lastPrice?: string; priceChangePercent?: string }
        const currentPrice = Number(quote.lastPrice ?? quote.price)
        if (!cancelled && Number.isFinite(currentPrice) && currentPrice > 0) {
          const currentChange = quote.priceChangePercent === undefined ? undefined : Number(quote.priceChangePercent)
          setPrice(currentPrice)
          setChange(Number.isFinite(currentChange) ? currentChange! : null)
          setMarketQuotes((current) => ({
            ...current,
            [active]: { price: currentPrice, change: Number.isFinite(currentChange) ? currentChange! : current[active]?.change ?? 0 },
          }))
        }
      } catch {
        // WebSocket 与 REST 轮询都失败时，保留最近一次行情。
      } finally {
        if (!cancelled) timer = setTimeout(refreshPrice, 1500)
      }
    }

    void refreshPrice()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [active])

  const loadOlderCandles = async () => {
    if (!candles.length || !hasOlderRef.current || loadingOlderRef.current || Date.now() < retryAfterRef.current) return
    const requestId = historyRequestId.current
    const symbol = active
    const timeframe = interval
    const endTime = candles[0].time * 1000 - 1
    loadingOlderRef.current = true
    setLoadingOlderCandles(true)
    setHistoryError('')
    try {
      const rows = await requestKlines(symbol, timeframe, endTime)
      if (requestId !== historyRequestId.current) return
      const olderCandles = parseKlines(rows)
      const existingFirstTime = candles[0]?.time
      const uniqueOlder = olderCandles.filter((candle) => candle.time < (existingFirstTime ?? Infinity))
      if (!uniqueOlder.length || rows.length < KLINE_PAGE_SIZE) {
        hasOlderRef.current = false
        setHasOlderCandles(false)
      }
      if (uniqueOlder.length) setCandles((current) => {
        const firstTime = current[0]?.time ?? Infinity
        return [...uniqueOlder.filter((candle) => candle.time < firstTime), ...current]
      })
    } catch (error) {
      if (requestId === historyRequestId.current) {
        retryAfterRef.current = Date.now() + 5000
        setHistoryError(error instanceof Error ? error.message : '读取更早的 K 线失败，请稍后重试')
      }
    } finally {
      if (requestId === historyRequestId.current) {
        loadingOlderRef.current = false
        setLoadingOlderCandles(false)
      }
    }
  }

  useEffect(() => { localStorage.setItem('keel-lines', JSON.stringify(storedLines)) }, [storedLines])
  useEffect(() => { localStorage.setItem('keel-trends', JSON.stringify(storedTrends)) }, [storedTrends])

  useEffect(() => {
    let cancelled = false
    if (!health.privateApiConfigured) return
    type FetchResult = { response?: Response; error?: unknown }
    const safeFetch = (input: RequestInfo | URL): Promise<FetchResult> => fetch(input).then((response) => ({ response })).catch((error) => ({ error }))
    const readJson = async <T,>(result: FetchResult, label: string) => {
      if (!result.response) return { data: null as T | null, error: `${label}读取失败：${result.error instanceof Error ? result.error.message : '网络请求失败'}` }
      if (!result.response.ok) {
        let detail = ''
        try { detail = ((await result.response.clone().json()) as { error?: string }).error ?? '' } catch { /* 忽略无法解析的错误响应。 */ }
        return { data: null as T | null, error: `${label}读取失败${detail ? `：${detail}` : ''}` }
      }
      try { return { data: await result.response.json() as T, error: null } }
      catch { return { data: null as T | null, error: `${label}响应格式无效` } }
    }
    void (async () => {
      if (cancelled) return
      setOrdersLoading(true)
      setOrdersError('')
      const [accountResult, positionsResult, openOrdersResult, historyResult, tradesResult] = await Promise.all([
        safeFetch('/api/account'),
        safeFetch('/api/positions'),
        safeFetch(`/api/open-orders${active ? `?symbol=${encodeURIComponent(active)}` : ''}`),
        active ? safeFetch(`/api/order-history?symbol=${encodeURIComponent(active)}&limit=50`) : Promise.resolve<FetchResult>({}),
        active ? safeFetch(`/api/account/trades?symbol=${encodeURIComponent(active)}&limit=100`) : Promise.resolve<FetchResult>({}),
      ])
      if (cancelled) return
      const errors: string[] = []
      const account = await readJson<{ availableBalance: string }>(accountResult, '账户余额')
      if (account.data) setAccountBalance(account.data.availableBalance)
      else { setAccountBalance(null); if (account.error) errors.push(account.error) }
      const positions = await readJson<Array<{ symbol: string; positionAmt: string; entryPrice: string; markPrice: string; liquidationPrice: string; unRealizedProfit: string; leverage: string; marginType: string; positionSide: string }>>(positionsResult, '持仓')
      if (positions.data) {
        const rows = positions.data
        const activeSettings = rows.find((row) => row.symbol === active)
        if (tradingSettingsSymbol.current !== active) {
          tradingSettingsSymbol.current = active
          const currentLeverage = Number(activeSettings?.leverage)
          setLeverage(Number.isInteger(currentLeverage) && currentLeverage > 0 ? String(currentLeverage) : '10')
          setMarginType(activeSettings?.marginType.toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'CROSSED')
        }
        setPositions(rows.map((row) => ({ symbol: row.symbol, positionAmt: Number(row.positionAmt), entryPrice: Number(row.entryPrice), markPrice: Number(row.markPrice), liquidationPrice: Number(row.liquidationPrice), unrealizedProfit: Number(row.unRealizedProfit), leverage: Number(row.leverage), marginType: row.marginType, positionSide: row.positionSide })).filter((row) => Number.isFinite(row.positionAmt) && row.positionAmt !== 0))
      } else { setPositions([]); if (positions.error) errors.push(positions.error) }
      const openOrders = await readJson<OrderRow[]>(openOrdersResult, '当前委托')
      if (openOrders.data) setOpenOrders(openOrders.data.map((row) => ({ ...row, price: Number(row.price), stopPrice: Number(row.stopPrice), origQty: Number(row.origQty), executedQty: Number(row.executedQty), time: Number(row.time), updateTime: Number(row.updateTime) })))
      else { setOpenOrders([]); if (openOrders.error) errors.push(openOrders.error) }
      if (active) {
        const history = await readJson<OrderRow[]>(historyResult, '历史订单')
        if (history.data) setOrderHistory(history.data.map((row) => ({ ...row, price: Number(row.price), stopPrice: Number(row.stopPrice), origQty: Number(row.origQty), executedQty: Number(row.executedQty), time: Number(row.time), updateTime: Number(row.updateTime) })).sort((left, right) => right.time - left.time))
        else { setOrderHistory([]); if (history.error) errors.push(history.error) }
        const trades = await readJson<Array<{ id: number; symbol: string; orderId: number; side: 'BUY' | 'SELL'; positionSide?: string; price: string; qty: string; time: number }>>(tradesResult, '成交记录')
        if (trades.data) setTrades(trades.data.map((row) => ({ ...row, positionSide: row.positionSide ?? 'BOTH', price: Number(row.price), qty: Number(row.qty), time: Number(row.time) })).filter((row) => Number.isFinite(row.price) && row.price > 0))
        else { setTrades([]); if (trades.error) errors.push(trades.error) }
      } else {
        setOrderHistory([])
        setTrades([])
      }
      if (errors.length && !cancelled) setOrdersError(errors.join('；'))
    })().catch((error) => {
      if (!cancelled) setOrdersError(error instanceof Error ? `读取账户数据失败：${error.message}` : '读取账户数据失败，请稍后刷新')
    }).finally(() => { if (!cancelled) setOrdersLoading(false) })
    return () => { cancelled = true }
  }, [active, health.privateApiConfigured, privateDataRefreshKey])

  useEffect(() => {
    let cancelled = false
    if (!health.privateApiConfigured || !active) {
      setLeverageBrackets([])
      setLeverageBracketsSymbol('')
      setLeverageBracketsError('')
      setLeverageBracketsLoading(false)
      return
    }
    setLeverageBracketsLoading(true)
    void fetch(`/api/account/leverage-brackets?symbol=${encodeURIComponent(active)}`).then(async (response) => {
      const result = await response.json() as { error?: string; brackets?: LeverageBracket[] }
      if (!response.ok) throw new Error(result.error ?? '读取杠杆档位失败')
      const brackets = result.brackets ?? []
      if (!brackets.length) throw new Error('未读取到该币种的真实杠杆档位')
      return brackets
    }).then((brackets) => { if (!cancelled) { setLeverageBrackets(brackets); setLeverageBracketsSymbol(active); setLeverageBracketsError('') } }).catch((error) => { if (!cancelled) { setLeverageBrackets([]); setLeverageBracketsSymbol(active); setLeverageBracketsError(error instanceof Error ? error.message : '读取币种真实杠杆上限失败') } }).finally(() => { if (!cancelled) setLeverageBracketsLoading(false) })
    return () => { cancelled = true }
  }, [active, health.privateApiConfigured, leverageBracketsReloadKey])

  useEffect(() => {
    let cancelled = false
    void fetch('/api/market/exchange-info').then((response) => response.ok ? response.json() as Promise<{ symbols: Array<{ symbol: string; filters: Array<{ filterType: string; stepSize?: string; minQty?: string }> }> }> : null).then((info) => {
      if (!info || cancelled) return
      const rules = Object.fromEntries(info.symbols.map((symbol) => {
        const lot = symbol.filters.find((item) => item.filterType === 'LOT_SIZE')
        const marketLot = symbol.filters.find((item) => item.filterType === 'MARKET_LOT_SIZE')
        return [symbol.symbol, { stepSize: lot?.stepSize ?? '1', minQty: lot?.minQty ?? '0', marketStepSize: marketLot?.stepSize, marketMinQty: marketLot?.minQty }]
      }))
      setSymbolRules(rules)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!health.privateApiConfigured) return
    let cancelled = false
    void fetch('/api/account/position-mode').then(async (response) => {
      if (!response.ok) throw new Error('无法读取持仓模式')
      return await response.json() as { dualSidePosition: boolean }
    }).then((mode) => { if (!cancelled) setHedgeMode(mode.dualSidePosition) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [health.privateApiConfigured])

  useEffect(() => {
    if (!health.privateApiConfigured) return
    const timer = window.setInterval(() => setPrivateDataRefreshKey((value) => value + 1), 15_000)
    return () => window.clearInterval(timer)
  }, [health.privateApiConfigured])

  const activeQuote = marketQuotes[active]
  const chartCandles = useMemo(() => marketDataIsCurrent ? candles : [], [candles, marketDataIsCurrent])
  const last = activeQuote?.price ?? (marketDataIsCurrent ? price ?? candles[candles.length - 1]?.close ?? null : null)
  const activeChange = activeQuote?.change ?? change
  const predictionCandles = useMemo(() => chartCandles.length > 1 ? chartCandles.slice(0, -1).slice(-240) : [], [chartCandles])
  const predictionDataThrough = predictionCandles.at(-1)?.time ?? 0
  const predictionCandlesRef = useRef<Candle[]>([])
  useEffect(() => { predictionCandlesRef.current = predictionCandles }, [predictionCandles])
  useEffect(() => {
    if (!health.predictionConfigured || !active || predictionCandles.length < 50 || !predictionDataThrough) {
      setPrediction(null)
      setPredictionError('')
      setPredictionLoading(false)
      predictionRequestKeyRef.current = ''
      return
    }
    const requestKey = `${active}:${interval}:${predictionDataThrough}`
    if (predictionRequestKeyRef.current === requestKey) return
    predictionRequestKeyRef.current = requestKey
    const controller = new AbortController()
    let cancelled = false
    const candlesForRequest = predictionCandlesRef.current
    setPrediction(null)
    setPredictionError('')
    setPredictionLoading(true)
    void fetch('/api/prediction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ symbol: active, interval, horizonBars: 3, candles: candlesForRequest }),
    }).then(async (response) => {
      const payload = await response.json() as unknown
      if (!response.ok) {
        const message = payload && typeof payload === 'object' ? 'error' in payload && typeof payload.error === 'string' ? payload.error : 'detail' in payload && typeof payload.detail === 'string' ? payload.detail : '预测服务不可用' : '预测服务不可用'
        throw new Error(message)
      }
      const parsed = parsePrediction(payload)
      if (!parsed) throw new Error('预测结果格式无效')
      if (parsed.dataThrough !== predictionDataThrough) throw new Error('预测结果不是当前最新 K 线')
      return parsed
    }).then((result) => {
      if (!cancelled) setPrediction(result)
    }).catch((error: unknown) => {
      if (!cancelled && !(error instanceof DOMException && error.name === 'AbortError')) {
        setPredictionError(error instanceof Error ? error.message : '预测服务不可用')
      }
    }).finally(() => { if (!cancelled) setPredictionLoading(false) })
    return () => { cancelled = true; controller.abort() }
  }, [active, health.predictionConfigured, interval, predictionCandles.length, predictionDataThrough, trainingStatus.finishedAt])
  useEffect(() => {
    let cancelled = false
    const refreshTrainingStatus = async () => {
      if (trainingStatusRequestInFlightRef.current) return
      trainingStatusRequestInFlightRef.current = true
      try {
        const response = await fetch('/api/prediction/train/status', { cache: 'no-store' })
        if (!response.ok) throw new Error(`任务状态请求失败（${response.status}）`)
        const status = await response.json() as TrainingStatus
        if (trainingSubmitInFlightRef.current) return
        if (!cancelled) {
          const jobId = status.jobId ?? null
          const interval = status.currentInterval ?? status.interval ?? null
          const previousProgress = trainingProgressRef.current
          if (jobId !== previousProgress.jobId || interval !== previousProgress.interval) {
            trainingProgressRef.current = { jobId, interval, rowsFetched: status.rowsFetched ?? 0, pagesFetched: status.pagesFetched ?? 0 }
          } else if (status.running) {
            trainingProgressRef.current = {
              jobId,
              interval,
              rowsFetched: Math.max(previousProgress.rowsFetched, status.rowsFetched ?? 0),
              pagesFetched: Math.max(previousProgress.pagesFetched, status.pagesFetched ?? 0),
            }
          }
          const progress = trainingProgressRef.current
          setTrainingStatus({
            ...status,
            ...(status.running ? { rowsFetched: progress.rowsFetched, pagesFetched: progress.pagesFetched } : {}),
          })
          setTrainingStatusError('')
          if (status.jobId && status.jobId !== trainingStatus.jobId && status.intervals?.length) {
            setTrainingIntervals(status.intervals.filter((value): value is Interval => ['15m', '1h', '4h', '1d'].includes(value)))
          }
          if (!status.running && status.finishedAt) predictionRequestKeyRef.current = ''
        }
      } catch (error) {
        if (!cancelled) setTrainingStatusError(error instanceof Error ? error.message : '无法读取训练任务状态，正在重试。')
      }
      finally { trainingStatusRequestInFlightRef.current = false }
    }
    void refreshTrainingStatus()
    const timer = window.setInterval(() => void refreshTrainingStatus(), trainingStatus.running ? 1500 : 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [trainingStatus.jobId, trainingStatus.running])
  useEffect(() => {
    if (workspaceView !== 'training') return
    let cancelled = false
    let timer: number | undefined
    let requestInFlight = false
    const refreshForwardMetrics = async () => {
      if (requestInFlight) return
      requestInFlight = true
      setForwardMetricsLoading(true)
      const query = new URLSearchParams({ interval: trainingInterval, horizonBars: '3' })
      if (active) query.set('symbol', active)
      try {
        const response = await fetch(`/api/prediction/validation/metrics?${query}`, { cache: 'no-store' })
        const payload = await response.json() as ForwardValidationMetrics & { error?: string }
        if (!response.ok) throw new Error(payload.error ?? '前向验证暂不可用')
        if (!cancelled) {
          setForwardMetrics(payload)
          setForwardMetricsError('')
        }
      } catch (error) {
        if (!cancelled) setForwardMetricsError(error instanceof Error ? error.message : '前向验证暂不可用')
      } finally {
        requestInFlight = false
        if (!cancelled) setForwardMetricsLoading(false)
      }
    }
    void refreshForwardMetrics()
    timer = window.setInterval(() => void refreshForwardMetrics(), 30_000)
    return () => { cancelled = true; if (timer !== undefined) window.clearInterval(timer) }
  }, [active, trainingInterval, workspaceView])
  const chartIndicatorValues = useMemo(() => calculateTechnicalIndicators(chartCandles), [chartCandles])
  const aiContextRef = useRef({ price: last, candles: chartCandles, indicators: chartIndicatorValues, lines, trends })
  useEffect(() => {
    aiContextRef.current = { price: last, candles: chartCandles, indicators: chartIndicatorValues, lines, trends }
  }, [chartCandles, chartIndicatorValues, last, lines, trends])
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    if (!prediction) {
      setAiBusy(false)
      setAiExplanation(health.predictionConfigured ? '等待最新模型预测后自动生成解释。' : '本地预测服务暂不可用，暂时无法生成解释。')
      aiExplanationRequestKeyRef.current = ''
      return () => { cancelled = true; controller.abort() }
    }
    if (!health.aiConfigured) {
      setAiBusy(false)
      setAiExplanation('AI 服务尚未配置。当前模型概率仍可查看，请检查本地 AI 服务设置。')
      return () => { cancelled = true; controller.abort() }
    }
    const requestKey = `${active}:${interval}:${prediction.version}:${prediction.dataThrough}:${aiExplanationRefreshKey}`
    if (aiExplanationRequestKeyRef.current === requestKey) return () => { cancelled = true; controller.abort() }
    aiExplanationRequestKeyRef.current = requestKey
    setAiBusy(true)
    setAiExplanation('正在结合模型预测和近期已收盘 K 线生成解释…')
    const aiContext = aiContextRef.current
    void fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ context: {
        symbol: active,
        interval,
        price: aiContext.price,
        prediction,
        candles: aiContext.candles.slice(0, -1).slice(-60).map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume })),
        indicators: aiContext.indicators,
        manualLines: aiContext.lines.map(({ label, price: value }) => ({ label, price: value })),
        trends: aiContext.trends,
      } }),
    }).then(async (response) => {
      const data = await response.json() as { answer?: string; error?: string }
      if (!response.ok) throw new Error(data.error ?? 'AI 解释服务不可用')
      return data.answer?.trim() || 'AI 暂未返回解释。'
    }).then((answer) => {
      if (!cancelled) setAiExplanation(limitAiText(cleanAiText(answer)))
    }).catch((error: unknown) => {
      if (!cancelled && !(error instanceof DOMException && error.name === 'AbortError')) {
        setAiExplanation(aiErrorText(error))
      }
    }).finally(() => { if (!cancelled) setAiBusy(false) })
    return () => { cancelled = true; controller.abort() }
  }, [active, aiExplanationRefreshKey, health.aiConfigured, health.predictionConfigured, interval, prediction, predictionDataThrough])
  const activeQuoteAsset = quoteAsset(active)
  const displayedAmountUnitLabel = amountUnit === 'asset' ? active.replace(activeQuoteAsset, '') : activeQuoteAsset
  const chartPaneCount = (['volume', 'rsi', 'macd', 'stochastic', 'atr', 'adx', 'obv'] as ChartIndicatorKey[]).filter((key) => chartIndicators[key]).length
  const chartIndicatorLegendColors: Record<ChartIndicatorKey, string> = { ema20: '#e79a32', ema50: '#7c69d5', sma200: '#d85b67', bollinger: '#6696d8', vwap: '#27a380', volume: '#64b697', rsi: '#7c69d5', macd: '#2588c7', stochastic: '#2588c7', atr: '#dc7a42', adx: '#735cc8', obv: '#279780' }
  const indicatorLegend = chartIndicatorOptions.filter(({ key }) => chartIndicators[key]).map(({ key, label }) => <span key={key}><i style={{ background: chartIndicatorLegendColors[key] }} />{label}</span>)
  const updateLines = (next: Line[]) => setStoredLines((all) => ({ ...all, [active]: next }))
  const updateTrends = (next: Trend[]) => setStoredTrends((all) => ({ ...all, [active]: next }))
  const displayLines = lines
  const accountLines = useMemo(() => {
    const result: Line[] = []
    positions.filter((item) => item.symbol === active).forEach((position, index) => {
      const direction = position.positionAmt < 0 || position.positionSide === 'SHORT' ? '空仓' : '多仓'
      if (position.entryPrice > 0) result.push({ id: 2_000_000_001 + index * 2, price: position.entryPrice, label: `${direction}均价`, color: '#276fc0', deletable: false })
      if (position.liquidationPrice > 0) result.push({ id: 2_000_000_002 + index * 2, price: position.liquidationPrice, label: `${direction}强平价格`, color: '#d34f55', deletable: false })
    })
    for (const order of openOrders.filter((item) => item.symbol === active)) {
      const price = order.stopPrice > 0 ? order.stopPrice : order.price
      if (!(price > 0)) continue
      const isStop = order.type.includes('STOP') && !order.type.includes('TAKE_PROFIT')
      const isTarget = order.type.includes('TAKE_PROFIT')
      result.push({ id: 3_000_000_000 + order.orderId, price, label: isStop ? '当前止损' : isTarget ? '当前止盈' : `当前委托 ${order.type}`, color: isStop ? '#dc6868' : isTarget ? '#3d91cb' : order.side === 'BUY' ? '#1a9a72' : '#d56e6e', deletable: false })
    }
    return result
  }, [active, openOrders, positions])
  const chartTrades = useMemo(() => {
    const intervalSeconds: Record<Interval, number> = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }
    const candleSize = intervalSeconds[interval]
    return trades.filter((trade) => trade.symbol === active).map((trade) => ({ ...trade, time: Math.floor(trade.time / 1000 / candleSize) * candleSize * 1000 }))
  }, [active, interval, trades])
  const chartLines = useMemo(() => [...displayLines, ...accountLines], [accountLines, displayLines])
  const effectivePositionSide = hedgeMode ? positionSide === 'BOTH' ? side === 'buy' ? 'LONG' : 'SHORT' : positionSide : 'BOTH'
  const addTrend = (start: Trend['start'], end: Trend['end']) => { updateTrends([...trends, { id: Date.now(), start, end }]); setTool('cursor') }
  const removeLine = (id: number) => {
    updateLines(lines.filter((line) => line.id !== id))
  }

  const activeRules = symbolRules[active]
  const activeStepSize = isMarketExecution(orderType) ? activeRules?.marketStepSize ?? activeRules?.stepSize : activeRules?.stepSize
  const activeMinQty = isMarketExecution(orderType) ? activeRules?.marketMinQty ?? activeRules?.minQty : activeRules?.minQty
  const activeLeverageBrackets = useMemo(() => leverageBracketsSymbol === active ? leverageBrackets : [], [active, leverageBrackets, leverageBracketsSymbol])
  const leverageOptions = useMemo(() => allSymbolLeverageOptions(activeLeverageBrackets), [activeLeverageBrackets])
  const storedLeverage = leverageSelections[active]
  const selectedLeverage = Number.isInteger(storedLeverage) && storedLeverage >= 1 && storedLeverage <= (leverageOptions.at(-1) ?? 0)
    ? storedLeverage
    : Number.isInteger(Number(leverage)) && Number(leverage) >= 1 && Number(leverage) <= (leverageOptions.at(-1) ?? 0)
      ? Number(leverage)
      : leverageOptions[0] ?? 0
  const activeSliderPrice = orderPrice ? Number(orderPrice) : last ?? 0
  const sliderLeverage = leverageForBalancePercent(activeLeverageBrackets, Number(accountBalance) || 0, orderPercent || 100, selectedLeverage || 1)
  const effectiveSliderLeverage = orderPercent > 0 ? sliderLeverage.effective : selectedLeverage || 1
  const leverageClampedByNotional = orderPercent > 0 && sliderLeverage.clamped
  const activeSliderSize = orderPercent > 0 && accountBalance && activeSliderPrice > 0
    ? orderSizeAtBalancePercent(Number(accountBalance), effectiveSliderLeverage, orderPercent, activeSliderPrice, activeStepSize ?? '1', amountUnit)
    : null
  const quantityPreview = useMemo(() => {
    if (orderPercent > 0) return activeSliderSize
    const amount = Number(qty)
    if (!active || !Number.isFinite(amount) || amount <= 0) return null
    if (amountUnit === 'usdt') {
      const price = orderPrice ? Number(orderPrice) : last
      if (!price || price <= 0) return null
      const quantity = quantityFromAmount(amount, 'usdt', price, activeStepSize ?? '1')
      return { quantity, notional: Number(quantity) * price, inputAmount: amount }
    }
    const quantity = quantityFromAmount(amount, 'asset', 1, activeStepSize ?? '1')
    const price = orderPrice ? Number(orderPrice) : last
    return { quantity, notional: Number(quantity) * (price ?? 0), inputAmount: amount }
  }, [active, activeSliderSize, activeStepSize, amountUnit, last, orderPercent, orderPrice, qty])
  const setLeverageForActiveSymbol = (value: number) => {
    const maximum = leverageInputMaximum
    const next = Math.min(maximum, Math.max(1, Math.floor(value)))
    setLeverageSelections((current) => ({ ...current, [active]: next }))
    setLeverage(String(next))
  }
  const changeAmountUnit = (nextUnit: OrderAmountUnit) => {
    if (nextUnit === amountUnit) return
    if (orderPercent > 0) { setAmountUnit(nextUnit); return }
    const price = orderPrice ? Number(orderPrice) : last ?? 0
    const amount = Number(qty)
    if (Number.isFinite(amount) && amount > 0 && price > 0) {
      if (amountUnit === 'asset' && nextUnit === 'usdt') setQty(String(Number((amount * price).toPrecision(8))))
      else setQty(quantityFromAmount(amount, 'usdt', price, activeStepSize ?? '1'))
    }
    setAmountUnit(nextUnit)
  }
  const applyPercentToQty = (percent: number) => {
    setOrderPercent(percent)
    if (percent === 0) { setQty('0'); return }
  }

  const submitManage = async () => {
    if (!managePosition) return
    if (!manageStopLossChanged && !manageTakeProfitChanged) { setManageMessage('止盈止损没有修改'); return }
    setManageBusy(true)
    setManageMessage('正在更新持仓保护…')
    try {
      const response = await fetch('/api/account/position-tpsl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: managePosition.symbol, positionSide: managePosition.positionSide, ...(manageStopLossChanged ? { stopLoss: manageStopLoss } : {}), ...(manageTakeProfitChanged ? { takeProfit: manageTakeProfit } : {}), workingType }) })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error ?? '更新失败')
      setManageMessage('止盈止损已更新')
      setPrivateDataRefreshKey((value) => value + 1)
    } catch (error) {
      setManageMessage(error instanceof Error ? error.message : '更新失败')
    } finally { setManageBusy(false) }
  }

  const closeManagedPosition = async (closeAll: boolean) => {
    if (!managePosition) return
    if (!closeAll && (!Number.isFinite(Number(manageQuantity)) || Number(manageQuantity) <= 0)) { setManageMessage('请输入有效的部分平仓数量'); return }
    setManageBusy(true)
    setManageMessage('正在提交平仓…')
    try {
      const response = await fetch('/api/account/close-position', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: managePosition.symbol, positionSide: managePosition.positionSide, quantity: closeAll ? undefined : manageQuantity }) })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error ?? '平仓失败')
      setManageMessage('平仓请求已提交')
      setManagePosition(null)
      setPrivateDataRefreshKey((value) => value + 1)
    } catch (error) {
      setManageMessage(error instanceof Error ? error.message : '平仓失败')
    } finally { setManageBusy(false) }
  }

  const openPositionEditor = async (position: PositionRow) => {
    let orders = openOrders
    if (position.symbol !== active) {
      try {
        const response = await fetch(`/api/open-orders?symbol=${encodeURIComponent(position.symbol)}`)
        if (response.ok) orders = await response.json() as OrderRow[]
      } catch { /* 保留已有账户数据，空字段默认不更新 */ }
    }
    const protectionSide = position.positionAmt > 0 ? 'SELL' : 'BUY'
    const protectionOrders = orders.filter((order) => order.symbol === position.symbol && order.side === protectionSide && ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(order.type) && (order.positionSide ?? 'BOTH') === position.positionSide && (order.closePosition === true || order.closePosition === 'true'))
    const stop = protectionOrders.find((order) => order.type === 'STOP_MARKET' && order.stopPrice > 0)
    const target = protectionOrders.find((order) => order.type === 'TAKE_PROFIT_MARKET' && order.stopPrice > 0)
    setManagePosition(position)
    setManageStopLoss(stop ? String(stop.stopPrice) : '')
    setManageTakeProfit(target ? String(target.stopPrice) : '')
    setManageStopLossChanged(false)
    setManageTakeProfitChanged(false)
    setManageQuantity(partialCloseQuantity(position.positionAmt, 0, symbolRules[position.symbol]?.marketStepSize ?? symbolRules[position.symbol]?.stepSize ?? '1'))
    setManageClosePercent(0)
    setManageMessage('')
  }

  const submitOrder = async () => {
    if (!active) { setOrderMessage('请先搜索并选择一个 Binance 合约'); return }
    setOrderMessage('正在提交订单…')
    try {
      const oneWayPosition = positions.find((position) => position.symbol === active && position.positionSide === 'BOTH')
      if (closePosition && effectivePositionSide === 'BOTH' && !oneWayPosition) throw new Error('当前没有可全平的单向持仓')
      if (reduceOnly && effectivePositionSide === 'BOTH' && (!oneWayPosition || (oneWayPosition.positionAmt > 0 && side !== 'sell') || (oneWayPosition.positionAmt < 0 && side !== 'buy'))) throw new Error('只减仓方向与当前单向持仓不匹配')
      const closeSide = effectivePositionSide === 'LONG' ? 'SELL' : effectivePositionSide === 'SHORT' ? 'BUY' : (oneWayPosition?.positionAmt ?? 0) > 0 ? 'SELL' : 'BUY'
      const referencePrice = orderPrice ? Number(orderPrice) : last ?? 0
      const manualStop = manualStopLoss.trim() ? Number(manualStopLoss) : null
      const manualTarget = manualTakeProfit.trim() ? Number(manualTakeProfit) : null
      if (protectionMode === 'manual' && !closePosition && !reduceOnly) {
        if ((manualStop !== null && (!Number.isFinite(manualStop) || manualStop <= 0)) || (manualTarget !== null && (!Number.isFinite(manualTarget) || manualTarget <= 0))) throw new Error('手动止盈止损价格必须大于 0')
        const isLong = side === 'buy'
        if (referencePrice > 0 && manualStop !== null && (isLong ? manualStop >= referencePrice : manualStop <= referencePrice)) throw new Error(isLong ? '多仓止损价必须低于参考价格' : '空仓止损价必须高于参考价格')
        if (referencePrice > 0 && manualTarget !== null && (isLong ? manualTarget <= referencePrice : manualTarget >= referencePrice)) throw new Error(isLong ? '多仓止盈价必须高于参考价格' : '空仓止盈价必须低于参考价格')
      }
      const sizeFromSlider = orderPercent > 0 && accountBalance && referencePrice > 0
        ? orderSizeAtBalancePercent(Number(accountBalance), effectiveSliderLeverage, orderPercent, referencePrice, activeStepSize ?? '1', amountUnit).quantity
        : undefined
      const orderQuantity = closePosition ? undefined : amountUnit === 'usdt'
        ? quantityFromAmount(Number(qty), 'usdt', referencePrice, activeStepSize ?? '1')
        : quantityFromAmount(Number(qty), 'asset', 1, activeStepSize ?? '1')
      const order: BinanceOrderInput = {
        symbol: active,
        side: closePosition ? closeSide : side === 'buy' ? 'BUY' : 'SELL',
        type: orderType,
        quantity: closePosition ? undefined : sizeFromSlider !== undefined && Number(sizeFromSlider) > 0 ? sizeFromSlider : orderQuantity,
        price: isPriceOrder(orderType) ? orderPrice ?? last?.toString() : undefined,
        stopPrice: isTriggeredOrder(orderType) ? stopPrice : undefined,
        timeInForce: isPriceOrder(orderType) ? timeInForce : undefined,
        reduceOnly: reduceOnly || undefined,
        closePosition: closePosition || undefined,
        positionSide: effectivePositionSide,
        workingType: requiresAlgoEndpoint(orderType) ? workingType : undefined,
        priceProtect: priceProtect && isTriggeredOrder(orderType) ? true : undefined,
        activationPrice: orderType === 'TRAILING_STOP_MARKET' ? activationPrice || undefined : undefined,
        callbackRate: orderType === 'TRAILING_STOP_MARKET' ? callbackRate : undefined,
      }
      const validationError = validateBinanceOrder(order)
      if (validationError) throw new Error(validationError)
      const response = await fetch('/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toBinanceOrderParams(order)) })
      const data = await response.json() as { error?: string; orderId?: number }
      if (!response.ok) throw new Error(data.error ?? '订单被拒绝')
      setOrderMessage(`订单已提交 · #${data.orderId ?? '—'}`)
      const direction = side === 'buy' ? 'LONG' : 'SHORT'
      const stop = manualStop
      const target = manualTarget
      const isPositional = !closePosition && !reduceOnly
      if (isPositional && ((stop && stop > 0) || (target && target > 0))) {
        try {
          const protectionResponse = await fetch('/api/account/position-tpsl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: active, positionSide: hedgeMode ? direction : 'BOTH', side: direction === 'LONG' ? 'SELL' : 'BUY', stopLoss: stop && stop > 0 ? String(stop) : undefined, takeProfit: target && target > 0 ? String(target) : undefined, workingType }) })
          if (!protectionResponse.ok) throw new Error((await protectionResponse.json() as { error?: string }).error ?? '止盈止损设置失败')
            setOrderMessage(`订单已提交 · #${data.orderId ?? '—'} · ${protectionMode === 'manual' ? '手动止盈止损已生效' : '止盈止损已附带'}`)
        } catch (protectionError) {
          setOrderMessage(`订单已提交 · #${data.orderId ?? '—'}，但止盈止损设置失败：${protectionError instanceof Error ? protectionError.message : '未知错误'}`)
        }
      }
      setPrivateDataRefreshKey((value) => value + 1)
    } catch (error) { setOrderMessage(error instanceof Error ? error.message : '订单提交失败') }
  }

  const cancelOrder = async (order: OrderRow) => {
    setCancellingOrderId(order.orderId)
    setOrdersError('')
    try {
      const response = await fetch(`/api/order?symbol=${encodeURIComponent(order.symbol)}&${order.isAlgoOrder ? 'algoId' : 'orderId'}=${order.orderId}`, { method: 'DELETE' })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error ?? '撤单失败')
      setPrivateDataRefreshKey((value) => value + 1)
    } catch (error) {
      setOrdersError(error instanceof Error ? error.message : '撤单失败')
    } finally { setCancellingOrderId(null) }
  }

  const checkPublicIp = async () => {
    setIpLoading(true)
    setIpError('')
    try {
      const response = await fetch('/api/network/current-ip')
      const result = await response.json() as { ip?: string; error?: string }
      if (!response.ok || !result.ip) throw new Error(result.error ?? 'IP 检测失败')
      setPublicIp(result.ip)
    } catch (error) { setIpError(error instanceof Error ? error.message : 'IP 检测失败') }
    finally { setIpLoading(false) }
  }

  const applyTradingSettings = async () => {
    setOrderMessage('正在更新杠杆与保证金模式…')
    try {
    const requestedLeverage = Number(leverage)
    if (!Number.isInteger(requestedLeverage) || requestedLeverage < 1 || requestedLeverage > leverageMaximum) {
      throw new Error(`杠杆请输入 1 到 ${leverageMaximum} 之间的整数`)
    }
    const leverageToApply = orderPercent > 0 ? effectiveSliderLeverage : Math.min(requestedLeverage, orderLeverageLimit)
      const leverageResponse = await fetch('/api/account/leverage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: active, leverage: leverageToApply }) })
      const leverageResult = await leverageResponse.json() as { error?: string; leverage?: number }
      if (!leverageResponse.ok) throw new Error(leverageResult.error ?? '更新杠杆失败')
      const marginResponse = await fetch('/api/account/margin-type', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: active, marginType }) })
      const marginResult = await marginResponse.json() as { error?: string }
      if (!marginResponse.ok && !/No need to change margin type/i.test(marginResult.error ?? '')) throw new Error(marginResult.error ?? '更新保证金模式失败')
      setOrderMessage(`交易设置已应用 · ${leverageResult.leverage ?? leverageToApply}x · ${marginType === 'CROSSED' ? '全仓' : '逐仓'}`)
    } catch (error) { setOrderMessage(error instanceof Error ? error.message : '交易设置更新失败') }
  }

  const toggleHedgeMode = async () => {
    if (!health.privateApiConfigured || !health.tradingEnabled) return
    setOrderMessage('正在更新持仓模式…')
    try {
      const response = await fetch('/api/account/position-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dualSidePosition: !hedgeMode }) })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error ?? '更新持仓模式失败')
      setHedgeMode(!hedgeMode)
      setPositionSide(!hedgeMode ? side === 'buy' ? 'LONG' : 'SHORT' : 'BOTH')
      setOrderMessage(`已切换为${!hedgeMode ? '双向' : '单向'}持仓`)
      setPrivateDataRefreshKey((value) => value + 1)
    } catch (error) { setOrderMessage(error instanceof Error ? error.message : '更新持仓模式失败') }
  }

  const startModelTraining = async () => {
    if (trainingStatus.running) return
    const symbolCount = Number(trainingSymbolCount)
    const intervals = modelTrainingIntervals.map(({ value }) => value).filter((value) => trainingIntervals.includes(value))
    const symbols = [...new Set(trainingSymbols.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))]
    if (!intervals.length) {
      setTrainingRequestError('请至少选择一个训练周期。')
      return
    }
    if (!Number.isInteger(symbolCount) || symbolCount < 2 || symbolCount > 30) {
      setTrainingRequestError('请输入 2 到 30 之间的整数币种数量。')
      return
    }
    if (symbols.length > symbolCount || symbols.some((symbol) => !/^[A-Z0-9]{3,20}$/.test(symbol))) {
      setTrainingRequestError(`手动币种格式无效，且不能多于目标数量 ${symbolCount}。`)
      return
    }
    setTrainingRequestError('')
    setTrainingStatusError('')
    trainingSubmitInFlightRef.current = true
    setTrainingStatus({ running: true, phase: 'running', stage: '正在提交训练任务…', intervals, interval: intervals[0], symbols })
    let receivedResponse = false
    try {
      const response = await fetch('/api/prediction/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervals, interval: intervals[0], symbolCount, symbols }),
      })
      receivedResponse = true
      const payload = await response.json() as TrainingStatus & { error?: string }
      if (!response.ok) throw new Error(payload.error ?? '无法启动模型训练')
      setTrainingStatus(payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : '模型训练启动失败'
      if (receivedResponse) {
        setTrainingStatus({ running: false, phase: 'failed', error: message, intervals, interval: intervals[0], symbols })
        setTrainingRequestError(message)
      } else {
        // The server may have accepted the job before the connection failed.
        // Keep showing a reconnecting state and let the status poll reconcile it.
        setTrainingStatusError(`训练提交响应中断，正在重新读取任务状态：${message}`)
      }
    } finally {
      trainingSubmitInFlightRef.current = false
    }
  }

  const stopModelTraining = async () => {
    if (!trainingStatus.running || trainingStopInFlight) return
    setTrainingStopInFlight(true)
    setTrainingStatusError('')
    try {
      const response = await fetch('/api/prediction/train/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const payload = await response.json() as TrainingStatus & { error?: string }
      if (!response.ok) throw new Error(payload.error ?? '无法停止模型训练')
      setTrainingStatus(payload)
    } catch (error) {
      setTrainingStatusError(error instanceof Error ? error.message : '无法停止模型训练')
    } finally {
      setTrainingStopInFlight(false)
    }
  }

  const indicatorPanel = indicatorsOpen ? <div className="indicator-panel">
    <div className="indicator-panel-head"><div><span className="eyebrow">INDICATORS</span><b>图表指标</b></div><button type="button" onClick={() => setIndicatorsOpen(false)} aria-label="关闭指标设置">×</button></div>
    <div className="indicator-columns"><div><strong>图表显示</strong>{chartIndicatorOptions.map(({ key, label }) => <label className="indicator-check" key={`chart-${key}`}><input type="checkbox" checked={chartIndicators[key]} onChange={(event) => setChartIndicators((current) => ({ ...current, [key]: event.target.checked }))} /><span>{label}</span></label>)}</div></div>
    <small className="indicator-note">指标仅用于查看 K 线，不自动生成交易方向或价位。</small>
  </div> : null
  const statusIntervals = trainingStatus.intervals?.length ? trainingStatus.intervals : trainingIntervals
  const intervalResults = trainingStatus.intervalResults ?? trainingStatus.results ?? {}
  const trainingBadgeLabel = trainingStatus.running ? '训练中' : trainingStatus.phase === 'partial' ? '部分完成' : trainingStatus.phase === 'completed' ? '已完成' : trainingStatus.phase === 'not-promoted' ? '未晋级' : trainingStatus.phase === 'stopped' ? '已停止' : trainingStatus.phase === 'failed' ? '未完成' : '等待训练'
  const stageLabels: Record<string, string> = { starting: '正在准备任务', collecting: '正在采集历史 K 线', training: '正在训练模型', validating: '正在评估候选模型', exporting: '正在导出模型文件', promoting: '正在保存并加载模型', stopping: '正在停止训练', 'not-promoted': '候选模型未晋级', completed: '当前周期已完成', failed: '当前周期失败', stopped: '训练已停止', interrupted: '训练进程已中断', finished: '任务已结束' }
  const trainingStageLabel = trainingStatus.stage ? stageLabels[trainingStatus.stage] ?? trainingStatus.stage : (trainingStatus.phase === 'running' ? '任务正在运行' : '')
  const intervalResultPhase = (result: TrainingIntervalResult | undefined) => result?.status ?? result?.phase
  const resultStatusLabel = (result: TrainingIntervalResult | undefined, value: Interval) => {
    const phase = intervalResultPhase(result)
    if (phase === 'completed') return '已完成并晋级'
    if (phase === 'not-promoted') return '训练完成，候选未晋级'
    if (phase === 'failed') return '训练失败'
    if (phase === 'stopped') return '已停止'
    if (phase === 'running' || (trainingStatus.running && trainingStatus.currentInterval === value)) return '正在处理'
    if (trainingStatus.completedIntervals?.includes(value)) return '已完成'
    return trainingStatus.running ? '等待训练' : '尚无结果'
  }
  const trainingPage = <section className="training-page panel">
    <div className="training-page-header">
      <div><span className="eyebrow">LOCAL MODEL WORKSHOP</span><h1>通用 K 线模型训练</h1><p>从 Binance 当前可交易的 USDT 永续合约中随机选币训练通用模型。可顺序训练多个周期，每个周期独立验证和晋级。</p></div>
      <span className={`training-status-badge ${trainingStatus.running ? 'running' : trainingStatus.phase === 'completed' || trainingStatus.phase === 'partial' ? 'completed' : trainingStatus.phase === 'not-promoted' || trainingStatus.phase === 'failed' || trainingStatus.phase === 'stopped' ? 'failed' : ''}`}><i />{trainingBadgeLabel}</span>
    </div>
    <div className="training-page-grid">
      <section className="training-config-card">
        <div className="training-section-heading"><span>01</span><div><h2>训练配置</h2><p>选择模型周期和训练币种</p></div></div>
        <div className="training-page-fields">
          <fieldset className="training-interval-options" disabled={trainingStatus.running}>
            <legend>训练周期（可多选）</legend>
            {modelTrainingIntervals.map(({ value, label, horizon }) => <label key={value}><input type="checkbox" checked={trainingIntervals.includes(value)} onChange={(event) => setTrainingIntervals((current) => event.target.checked ? [...new Set([...current, value])] : current.filter((item) => item !== value))} /><span>{label}<small>预测未来 {horizon}</small></span></label>)}
          </fieldset>
          <label>随机抽取数量<input type="number" min="2" max="30" step="1" value={trainingSymbolCount} onChange={(event) => setTrainingSymbolCount(event.target.value)} disabled={trainingStatus.running} /></label>
          <label>手动指定币种（可选）<input value={trainingSymbols} onChange={(event) => setTrainingSymbols(event.target.value)} disabled={trainingStatus.running} placeholder="留空则全部随机；也可填写 BTCUSDT,ETHUSDT" /></label>
          <small>数量为 2–30。手动输入的交易对会保留，剩余名额从其他可交易币种中随机补足；手动币种数不能超过设定数量。多周期任务会逐个周期顺序执行。</small>
        </div>
        <button type="button" className="training-start-button" onClick={() => void startModelTraining()} disabled={trainingStatus.running || trainingStopInFlight}>{trainingStatus.running ? '模型正在训练…' : '开始训练模型'}</button>
        <button type="button" className="training-stop-button" onClick={() => void stopModelTraining()} disabled={!trainingStatus.running || trainingStopInFlight}>{trainingStopInFlight ? '正在停止…' : '停止训练'}</button>
        {(trainingRequestError || trainingStatus.error || trainingStatusError) && <div className="training-page-error" role="alert">{trainingRequestError || trainingStatus.error || trainingStatusError}</div>}
      </section>
      <section className="training-run-card">
        <div className="training-section-heading"><span>02</span><div><h2>训练进度与结果</h2><p>训练完成后会自动验证并尝试热加载</p></div></div>
        {trainingStatus.running ? <div className="training-progress" role="status"><i /><div><strong>{trainingStatus.currentInterval ? `正在处理 ${trainingStatus.currentInterval} 周期模型` : '正在准备训练任务'}</strong><span>{trainingStageLabel}{trainingStatus.currentSymbol ? ` · 当前币种 ${trainingStatus.currentSymbol}` : ''}</span>{trainingStatus.symbolCount !== undefined && <span>币种进度：{trainingStatus.symbolIndex ?? 0}/{trainingStatus.symbolCount} · 已获取 {trainingStatus.rowsFetched ?? 0} 根 K 线</span>}<span>{trainingStatus.symbols?.length ? `训练币种：${trainingStatus.symbols.join(' · ')}` : '正在随机选取币种'}</span><span>周期进度：{trainingStatus.finishedIntervals?.length ?? trainingStatus.completedIntervals?.length ?? 0}/{statusIntervals.length} 已结束 · {trainingStatus.completedIntervals?.length ?? 0} 个已晋级</span></div></div>
          : trainingStatus.phase === 'completed' ? <div className="training-page-result" role="status"><strong>所选周期训练任务已结束</strong><small>每个周期的验证和模型晋级结果如下。</small></div>
            : trainingStatus.phase === 'not-promoted' ? <div className="training-idle failed" role="status">训练已完成，但候选模型未能晋级；现有模型保持不变。请查看周期结果与评估指标。</div>
            : trainingStatus.phase === 'partial' ? <div className="training-idle failed" role="status">部分周期已完成，至少一个周期失败或未能晋级；请查看各周期结果与日志。</div>
              : trainingStatus.phase === 'stopped' ? <div className="training-idle" role="status">训练已停止；已保存的 K 线数据和模型文件保持不变。</div>
              : trainingStatus.phase === 'failed' ? <div className="training-idle failed" role="status">训练任务失败。请查看下方阶段错误和详细日志。</div>
                : <div className="training-idle">尚未启动训练。模型文件会分别保存在 <code>prediction/models/&lt;周期&gt;</code>。</div>}
        <div className="training-interval-results">{statusIntervals.map((value) => {
          const result = intervalResults[value]
          const label = modelTrainingIntervals.find(({ value: option }) => option === value)?.label ?? value
          const stateLabel = resultStatusLabel(result, value)
          const metrics = result?.metrics ?? (statusIntervals.length === 1 ? trainingStatus.metrics : undefined)
          return <article className={`training-interval-result ${intervalResultPhase(result) ?? ''}`} key={value}><header><strong>{label}</strong><span>{stateLabel}</span></header>{metrics && <div className="training-interval-metrics"><span>准确率<b>{metrics.accuracy === undefined ? '—' : `${(metrics.accuracy * 100).toFixed(1)}%`}</b></span><span>平衡准确率<b>{metrics.balancedAccuracy === undefined ? '—' : `${(metrics.balancedAccuracy * 100).toFixed(1)}%`}</b></span><span>Macro F1<b>{metrics.macroF1 === undefined ? '—' : metrics.macroF1.toFixed(3)}</b></span><span>Brier<b>{metrics.brier === undefined ? '—' : metrics.brier.toFixed(4)}</b></span><span>测试样本<b>{metrics.testSamples?.toLocaleString() ?? '—'}</b></span></div>}{result?.notice && <small className="training-interval-note">{result.notice}</small>}{result?.error && <small className="training-interval-error">{result.error}</small>}{result?.output && <details className="training-interval-log"><summary>查看 {value} 日志</summary><pre>{result.output}</pre></details>}</article>
        })}</div>
        {trainingStatus.output && <details className="training-page-log"><summary>查看训练日志</summary><pre>{trainingStatus.output}</pre></details>}
      </section>
      <section className="forward-validation-card">
        <div className="training-section-heading"><span>03</span><div><h2>模拟前向验证</h2><p>{active || '当前币种'} · {trainingInterval} · 预测未来 3 根已收盘 K 线 · 按模型版本统计</p></div><small className="forward-validation-refresh">{forwardMetricsLoading ? '更新中…' : '每 30 秒刷新'}</small></div>
        {forwardMetricsError ? <div className="training-validation-empty">{forwardMetricsError}</div>
          : !forwardMetrics || forwardMetrics.predictions === 0 ? <div className="training-validation-empty">尚无前向验证记录。生成预测后，待目标 K 线收盘便会开始累计真实后验结果。</div>
            : <>
              <div className="forward-validation-models">{Object.entries(forwardMetrics.byModelVersion ?? {}).map(([version, metrics]) => <section className="forward-validation-model" key={version}><strong>模型 {version}</strong><div className="forward-validation-metrics"><span>已结算样本<b>{metrics.settled.toLocaleString()}</b></span><span>待结算<b>{metrics.pending.toLocaleString()}</b></span><span>准确率<b>{metrics.accuracy === null ? '—' : `${(metrics.accuracy * 100).toFixed(1)}%`}</b></span><span>平衡准确率<b>{metrics.balancedAccuracy === null ? '—' : `${(metrics.balancedAccuracy * 100).toFixed(1)}%`}</b></span><span>Brier<b>{metrics.brier === null ? '—' : metrics.brier.toFixed(4)}</b></span></div>{metrics.byClass && <div className="forward-validation-classes">{['DOWN', 'NEUTRAL', 'UP'].map((label) => { const item = metrics.byClass?.[label]; return <span key={label}>{label === 'DOWN' ? '下跌' : label === 'UP' ? '上涨' : '中性'}真实样本 {item?.actual.toLocaleString() ?? '0'} · 召回率 {item ? `${(item.recall * 100).toFixed(1)}%` : '—'}</span> })}</div>}</section>)}</div>
              <small className="forward-validation-disclaimer">这是模型上线后的历史前向验证统计，不代表未来保证；尚未扣除手续费、滑点和资金费。</small>
            </>}
      </section>
    </div>
    <div className="training-page-note"><strong>模型发布说明</strong><span>候选模型需通过最低测试样本检查；同特征体系下会在同一时间留出集比较 Brier、平衡准确率和宏 F1。界面显示各模型版本的前向验证结果。当前时间留出测试覆盖已采集币种，不代表对未见币种的泛化或未来表现保证。</span></div>
  </section>
  const predictionPanel = <div className="prediction-card prediction-card-main">
    <div className="prediction-card-head"><strong>通用 K 线预测</strong><small>{prediction?.model ?? 'LightGBM / ONNX'}</small></div>
    {!health.predictionConfigured ? <small className="prediction-muted">本地预测服务未连接。</small>
      : predictionLoading ? <small className="prediction-muted">正在计算最新已收盘 K 线…</small>
        : predictionError ? <small className="prediction-error">{predictionError}</small>
          : prediction ? <>
            <div className="prediction-main"><b className={prediction.direction === 'UP' ? 'up' : prediction.direction === 'DOWN' ? 'down' : ''}>{prediction.direction === 'UP' ? '上涨' : prediction.direction === 'DOWN' ? '下跌' : '信号不足'}</b><span>未来 {prediction.horizonBars} 根 {prediction.interval} K 线</span><strong>置信度 {Math.round(prediction.confidence * 100)}%</strong></div>
            <div className="prediction-probabilities"><span>上涨 {Math.round(prediction.probabilityUp * 100)}%</span><span>下跌 {Math.round(prediction.probabilityDown * 100)}%</span><span>中性 {Math.round(prediction.probabilityNeutral * 100)}%</span></div>
            <small className="prediction-meta">模型 {prediction.version} · 测试准确率 {prediction.validation?.accuracy === undefined ? '—' : `${Math.round(prediction.validation.accuracy * 100)}%`} · 数据截至 {new Date(prediction.dataThrough * 1000).toLocaleString()}</small>
          </> : <small className="prediction-muted">等待足够的已收盘 K 线。</small>}
  </div>
  const formatOrderTime = (value: number) => Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : '—'
  const formatOrderPrice = (order: OrderRow) => order.price > 0 && order.stopPrice > 0 ? `${formatPrice(order.price)} / 触发 ${formatPrice(order.stopPrice)}` : order.price > 0 ? formatPrice(order.price) : order.stopPrice > 0 ? `触发 ${formatPrice(order.stopPrice)}` : '市价'
  const orderTypeLabel = (value: string) => orderTypeOptions.find((option) => option.value === value)?.label ?? value
  const orderStatusLabel = (value: string) => ({ NEW: '未成交', PARTIALLY_FILLED: '部分成交', FILLED: '已成交', CANCELED: '已撤销', REJECTED: '已拒绝', EXPIRED: '已过期', EXPIRED_IN_MATCH: '过期' } as Record<string, string>)[value] ?? value
  const leverageMaximum = Math.max(1, maximumLeverageForBrackets(activeLeverageBrackets) ?? 1)
  const leverageNotional = quantityPreview?.notional ?? 0
  const orderLeverageLimit = leverageNotional > 0 ? leverageLimitForNotional(activeLeverageBrackets, leverageNotional) ?? 1 : leverageMaximum
  const leverageInputMaximum = Math.max(1, Math.min(leverageMaximum, orderLeverageLimit))


  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">K</div><div><strong>KEEL</strong><span>TRADING DESK</span></div></div>
      <div className="top-actions"><div className={`connection ${marketAvailable ? 'online' : ''}`}><i />{marketTransport === 'websocket' ? `Binance ${health.environment === 'testnet' ? '测试网' : '正式网'} 已连接` : marketTransport === 'rest' ? 'Binance REST 行情补偿中' : active ? '正在连接 Binance' : '请先收藏币种'}</div><button type="button" className="icon-btn ip-check" title="检测后端访问 Binance 使用的公网出口 IP" onClick={checkPublicIp} disabled={ipLoading}>{ipLoading ? '检测中…' : publicIp ? `出口 IP ${publicIp}` : '检测出口 IP'}</button>{ipError && <span className="ip-error" role="status">{ipError}</span>}<div className="avatar">JD</div></div>
    </header>
    <main className={`workspace ${workspaceView === 'training' ? 'training-view' : ''}`}>
      <MarketList
        symbols={filteredSymbols}
        availableSymbols={availableSymbols}
        favoriteSymbols={watchlist}
        active={active}
        quotes={marketQuotes}
        search={symbolSearch}
        loading={symbolCatalogLoading}
        error={symbolCatalogError}
        mobileOpen={mobileMarketsOpen}
        view={workspaceView}
        onCloseMobile={() => setMobileMarketsOpen(false)}
        onSearchChange={setSymbolSearch}
        onSelect={(symbol) => { if (symbol !== active) { if (autoTimeframe) { setInterval('1h') } setOrderPrice(null); setStopPrice(''); setActivationPrice(''); setClosePosition(false); setOrderPercent(0); setQty('0'); setLeverageBrackets([]); setLeverageBracketsSymbol(''); setCandles([]); setChartIndicators((current) => ({ ...current })); setActive(symbol) } setMobileMarketsOpen(false) }}
        onToggleFavorite={toggleFavorite}
        onMoveFavorite={moveFavorite}
        onReorder={(from, over) => setWatchlist((current) => reorderWatchlist(current, from, over))}
        onOpenTraining={() => { setWorkspaceView('training'); setMobileMarketsOpen(false) }}
        onOpenMarkets={() => { setWorkspaceView('markets'); setMobileMarketsOpen(false) }}
      />
      {workspaceView === 'training' ? trainingPage : <>
      <section className="chart-section panel"><div className="chart-head"><div className="pair-title"><span className="coin-icon large" style={{ background: selected.color }}>{selected.icon}</span><div><span className="prediction-header-label">通用预测 · {prediction ? (prediction.direction === 'UP' ? '上涨' : prediction.direction === 'DOWN' ? '下跌' : '信号不足') : predictionError ? '方向信号暂不可用' : '等待模型'}</span><h1>{active ? active.replace(activeQuoteAsset, "") : '选择币种'}<small>{active ? `/ ${activeQuoteAsset} · 永续` : '· 搜索并收藏币种开始'}</small></h1><div className="live-price">{formatPrice(last)} <span className={activeChange !== null && activeChange < 0 ? 'down' : 'up'}>{activeChange !== null ? `${activeChange >= 0 ? '+' : ''}${activeChange.toFixed(2)}%` : '—'}</span></div></div></div><div className="chart-meta">{(['15m', '1h', '4h', '1d'] as Interval[]).map((value) => <button key={value} className={interval === value && !autoTimeframe ? 'time-active' : ''} onClick={() => { setAutoTimeframe(false); setInterval(value) }}>{value.toUpperCase()}</button>)}<span className="divider" /><button type="button" className={indicatorsOpen ? 'selected' : ''} onClick={() => setIndicatorsOpen((open) => !open)}>⌁ 指标</button><div className="chart-more-wrap"><button type="button" aria-label="更多图表选项" aria-expanded={moreActionsOpen} onClick={() => setMoreActionsOpen((open) => !open)}>⋮</button>{moreActionsOpen && <div className="chart-more-menu"><button type="button" onClick={() => { setIndicatorsOpen(true); setMoreActionsOpen(false) }}>指标设置</button><button type="button" onClick={() => { setChartIndicators(DEFAULT_CHART_INDICATORS); setMoreActionsOpen(false) }}>恢复默认指标</button></div>}</div></div></div>{indicatorPanel}{predictionPanel}<div className="chart-toolbar"><button className={tool === 'cursor' ? 'selected' : ''} onClick={() => setTool('cursor')}>↖ 选择</button><button className={tool === 'horizontal' ? 'selected' : ''} onClick={() => setTool('horizontal')}>― 水平线</button><button className={tool === 'trend' ? 'selected' : ''} onClick={() => setTool('trend')}>╱ 手动画线</button><small className="chart-delete-hint">选择工具下双击标注删除</small><span className="toolbar-spacer" /><span className={`chart-status ${marketTransport === 'websocket' || marketTransport === 'rest' ? 'online' : ''}`}><i />{marketTransportLabel}{marketTransport === 'websocket' ? ` · ${chartPaneCount} 个指标窗` : ''}</span></div><div className="indicator-legend">{indicatorLegend}</div><div className="chart-wrap" style={{ '--indicator-extra-height': `${chartPaneCount * 80}px` } as React.CSSProperties}>{prediction && <div className="prediction-chart-overlay" aria-label="当前模型概率"><div><strong>预测概率</strong><small>未来 {prediction.horizonBars} 根 {prediction.interval} K 线</small></div><span className="prediction-chart-up">上涨 {Math.round(prediction.probabilityUp * 100)}%</span><span className="prediction-chart-down">下跌 {Math.round(prediction.probabilityDown * 100)}%</span><span className="prediction-chart-neutral">中性 {Math.round(prediction.probabilityNeutral * 100)}%</span></div>}<LiveChart key={`${active}-${interval}`} data={chartCandles} marketKey={`${active}:${interval}`} currentPrice={last} trades={chartTrades} indicators={chartIndicatorValues} enabledIndicators={chartIndicators} levels={chartLines} trends={trends} tool={tool} levelLabel={levelLabel} onAddLevel={(value) => { updateLines([...lines, { id: Date.now(), price: value, label: '手动标记', color: '#7c8794' }]); setTool('cursor') }} onAddTrend={addTrend} onRemoveLevel={removeLine} onRemoveTrend={(id) => updateTrends(trends.filter((trend) => trend.id !== id))} onLoadOlder={loadOlderCandles} />{loading && active && <div className="chart-empty">正在读取 Binance {interval.toUpperCase()} K 线…</div>}{!active && <div className="chart-empty">请在左侧搜索并收藏币种，然后选择查看行情。</div>}{active && !loading && chartCandles.length === 0 && <div className="chart-empty">暂时没有 K 线数据<br /><small>请检查网络连接状态</small></div>}</div><div className="chart-footer"><span>{loadingOlderCandles ? '正在加载更早的 K 线…' : historyError || (hasOlderCandles ? '向左拖动图表，自动加载更早的 K 线' : '已到可用历史数据起点')} · 共 {candles.length.toLocaleString()} 根 {interval.toUpperCase()}</span><span>{autoTimeframe ? '自动周期' : '手动周期'} · 通用预测 · Binance USDⓈ-M · {marketTransport === 'websocket' ? '实时' : marketTransport === 'rest' ? 'REST补偿' : '等待连接'}</span></div></section>
      <aside id="trade-panel" className="trade-panel panel">
        <div className="tabs"><button className={tab === 'order' ? 'active' : ''} onClick={() => setTab('order')}>下单</button><button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>AI 解释层 <span className="new-dot" /></button></div>
        {tab === 'order' ? <div className="order-content">
          <div className="order-mode"><button className={side === 'buy' ? 'buy active' : ''} onClick={() => { setSide('buy'); setPositionSide(hedgeMode ? 'LONG' : 'BOTH') }}>做多 / 买入</button><button className={side === 'sell' ? 'sell active' : ''} onClick={() => { setSide('sell'); setPositionSide(hedgeMode ? 'SHORT' : 'BOTH') }}>做空 / 卖出</button></div>
          <div className="order-meta"><span>可用保证金</span><b>{accountBalance ?? '—'} <small>USDT</small></b><button type="button" onClick={() => setPrivateDataRefreshKey((value) => value + 1)} disabled={!health.privateApiConfigured}>刷新</button></div>
          <label>订单类型<select value={orderType} onChange={(event) => { const next = event.target.value as BinanceOrderType; setOrderType(next); setClosePosition(false); if (isTriggeredOrder(next)) setStopPrice('') }}>
            {orderTypeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select></label>
          {isPriceOrder(orderType) && <label>委托价格<div className="input-unit"><input type="number" min="0" step="any" value={orderPrice ?? last?.toString() ?? ''} onChange={(event) => setOrderPrice(event.target.value)} placeholder="输入限价" /><span>USDT</span></div></label>}
          {isTriggeredOrder(orderType) && <label>触发价格<div className="input-unit"><input type="number" min="0" step="any" value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} placeholder="输入触发价" /><span>USDT</span></div></label>}
          {orderType === 'TRAILING_STOP_MARKET' && <>
            <label>激活价格（可选）<div className="input-unit"><input type="number" min="0" step="any" value={activationPrice} onChange={(event) => setActivationPrice(event.target.value)} placeholder="留空则立即激活" /><span>USDT</span></div></label>
            <label>回调率<div className="input-unit"><input type="number" min="0.1" max="20" step="0.1" value={callbackRate} onChange={(event) => setCallbackRate(event.target.value)} /><span>%</span></div></label>
          </>}
          {isPriceOrder(orderType) && <label>有效期<select value={timeInForce} onChange={(event) => setTimeInForce(event.target.value as typeof timeInForce)}><option value="GTC">GTC · 撤销前有效</option><option value="IOC">IOC · 立即成交剩余撤销</option><option value="FOK">FOK · 全部立即成交</option><option value="GTX">GTX · 只做 Maker</option></select></label>}
          {!closePosition && <label>数量<div className="input-unit"><select value={amountUnit} onChange={(event) => changeAmountUnit(event.target.value as OrderAmountUnit)}><option value="asset">币</option><option value="usdt">{activeQuoteAsset}</option></select><input type="number" min="0" step="any" value={orderPercent > 0 && activeSliderSize ? String(activeSliderSize.inputAmount) : qty} onChange={(event) => { setQty(event.target.value); setOrderPercent(0) }} placeholder="输入数量" /><span>{displayedAmountUnitLabel}</span></div><small className="order-estimate">{quantityPreview ? `按 ${activeStepSize ?? '—'} 步长对齐后数量 ${quantityPreview.quantity} · 预估名义价值 ${formatPrice(quantityPreview.notional)} ${activeQuoteAsset}` : '预估名义价值 —'}</small></label>}
          {!closePosition && <div className="percent-slider-control"><div className="slider-label-row"><span>仓位比例</span><b>{orderPercent}%</b></div><input className="binance-range" style={{ '--range-progress': `${orderPercent}%` } as React.CSSProperties} type="range" min="0" max="100" step="1" value={orderPercent} onChange={(event) => applyPercentToQty(Number(event.target.value))} disabled={!health.privateApiConfigured || !accountBalance} /><div className="range-marks">{[0, 25, 50, 75, 100].map((percent) => <button key={percent} type="button" className={orderPercent === percent ? 'selected' : ''} onClick={() => applyPercentToQty(percent)} disabled={!health.privateApiConfigured || !accountBalance}>{percent}%</button>)}</div>{activeSliderSize && <small className="order-estimate">预估数量 {activeSliderSize.inputAmount} {displayedAmountUnitLabel} · 名义价值 {formatPrice(activeSliderSize.notional)} USDT{leverageClampedByNotional ? ` · 已按档位上限调整为 ${effectiveSliderLeverage}x` : ''}</small>}</div>}
          <div className="order-settings-grid">
            <label>保证金模式<select value={marginType} onChange={(event) => setMarginType(event.target.value as typeof marginType)}><option value="CROSSED">全仓</option><option value="ISOLATED">逐仓</option></select></label>
            <label>杠杆<div className="input-unit leverage-input"><input type="number" min="1" max={leverageInputMaximum} step="1" value={leverage} onChange={(event) => setLeverage(event.target.value)} onBlur={() => setLeverageForActiveSymbol(Number(leverage))} disabled={leverageBracketsLoading || !activeLeverageBrackets.length} /><span>x</span></div><small className="order-estimate">{leverageBracketsError ? leverageBracketsError : leverageBracketsLoading ? '正在读取 Binance 杠杆档位…' : `币种理论最大杠杆 ${leverageMaximum}x · 当前名义价值档位上限 ${orderLeverageLimit}x`}</small>{leverageBracketsError && <button type="button" className="leverage-retry" onClick={() => setLeverageBracketsReloadKey((value) => value + 1)}>重试读取</button>}</label>
            <label>持仓模式<select value={hedgeMode ? 'dual' : 'oneway'} onChange={() => void toggleHedgeMode()} disabled={!health.privateApiConfigured || !health.tradingEnabled}><option value="oneway">单向持仓</option><option value="dual">双向持仓</option></select></label>
            {requiresAlgoEndpoint(orderType) && <label>触发参考<select value={workingType} onChange={(event) => setWorkingType(event.target.value as typeof workingType)}>{workingTypeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>}
          </div>
          {!hedgeMode && <label className="order-toggle"><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} disabled={closePosition} /><span>只减仓</span></label>}
          {['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(orderType) && <label className="order-toggle"><input type="checkbox" checked={closePosition} onChange={(event) => { setClosePosition(event.target.checked); if (event.target.checked) setReduceOnly(false) }} /><span>平掉该方向全部仓位</span></label>}
          {isTriggeredOrder(orderType) && <label className="order-toggle"><input type="checkbox" checked={priceProtect} onChange={(event) => setPriceProtect(event.target.checked)} /><span>价格保护</span></label>}
        <button type="button" className="apply-settings" onClick={applyTradingSettings} disabled={!active || !health.privateApiConfigured || !health.tradingEnabled}>应用杠杆与保证金设置</button>
          <small className="order-settings-note">更改杠杆或保证金模式后，请先应用设置再下单。</small>
          <div className="risk-row manual">
            <div><span>止损价格</span><input type="number" min="0" step="any" value={manualStopLoss} onChange={(event) => setManualStopLoss(event.target.value)} placeholder="留空则不设保护" /></div>
            <div><span>止盈价格</span><input type="number" min="0" step="any" value={manualTakeProfit} onChange={(event) => setManualTakeProfit(event.target.value)} placeholder="留空则不设保护" /></div>
          </div>
            <small className="manual-protection-note">止盈止损可选填写；留空则仅提交订单，不设置保护单。预测模型和 AI 解释层不会自动生成订单价位。</small>
          <button className={`submit ${side}`} onClick={submitOrder} disabled={!active || !health.tradingEnabled}>{closePosition ? '提交全平条件单' : `${side === 'buy' ? '买入 / 做多' : '卖出 / 做空'} · ${orderTypeOptions.find((item) => item.value === orderType)?.label}`}</button>
          {activeMinQty && Number(activeMinQty) > 0 && <small className="order-min-note">最小下单数量 {activeMinQty}{isMarketExecution(orderType) ? '（市价）' : ''}</small>}
          {orderMessage && <div className="order-message" role="status">{orderMessage}</div>}
          <div className="api-note"><span>⌁</span><div><b>{health.tradingEnabled ? (health.environment === 'testnet' ? '测试网下单已启用' : '实盘交易已启用') : health.environment === 'testnet' ? '测试网下单未启用' : '实盘交易未启用'}</b><small>{health.privateApiConfigured ? (health.tradingEnabled ? '仅点击上方下单按钮时提交订单' : 'API 已配置，安全开关关闭，订单提交不可用') : '请在后端配置所选环境的 Binance API Key'}</small></div></div>
        </div> : <div className="ai-content"><div className="ai-intro"><div className="ai-spark">✦</div><h3>自动预测解释</h3><p>每次更新模型预测后，自动解释概率、数据依据和风险条件。</p><small className={health.aiConfigured ? 'ai-ready' : 'ai-unavailable'}>{health.aiConfigured ? aiBusy ? 'AI 正在分析当前预测…' : 'AI 已连接 · 随模型自动更新' : 'AI 尚未配置，请检查本地服务设置'}</small></div>{prediction && <div className="ai-prediction-summary"><strong>{prediction.direction === 'UP' ? '模型方向：上涨' : prediction.direction === 'DOWN' ? '模型方向：下跌' : '模型方向：中性'}</strong><span>未来 {prediction.horizonBars} 根 {prediction.interval} K 线</span><div><span className="up">上涨 {Math.round(prediction.probabilityUp * 100)}%</span><span className="down">下跌 {Math.round(prediction.probabilityDown * 100)}%</span><span>中性 {Math.round(prediction.probabilityNeutral * 100)}%</span></div><small>独立测试准确率 {prediction.validation?.accuracy === undefined ? '—' : `${(prediction.validation.accuracy * 100).toFixed(1)}%`} · 样本 {prediction.validation?.testSamples?.toLocaleString() ?? '—'}</small></div>}<div className="ai-explanation-output" aria-live="polite">{aiExplanation}</div><button type="button" className="ai-refresh-button" onClick={() => setAiExplanationRefreshKey((value) => value + 1)} disabled={aiBusy || !health.aiConfigured || !prediction}>{aiBusy ? '分析中…' : '重新分析'}</button><small className="ai-disclaimer">AI 仅解释数值模型结果，不修改概率，不构成投资建议，也不会自动下单。</small></div>}
      </aside>
      </>}
    </main>
    {workspaceView === 'markets' && <section className="bottom-panel panel">
      <div className="bottom-tabs">
        <button className={bottomTab === 'positions' ? 'active' : ''} onClick={() => setBottomTab('positions')}>持仓 <span>{positions.length}</span></button>
        <button className={bottomTab === 'openOrders' ? 'active' : ''} onClick={() => setBottomTab('openOrders')}>当前委托 <span>{openOrders.length}</span></button>
        <button className={bottomTab === 'history' ? 'active' : ''} onClick={() => setBottomTab('history')}>历史订单 <span>{orderHistory.length}</span></button>
        <button className={bottomTab === 'trades' ? 'active' : ''} onClick={() => setBottomTab('trades')}>成交记录 <span>{trades.length}</span></button>
        <span className="bottom-spacer" />
        <button type="button" className="refresh-account" onClick={() => setPrivateDataRefreshKey((value) => value + 1)} disabled={!health.privateApiConfigured || ordersLoading}>{ordersLoading ? '读取中…' : '刷新'}</button>
        <button type="button" className="ip-panel-check" title="检测后端访问 Binance 使用的公网出口 IP" onClick={checkPublicIp} disabled={ipLoading}>{ipLoading ? '检测中…' : publicIp ? `出口 IP：${publicIp}` : '检测出口 IP'}</button>
        <span className="account-state"><i />{health.privateApiConfigured ? '私有 API 已配置' : '未连接私有 API'}</span>
      </div>
      {ordersError && <div className="account-error" role="alert">{ordersError}</div>}
      {ipError && <div className="account-error" role="alert">{ipError}</div>}
      {!health.privateApiConfigured ? <div className="empty-state"><div className="empty-icon">⌁</div><div><b>未连接私有 API</b><span>配置 Binance 只读 API Key 后可读取真实账户持仓与订单</span></div></div> : ordersLoading && !positions.length && !openOrders.length && !orderHistory.length && !trades.length ? <div className="empty-state"><div className="empty-icon">⌁</div><div><b>正在同步账户数据</b><span>读取 Binance USDⓈ-M Futures 私有接口</span></div></div> : bottomTab === 'positions' ? positions.length ? <div className="account-table-wrap"><table className="account-table"><thead><tr><th>交易对 / 方向</th><th>持仓数量</th><th>开仓均价</th><th>标记价格</th><th>未实现盈亏</th><th>杠杆</th><th>操作</th></tr></thead><tbody>{positions.map((position, index) => <tr key={`${position.symbol}-${position.positionSide}-${index}`}><td><b>{position.symbol}</b><small>{position.positionSide === 'BOTH' ? position.positionAmt > 0 ? '单向多仓' : '单向空仓' : position.positionSide === 'LONG' ? '多仓' : '空仓'}</small></td><td className={position.positionAmt >= 0 ? 'up' : 'down'}>{formatPrice(position.positionAmt)}</td><td>{formatPrice(position.entryPrice)}</td><td>{formatPrice(position.markPrice)}</td><td className={position.unrealizedProfit >= 0 ? 'up' : 'down'}>{formatPrice(position.unrealizedProfit)} USDT</td><td>{position.leverage}x</td><td><button type="button" className="manage-position" onClick={() => openPositionEditor(position)}>管理</button></td></tr>)}</tbody></table></div> : <div className="empty-state"><div className="empty-icon">⌁</div><div><b>暂无持仓</b><span>当前账户没有未平仓的合约持仓</span></div></div> : bottomTab === 'openOrders' ? openOrders.length ? <div className="account-table-wrap"><table className="account-table"><thead><tr><th>交易对 / 方向</th><th>订单类型</th><th>价格 / 触发价</th><th>数量 / 已成交</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{openOrders.map((order) => <tr key={`${order.symbol}-${order.orderId}`}><td><b>{order.symbol}</b><small className={order.side === 'BUY' ? 'up' : 'down'}>{order.side === 'BUY' ? '买入' : '卖出'}</small></td><td>{orderTypeLabel(order.type)}</td><td>{formatOrderPrice(order)}</td><td>{formatPrice(order.origQty)} / {formatPrice(order.executedQty)}</td><td>{formatOrderTime(order.updateTime || order.time)}</td><td><button type="button" className="cancel-order" onClick={() => void cancelOrder(order)} disabled={cancellingOrderId === order.orderId}>{cancellingOrderId === order.orderId ? '撤销中…' : '撤单'}</button></td></tr>)}</tbody></table></div> : <div className="empty-state"><div className="empty-icon">⌁</div><div><b>暂无当前委托</b><span>交易对 {active} 的未完成订单会显示在这里</span></div></div> : bottomTab === 'history' ? orderHistory.length ? <div className="account-table-wrap"><table className="account-table"><thead><tr><th>交易对 / 方向</th><th>订单类型</th><th>价格 / 触发价</th><th>数量 / 已成交</th><th>状态</th><th>更新时间</th></tr></thead><tbody>{orderHistory.map((order) => <tr key={`${order.symbol}-${order.orderId}`}><td><b>{order.symbol}</b><small className={order.side === 'BUY' ? 'up' : 'down'}>{order.side === 'BUY' ? '买入' : '卖出'}</small></td><td>{orderTypeLabel(order.type)}</td><td>{formatOrderPrice(order)}</td><td>{formatPrice(order.origQty)} / {formatPrice(order.executedQty)}</td><td>{orderStatusLabel(order.status)}</td><td>{formatOrderTime(order.updateTime || order.time)}</td></tr>)}</tbody></table></div> : <div className="empty-state"><div className="empty-icon">⌁</div><div><b>暂无历史订单</b><span>历史记录按当前交易对 {active} 查询</span></div></div> : trades.length ? <div className="account-table-wrap"><table className="account-table"><thead><tr><th>交易对 / 方向</th><th>方向</th><th>成交价</th><th>数量</th><th>时间</th></tr></thead><tbody>{trades.map((trade) => <tr key={trade.id}><td><b>{trade.symbol}</b><small>{trade.positionSide === 'LONG' ? '多仓' : trade.positionSide === 'SHORT' ? '空仓' : '单向'}</small></td><td className={trade.side === 'BUY' ? 'up' : 'down'}>{trade.side === 'BUY' ? '买入' : '卖出'}</td><td>{formatPrice(trade.price)}</td><td>{formatPrice(trade.qty)}</td><td>{formatOrderTime(trade.time)}</td></tr>)}</tbody></table></div> : <div className="empty-state"><div className="empty-icon">⌁</div><div><b>暂无成交记录</b><span>成交记录按当前交易对 {active} 查询，Binance 仅支持近 3 个月</span></div></div>}
    </section>}
    {managePosition && <div className="position-modal-backdrop" onClick={() => setManagePosition(null)}><div className="position-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><div className="position-modal-head"><div><span className="eyebrow">POSITION MANAGEMENT</span><h3>{managePosition.symbol} · {managePosition.positionSide === 'SHORT' ? '空仓' : '多仓'}</h3></div><button type="button" onClick={() => setManagePosition(null)} aria-label="关闭">×</button></div><div className="position-snapshot"><span>数量 <b>{formatPrice(Math.abs(managePosition.positionAmt))}</b></span><span>开仓均价 <b>{formatPrice(managePosition.entryPrice)}</b></span><span>强平价格 <b>{formatPrice(managePosition.liquidationPrice)}</b></span></div><div className="position-modal-grid"><label>止损价格<input type="number" min="0" step="any" value={manageStopLoss} onChange={(event) => { setManageStopLoss(event.target.value); setManageStopLossChanged(true) }} /><small>留空则清除保护单</small></label><label>止盈价格<input type="number" min="0" step="any" value={manageTakeProfit} onChange={(event) => { setManageTakeProfit(event.target.value); setManageTakeProfitChanged(true) }} /><small>留空则清除保护单</small></label></div><button type="button" className="manage-primary" onClick={() => void submitManage()} disabled={manageBusy}>{manageBusy ? '提交中…' : '保存止盈止损'}</button><div className="partial-close"><div className="partial-close-head"><span>部分平仓比例</span><b>{manageClosePercent}%</b></div><div className="partial-close-quantity">预计平仓数量 <b>{partialCloseQuantity(managePosition.positionAmt, manageClosePercent, symbolRules[managePosition.symbol]?.marketStepSize ?? symbolRules[managePosition.symbol]?.stepSize ?? '1')}</b></div><input className="binance-range" style={{ '--range-progress': `${manageClosePercent}%` } as React.CSSProperties} type="range" min="0" max="100" step="1" value={manageClosePercent} onChange={(event) => { const percent = Number(event.target.value); setManageClosePercent(percent); setManageQuantity(partialCloseQuantity(managePosition.positionAmt, percent, symbolRules[managePosition.symbol]?.marketStepSize ?? symbolRules[managePosition.symbol]?.stepSize ?? '1')) }} /><div className="partial-close-scale"><span>快速选择</span><div className="range-marks">{[25, 50, 75, 100].map((percent) => <button type="button" key={percent} className={manageClosePercent === percent ? 'selected' : ''} onClick={() => { setManageClosePercent(percent); setManageQuantity(partialCloseQuantity(managePosition.positionAmt, percent, symbolRules[managePosition.symbol]?.marketStepSize ?? symbolRules[managePosition.symbol]?.stepSize ?? '1')) }}>{percent}%</button>)}</div></div><div className="partial-close-actions"><button type="button" className="partial-button" onClick={() => void closeManagedPosition(false)} disabled={manageBusy || manageClosePercent <= 0}>部分平仓</button><button type="button" className="close-all-button" onClick={() => void closeManagedPosition(true)} disabled={manageBusy}>全部平仓</button></div></div>{manageMessage && <div className="order-message" role="status">{manageMessage}</div>}<small className="position-modal-note">止盈止损将替换该方向同类保护单；清空已存在的价格可移除对应保护单。</small></div></div>}
    <nav className="mobile-nav"><button className={workspaceView === 'markets' ? 'active' : ''} onClick={() => setWorkspaceView('markets')}>⌂<span>交易</span></button><button className={workspaceView === 'training' ? 'active' : ''} onClick={() => setWorkspaceView('training')}>◈<span>模型训练</span></button><button className={mobileMarketsOpen ? 'active' : ''} onClick={() => setMobileMarketsOpen(true)}>⌁<span>行情</span></button><button className={tab === 'order' && !mobileMarketsOpen ? 'active' : ''} onClick={() => { setWorkspaceView('markets'); setTab('order'); document.getElementById('trade-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>＋<span>下单</span></button><button className={tab === 'ai' && !mobileMarketsOpen ? 'active' : ''} onClick={() => { setWorkspaceView('markets'); setTab('ai'); document.getElementById('trade-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>✦<span>AI 解释层</span></button><button onClick={() => { setWorkspaceView('markets'); document.querySelector('.bottom-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>☻<span>账户</span></button></nav>
  </div>
}

export default App


