import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import LiveChart from './LiveChart'
import { analyzeMarket } from './marketAnalysis'

type Candle = { time: number; open: number; high: number; low: number; close: number }
type Tool = 'cursor' | 'horizontal' | 'trend'
type Line = { id: number; price: number; label: string; color: string }
type Trend = { id: number; start: { time: number; price: number }; end: { time: number; price: number } }
type Health = { privateApiConfigured: boolean; tradingEnabled: boolean; aiConfigured: boolean }
type MarketQuote = { price: number; change: number }
type Interval = '1h' | '4h' | '1d'

type SymbolInfo = { symbol: string; name: string; icon: string; color: string }
const symbols: SymbolInfo[] = [
  { symbol: 'BTCUSDT', name: 'Bitcoin', icon: '₿', color: '#f7931a' },
  { symbol: 'ETHUSDT', name: 'Ethereum', icon: '◆', color: '#627eea' },
  { symbol: 'SOLUSDT', name: 'Solana', icon: '≋', color: '#8b5cf6' },
  { symbol: 'BNBUSDT', name: 'BNB', icon: '◆', color: '#e8b923' },
  { symbol: 'XRPUSDT', name: 'XRP', icon: '✕', color: '#111827' },
]
const defaultLines: Line[] = []
function formatPrice(value: number | null) {
  return value === null || !Number.isFinite(value) ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: value > 100 ? 2 : 5 })
}

const KLINE_PAGE_SIZE = 1000

async function requestKlines(symbol: string, interval: Interval, endTime?: number) {
  const params = new URLSearchParams({ symbol, interval, limit: String(KLINE_PAGE_SIZE) })
  if (endTime !== undefined) params.set('endTime', String(endTime))
  const query = params.toString()
  try {
    const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?${query}`)
    if (!response.ok) throw new Error(`Binance 行情请求失败：${response.status}`)
    return await response.json() as unknown[][]
  } catch {
    const response = await fetch(`/api/market/klines?${query}`)
    if (!response.ok) throw new Error(`Binance 行情请求失败：${response.status}`)
    return await response.json() as unknown[][]
  }
}

function parseKlines(rows: unknown[][]): Candle[] {
  return rows.map((row) => ({ time: Number(row[0]) / 1000, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }))
}

function App() {
  const [active, setActive] = useState('BTCUSDT')
  const [price, setPrice] = useState<number | null>(null)
  const [change, setChange] = useState<number | null>(null)
  const [marketQuotes, setMarketQuotes] = useState<Record<string, MarketQuote>>({})
  const [candles, setCandles] = useState<Candle[]>([])
  const [interval, setInterval] = useState<Interval>('1h')
  const [hasOlderCandles, setHasOlderCandles] = useState(true)
  const [loadingOlderCandles, setLoadingOlderCandles] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [tool, setTool] = useState<Tool>('cursor')
  const [analysisOpen, setAnalysisOpen] = useState(false)
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
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<string[]>(['你好，我会结合当前行情、自动分析结果和你绘制的趋势线回答问题。'])
  const [health, setHealth] = useState<Health>({ privateApiConfigured: false, tradingEnabled: false, aiConfigured: false })
  const [orderMessage, setOrderMessage] = useState('')
  const [accountBalance, setAccountBalance] = useState<string | null>(null)
  const historyRequestId = useRef(0)
  const tickerMessageAt = useRef<Record<string, number>>({})
  const loadingOlderRef = useRef(false)
  const hasOlderRef = useRef(true)
  const retryAfterRef = useRef(0)
  const selected = symbols.find((item) => item.symbol === active) ?? symbols[0]
  const lines = storedLines[active] ?? defaultLines
  const trends = storedTrends[active] ?? []

  useEffect(() => {
    fetch('/api/health').then((response) => response.ok ? response.json() as Promise<Health> : null).then((value) => value && setHealth(value)).catch(() => undefined)
  }, [])

  useEffect(() => {
    const symbolsQuery = symbols.map((item) => item.symbol).join(',')
    const loadQuotes = async () => {
      try {
        const response = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr')
        if (!response.ok) throw new Error('公共行情请求失败')
        return await response.json() as Array<{ symbol: string; lastPrice: string; priceChangePercent: string }>
      } catch {
        const response = await fetch('/api/market/tickers')
        if (!response.ok) throw new Error('公共行情请求失败')
        return await response.json() as Array<{ symbol: string; lastPrice: string; priceChangePercent: string }>
      }
    }
    loadQuotes().then((rows) => {
      const allowed = new Set(symbolsQuery.split(','))
      const next = rows.filter((row) => allowed.has(row.symbol)).reduce<Record<string, MarketQuote>>((current, row) => ({ ...current, [row.symbol]: { price: Number(row.lastPrice), change: Number(row.priceChangePercent) } }), {})
      setMarketQuotes((current) => ({ ...next, ...current }))
    }).catch(() => undefined)
  }, [])

  useEffect(() => {
    const requestId = ++historyRequestId.current
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let socket: WebSocket | null = null
    let reconnectAttempt = 0
    setLoading(true); setConnected(false); setPrice(null); setChange(null); setCandles([]); setOrderMessage('')
    loadingOlderRef.current = false
    hasOlderRef.current = true
    retryAfterRef.current = 0
    setHasOlderCandles(true)
    setLoadingOlderCandles(false)
    setHistoryError('')

    const mergeCandles = (incoming: Candle[], replaceExisting = false) => {
      if (!incoming.length || cancelled) return
      setCandles((current) => {
        const merged = new Map(current.map((candle) => [candle.time, candle]))
        incoming.forEach((candle) => { if (replaceExisting || !merged.has(candle.time)) merged.set(candle.time, candle) })
        return [...merged.values()].sort((left, right) => left.time - right.time)
      })
    }
    requestKlines(active, interval)
      .then((rows) => { if (!cancelled) { const parsed = parseKlines(rows); mergeCandles(parsed); hasOlderRef.current = parsed.length === KLINE_PAGE_SIZE; setHasOlderCandles(hasOlderRef.current) } })
      .catch(() => { if (!cancelled) setCandles([]) })
      .finally(() => { if (!cancelled) setLoading(false) })

    const streams = symbols.map((item) => `${item.symbol.toLowerCase()}@ticker`).join('/')
    const streamUrl = `wss://fstream.binance.com/stream?streams=${streams}/${active.toLowerCase()}@kline_${interval}`
    const connect = () => {
      if (cancelled) return
      socket = new WebSocket(streamUrl)
      socket.onopen = () => { reconnectAttempt = 0; if (!cancelled) setConnected(true) }
      socket.onmessage = (event) => {
        try {
          const envelope = JSON.parse(event.data) as { data?: { e?: string; s?: string; c?: string; P?: string; k?: { s?: string; i?: string; t: number; o: string; h: string; l: string; c: string } }; s?: string; c?: string; P?: string; k?: { s?: string; i?: string; t: number; o: string; h: string; l: string; c: string } }
          const data = (envelope.data ?? envelope) as typeof envelope
          if (data.k) {
            // 只接收当前交易对和周期，按开盘时间更新正在形成的K线。
            if (data.k.s?.toUpperCase() !== active || data.k.i !== interval) return
            mergeCandles([{ time: data.k.t / 1000, open: Number(data.k.o), high: Number(data.k.h), low: Number(data.k.l), close: Number(data.k.c) }], true)
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
      socket.onerror = () => { if (!cancelled) setConnected(false) }
      socket.onclose = () => {
        if (cancelled) return
        setConnected(false)
        // 断线后先用 REST 补齐最近K线，再指数退避重连 WebSocket。
        requestKlines(active, interval).then((rows) => mergeCandles(parseKlines(rows))).catch(() => undefined)
        reconnectAttempt += 1
        const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt, 5))
        reconnectTimer = setTimeout(connect, delay)
      }
    }
    connect()
    return () => { cancelled = true; if (reconnectTimer) clearTimeout(reconnectTimer); socket?.close(); if (requestId === historyRequestId.current) historyRequestId.current += 1 }
  }, [active, interval])
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const refreshPrice = async () => {
      try {
        if (Date.now() - (tickerMessageAt.current[active] ?? 0) < 5000) return
        let quote: { price?: string; lastPrice?: string; priceChangePercent?: string }
        try {
          const response = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${active}`)
          if (!response.ok) throw new Error('Binance 行情请求失败')
          quote = await response.json() as typeof quote
        } catch {
          const response = await fetch(`/api/market/ticker?symbol=${active}`)
          if (!response.ok) throw new Error('Binance 行情请求失败')
          quote = await response.json() as typeof quote
        }
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
    if (!health.privateApiConfigured) return
    fetch('/api/account').then((response) => response.ok ? response.json() as Promise<{ availableBalance: string }> : Promise.reject(new Error('Account unavailable'))).then((data) => setAccountBalance(data.availableBalance)).catch(() => setAccountBalance(null))
  }, [health.privateApiConfigured])

  const activeQuote = marketQuotes[active]
  const last = activeQuote?.price ?? price ?? candles[candles.length - 1]?.close ?? null
  const activeChange = activeQuote?.change ?? change
  // 自动分析以最近已收盘 K 线为准，避免盘中价格变化让分析线频繁跳动。
  const analysis = analyzeMarket(candles)
  const updateLines = (next: Line[]) => setStoredLines((all) => ({ ...all, [active]: next }))
  const updateTrends = (next: Trend[]) => setStoredTrends((all) => ({ ...all, [active]: next }))
  const analysisLines: Line[] = useMemo(() => [
    ...(analysis.support === null ? [] : [{ id: -101, price: analysis.support, label: '程序支撑', color: '#22a06b' }]),
    ...(analysis.resistance === null ? [] : [{ id: -102, price: analysis.resistance, label: '程序阻力', color: '#d19a32' }]),
    ...(analysis.stopLoss === null ? [] : [{ id: -103, price: analysis.stopLoss, label: '程序止损', color: '#ef6a6a' }]),
    ...(analysis.takeProfit === null ? [] : [{ id: -104, price: analysis.takeProfit, label: '程序止盈', color: '#4f8bd6' }]),
  ], [analysis.support, analysis.resistance, analysis.stopLoss, analysis.takeProfit])
  const displayLines = useMemo(() => [...analysisLines, ...lines], [analysisLines, lines])
  const addTrend = (start: Trend['start'], end: Trend['end']) => { updateTrends([...trends, { id: Date.now(), start, end }]); setTool('cursor') }
  const removeLine = (id: number) => updateLines(lines.filter((line) => line.id !== id))

  const submitOrder = async () => {
    setOrderMessage('正在提交订单…')
    try {
      const response = await fetch('/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: active, side: side === 'buy' ? 'BUY' : 'SELL', type: 'LIMIT', quantity: qty, price: last?.toString() }) })
      const data = await response.json() as { error?: string; orderId?: number }
      if (!response.ok) throw new Error(data.error ?? '订单被拒绝')
      setOrderMessage(`订单已提交 · #${data.orderId ?? '—'}`)
    } catch (error) { setOrderMessage(error instanceof Error ? error.message : '订单提交失败') }
  }

  const ask = async () => {
    const prompt = question.trim()
    if (!prompt) return
    setMessages((current) => [...current, `你：${prompt}`]); setQuestion('')
    try {
      const response = await fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: prompt, context: { symbol: active, interval, price: last, analysis: { environment: analysis.environment, direction: analysis.direction, status: analysis.status, entry: analysis.entry, support: analysis.support, resistance: analysis.resistance, stopLoss: analysis.stopLoss, takeProfit: analysis.takeProfit, riskReward: analysis.rr }, lines: [...analysisLines, ...lines].map(({ label, price: value }) => ({ label, price: value })) } }) })
      const data = await response.json() as { answer?: string; error?: string }
      if (!response.ok) throw new Error(data.error ?? 'AI 服务不可用')
      setMessages((current) => [...current, `AI：${data.answer ?? '没有得到有效回复。'}`])
    } catch (error) { setMessages((current) => [...current, `AI：${error instanceof Error ? error.message : '请求失败，请检查 OpenAI 兼容接口配置。'}`]) }
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">K</div><div><strong>KEEL</strong><span>TRADING DESK</span></div></div>
      <div className="top-actions"><div className={`connection ${connected ? 'online' : ''}`}><i />{connected ? 'Binance 永续已连接' : '正在连接 Binance'}</div><button className="icon-btn">⌘ K</button><div className="avatar">JD</div></div>
    </header>
    <main className="workspace">
      <aside className="watchlist panel"><div className="panel-head"><div><span className="eyebrow">MARKETS</span><h2>自选行情</h2></div><button className="plus">＋</button></div><div className="search">⌕ <input placeholder="搜索交易对" /></div><div className="watch-items">{symbols.map((item) => { const quote = marketQuotes[item.symbol]; return <button key={item.symbol} className={`watch-item ${active === item.symbol ? 'active' : ''}`} onClick={() => setActive(item.symbol)}><span className="coin-icon" style={{ background: item.color }}>{item.icon}</span><span className="coin-name"><b>{item.symbol.replace('USDT', '')}<small>/USDT</small></b><small>{item.name}</small></span><span className="coin-price">{formatPrice(quote?.price ?? null)}<small className={quote && quote.change < 0 ? 'down' : 'up'}>{quote ? `${quote.change >= 0 ? '+' : ''}${quote.change.toFixed(2)}%` : '—'}</small></span></button> })}</div><div className="watch-footer"><span>合约市场</span><b>USⓈ-M Futures</b></div></aside>
      <section className="chart-section panel"><div className="chart-head"><div className="pair-title"><span className="coin-icon large" style={{ background: selected.color }}>{selected.icon}</span><div><button type="button" className="auto-analysis-label" onClick={() => setAnalysisOpen(true)}>自动分析 · {analysis.environment}<span>⌄</span></button><h1>{active.replace('USDT', '')}<small>/ USDT · 永续</small></h1><div className="live-price">{formatPrice(last)} <span className={activeChange !== null && activeChange < 0 ? 'down' : 'up'}>{activeChange !== null ? `${activeChange >= 0 ? '+' : ''}${activeChange.toFixed(2)}%` : '—'}</span></div></div></div><div className="chart-meta">{(['1h', '4h', '1d'] as Interval[]).map((value) => <button key={value} className={interval === value ? 'time-active' : ''} onClick={() => setInterval(value)}>{value.toUpperCase()}</button>)}<span className="divider" /><button>⌁ 指标</button><button>⋮</button></div></div><div className="analysis-summary"><span className="regime-badge">{analysis.environment}</span><span className={`direction-badge ${analysis.direction === '做多' ? 'long' : analysis.direction === '做空' ? 'short' : ''}`}>{analysis.direction}</span><span className="analysis-status">{analysis.status}</span><b>支撑 {formatPrice(analysis.support)} · 阻力 {formatPrice(analysis.resistance)}</b><b>止损 {formatPrice(analysis.stopLoss)} · 止盈 {formatPrice(analysis.takeProfit)}</b></div><div className="chart-toolbar"><button className={tool === 'cursor' ? 'selected' : ''} onClick={() => setTool('cursor')}>↖ 选择</button><button className={tool === 'trend' ? 'selected' : ''} onClick={() => setTool('trend')}>╱ 手动画线</button><span className="toolbar-spacer" /><span className={`chart-status ${connected ? 'online' : ''}`}><i />{connected ? '实时行情 · Binance' : '行情连接中'}</span></div><div className="chart-wrap"><LiveChart key={`${active}-${interval}`} data={candles} livePrice={last} levels={displayLines} trends={trends} tool={tool} levelLabel={levelLabel} onAddLevel={(value) => { updateLines([...lines, { id: Date.now(), price: value, label: '手动标记', color: '#7c8794' }]); setTool('cursor') }} onAddTrend={addTrend} onRemoveLevel={removeLine} onLoadOlder={loadOlderCandles} />{loading && <div className="chart-empty">正在读取 Binance {interval.toUpperCase()} K 线…</div>}{!loading && candles.length === 0 && <div className="chart-empty">暂时没有 K 线数据<br /><small>请检查网络连接状态</small></div>}</div><div className="chart-footer"><span>{loadingOlderCandles ? '正在加载更早的 K 线…' : historyError || (hasOlderCandles ? '向左拖动图表，自动加载更早的 K 线' : '已到可用历史数据起点')} · 共 {candles.length.toLocaleString()} 根 {interval.toUpperCase()}</span><span>自动分析线 · Binance USDⓈ-M · {connected ? '实时' : '等待连接'}</span></div>{analysisOpen && <div className="analysis-modal-backdrop" onClick={() => setAnalysisOpen(false)}><div className="analysis-modal" onClick={(event) => event.stopPropagation()}><div className="analysis-modal-head"><div><span className="eyebrow">MARKET READ</span><h3>{active.replace('USDT', '/USDT')} · {interval.toUpperCase()}</h3></div><button type="button" onClick={() => setAnalysisOpen(false)} aria-label="关闭">×</button></div><div className="analysis-modal-state"><span className={`direction-badge ${analysis.direction === '做多' ? 'long' : analysis.direction === '做空' ? 'short' : ''}`}>{analysis.direction}</span><b>{analysis.environment}</b></div><p>{analysis.status}</p><div className="analysis-values"><div><small>参考入场</small><b>{formatPrice(analysis.entry)}</b></div><div><small>支撑位</small><b>{formatPrice(analysis.support)}</b></div><div><small>阻力位</small><b>{formatPrice(analysis.resistance)}</b></div><div><small>止损</small><b>{formatPrice(analysis.stopLoss)}</b></div><div><small>止盈</small><b>{formatPrice(analysis.takeProfit)}</b></div><div><small>参考盈亏比</small><b>{analysis.rr === null ? '—' : `1:${analysis.rr.toFixed(1)}`}</b></div></div><div className="analysis-modal-foot">依据已收盘 K 线自动计算；分析线只作参考，不会自动下单。</div></div></div>}</section>
      <aside className="trade-panel panel"><div className="tabs"><button className={tab === 'order' ? 'active' : ''} onClick={() => setTab('order')}>下单</button><button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>AI 助手 <span className="new-dot" /></button></div>{tab === 'order' ? <div className="order-content"><div className="order-mode"><button className={side === 'buy' ? 'buy active' : ''} onClick={() => setSide('buy')}>做多 / 买入</button><button className={side === 'sell' ? 'sell active' : ''} onClick={() => setSide('sell')}>做空 / 卖出</button></div><div className="order-meta"><span>可用保证金</span><b>{accountBalance ?? '—'} <small>USDT</small></b><button>充值</button></div><label>订单类型<select><option>限价单</option><option>市价单</option></select></label><label>价格<div className="input-unit"><input value={last?.toFixed(2) ?? ''} readOnly placeholder="等待行情" /><span>USDT</span></div></label><label>数量<div className="input-unit"><input value={qty} onChange={(event) => setQty(event.target.value)} /><span>{active.replace('USDT', '')}</span></div></label><div className="slider"><span /><i /><i /><i /><i /></div><div className="risk-row"><div><span>程序止损</span><button className="readonly-risk">{formatPrice(analysis.stopLoss)}</button></div><div><span>程序止盈</span><button className="readonly-risk">{formatPrice(analysis.takeProfit)}</button></div></div><div className="risk-note">分析方向 <b>{analysis.direction}</b><span>参考盈亏比 {analysis.rr === null ? '—' : `1:${analysis.rr.toFixed(1)}`}</span></div><button className={`submit ${side}`} onClick={submitOrder}>{side === 'buy' ? '买入 / 做多' : '卖出 / 做空'}</button>{orderMessage && <div className="order-message">{orderMessage}</div>}<div className="api-note"><span>⌁</span><div><b>{health.tradingEnabled ? '实盘交易已启用' : '实盘交易未启用'}</b><small>{health.privateApiConfigured ? (health.tradingEnabled ? '订单将经过本地后端签名后提交' : 'API 已配置，但安全开关仍为关闭') : '请在后端配置 Binance API Key 后启用下单'}</small></div></div></div> : <div className="ai-content"><div className="ai-intro"><div className="ai-spark">✦</div><h3>交易助手</h3><p>结合当前图表、自动分析和手动画线，帮你梳理交易计划。</p></div><div className="messages">{messages.map((message, index) => <div className={message.startsWith('你：') ? 'message user' : 'message'} key={`${message}-${index}`}>{message}</div>)}</div><div className="quick-prompts"><button onClick={() => setQuestion('当前支撑和止损位置合理吗？')}>支撑位合理吗？</button><button onClick={() => setQuestion('帮我梳理这个交易计划')}>梳理交易计划</button></div><div className="ai-input"><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="问问关于当前图表的问题..." /><button onClick={ask}>↑</button></div><small className="ai-disclaimer">AI 仅提供信息参考，不构成投资建议，也不会自动下单。</small></div>}</aside>
    </main>
    <section className="bottom-panel panel"><div className="bottom-tabs"><button className="active">持仓 <span>0</span></button><button>当前委托 <span>0</span></button><button>历史订单</button><span className="bottom-spacer" /><span className="account-state"><i />{health.privateApiConfigured ? '私有 API 已配置' : '未连接私有 API'}</span></div><div className="empty-state"><div className="empty-icon">⌁</div><div><b>暂无持仓</b><span>{health.privateApiConfigured ? '账户没有可展示的持仓' : '连接 Binance 私有 API 后，持仓和订单会显示在这里'}</span></div><button>查看配置说明 →</button></div></section>
    <nav className="mobile-nav"><button className="active">⌂<span>交易</span></button><button>⌁<span>行情</span></button><button>＋<span>下单</span></button><button onClick={() => setTab('ai')}>✦<span>AI 助手</span></button><button>☻<span>账户</span></button></nav>
  </div>
}

export default App
