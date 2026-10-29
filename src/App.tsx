import { useEffect, useState } from 'react'
import './App.css'
import LiveChart from './LiveChart'

type Candle = { time: number; open: number; high: number; low: number; close: number }
type Tool = 'cursor' | 'horizontal' | 'trend'
type Line = { id: number; price: number; label: string; color: string }
type Trend = { id: number; start: { time: number; price: number }; end: { time: number; price: number } }
type Health = { privateApiConfigured: boolean; tradingEnabled: boolean; aiConfigured: boolean }
type MarketQuote = { price: number; change: number }

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

function App() {
  const [active, setActive] = useState('BTCUSDT')
  const [price, setPrice] = useState<number | null>(null)
  const [change, setChange] = useState<number | null>(null)
  const [marketQuotes, setMarketQuotes] = useState<Record<string, MarketQuote>>({})
  const [candles, setCandles] = useState<Candle[]>([])
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [tool, setTool] = useState<Tool>('cursor')
  const [storedLines, setStoredLines] = useState<Record<string, Line[]>>(() => {
    try { return JSON.parse(localStorage.getItem('keel-lines') ?? '{}') as Record<string, Line[]> } catch { return {} }
  })
  const [storedTrends, setStoredTrends] = useState<Record<string, Trend[]>>(() => {
    try { return JSON.parse(localStorage.getItem('keel-trends') ?? '{}') as Record<string, Trend[]> } catch { return {} }
  })
  const [levelLabel, setLevelLabel] = useState('支撑位')
  const [tab, setTab] = useState<'order' | 'ai'>('order')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [qty, setQty] = useState('0.01')
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<string[]>(['你好，我会基于当前图表和你选择的画线回答问题。'])
  const [health, setHealth] = useState<Health>({ privateApiConfigured: false, tradingEnabled: false, aiConfigured: false })
  const [orderMessage, setOrderMessage] = useState('')
  const [accountBalance, setAccountBalance] = useState<string | null>(null)
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
    let cancelled = false
    setLoading(true); setConnected(false); setPrice(null); setChange(null); setCandles([]); setOrderMessage('')
    const query = `symbol=${active}&interval=1h&limit=42`
    const loadKlines = async () => {
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
    loadKlines()
      .then((rows) => { if (!cancelled) setCandles(rows.map((row) => ({ time: Number(row[0]) / 1000, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }))) })
      .catch(() => { if (!cancelled) setCandles([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    const streams = symbols.map((item) => `${item.symbol.toLowerCase()}@ticker`).join('/')
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`)
    ws.onopen = () => { if (!cancelled) setConnected(true) }
    ws.onmessage = (event) => {
      const envelope = JSON.parse(event.data) as { data?: { s?: string; c?: string; P?: string }; s?: string; c?: string; P?: string }
      const data = envelope.data ?? envelope
      const symbol = data.s?.toUpperCase()
      if (!cancelled && symbol && data.c) {
        const quote = { price: Number(data.c), change: data.P ? Number(data.P) : 0 }
        setMarketQuotes((current) => ({ ...current, [symbol]: quote }))
        if (symbol === active) { setPrice(quote.price); setChange(quote.change) }
      }
    }
    ws.onerror = () => { if (!cancelled) setConnected(false) }
    ws.onclose = () => { if (!cancelled) setConnected(false) }
    return () => { cancelled = true; ws.close() }
  }, [active])

  useEffect(() => { localStorage.setItem('keel-lines', JSON.stringify(storedLines)) }, [storedLines])
  useEffect(() => { localStorage.setItem('keel-trends', JSON.stringify(storedTrends)) }, [storedTrends])

  useEffect(() => {
    if (!health.privateApiConfigured) return
    fetch('/api/account').then((response) => response.ok ? response.json() as Promise<{ availableBalance: string }> : Promise.reject(new Error('Account unavailable'))).then((data) => setAccountBalance(data.availableBalance)).catch(() => setAccountBalance(null))
  }, [health.privateApiConfigured])

  const activeQuote = marketQuotes[active]
  const last = activeQuote?.price ?? price ?? candles[candles.length - 1]?.close ?? null
  const activeChange = activeQuote?.change ?? change
  const updateLines = (next: Line[]) => setStoredLines((all) => ({ ...all, [active]: next }))
  const updateTrends = (next: Trend[]) => setStoredTrends((all) => ({ ...all, [active]: next }))
  const addLevelAtCurrent = () => { if (last !== null) { updateLines([...lines, { id: Date.now(), price: last, label: levelLabel, color: levelLabel === '止损' ? '#ef6a6a' : '#22a06b' }]); setTool('cursor') } }
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
      const response = await fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: prompt, context: { symbol: active, interval: '1h', price: last, lines: lines.map(({ label, price: value }) => ({ label, price: value })) } }) })
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
      <section className="chart-section panel"><div className="chart-head"><div className="pair-title"><span className="coin-icon large" style={{ background: selected.color }}>{selected.icon}</span><div><h1>{active.replace('USDT', '')}<small>/ USDT · 永续</small></h1><div className="live-price">{formatPrice(last)} <span className={activeChange !== null && activeChange < 0 ? 'down' : 'up'}>{activeChange !== null ? `${activeChange >= 0 ? '+' : ''}${activeChange.toFixed(2)}%` : '—'}</span></div></div></div><div className="chart-meta"><button className="time-active">1H</button><button>4H</button><button>1D</button><span className="divider" /><button>⌁ 指标</button><button>⋮</button></div></div><div className="chart-toolbar"><button className={tool === 'cursor' ? 'selected' : ''} onClick={() => setTool('cursor')}>↖ 选择</button><button className={tool === 'horizontal' ? 'selected' : ''} onClick={() => { setLevelLabel('支撑位'); setTool('horizontal') }}>— 支撑位</button><button className={tool === 'horizontal' && levelLabel === '止损' ? 'selected danger-tool' : ''} onClick={() => { setLevelLabel('止损'); setTool('horizontal') }}>— 止损</button><button className={tool === 'trend' ? 'selected' : ''} onClick={() => setTool('trend')}>╱ 趋势线</button><button onClick={addLevelAtCurrent}>＋ 当前价</button><span className="toolbar-spacer" /><span className={`chart-status ${connected ? 'online' : ''}`}><i />{connected ? '实时行情 · Binance' : '行情连接中'}</span></div><div className="chart-wrap"><LiveChart data={candles} levels={lines} trends={trends} tool={tool} levelLabel={levelLabel} onAddLevel={(value) => { updateLines([...lines, { id: Date.now(), price: value, label: levelLabel, color: levelLabel === '止损' ? '#ef6a6a' : '#22a06b' }]); setTool('cursor') }} onAddTrend={addTrend} onRemoveLevel={removeLine} />{loading && <div className="chart-empty">正在读取币安真实 K 线…</div>}{!loading && candles.length === 0 && <div className="chart-empty">暂时没有 K 线数据<br /><small>检查网络或 Binance 连接状态</small></div>}</div><div className="chart-footer"><span>双击画线可删除 · 画线保存于本地设备</span><span>Binance USDⓈ-M · {connected ? '实时' : '等待连接'}</span></div></section>
      <aside className="trade-panel panel"><div className="tabs"><button className={tab === 'order' ? 'active' : ''} onClick={() => setTab('order')}>下单</button><button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>AI 助手 <span className="new-dot" /></button></div>{tab === 'order' ? <div className="order-content"><div className="order-mode"><button className={side === 'buy' ? 'buy active' : ''} onClick={() => setSide('buy')}>做多 / 买入</button><button className={side === 'sell' ? 'sell active' : ''} onClick={() => setSide('sell')}>做空 / 卖出</button></div><div className="order-meta"><span>可用保证金</span><b>{accountBalance ?? '—'} <small>USDT</small></b><button>充值</button></div><label>订单类型<select><option>限价单</option><option>市价单</option></select></label><label>价格<div className="input-unit"><input value={last?.toFixed(2) ?? ''} readOnly placeholder="等待行情" /><span>USDT</span></div></label><label>数量<div className="input-unit"><input value={qty} onChange={(event) => setQty(event.target.value)} /><span>{active.replace('USDT', '')}</span></div></label><div className="slider"><span /><i /><i /><i /><i /></div><div className="risk-row"><div><span>止损</span><button>{formatPrice(lines.find((line) => line.label === '止损')?.price ?? null)}</button></div><div><span>止盈</span><button>添加</button></div></div><div className="risk-note">预计风险 <b>— USDT</b><span>风险收益比 —</span></div><button className={`submit ${side}`} onClick={submitOrder}>{side === 'buy' ? '买入 / 做多' : '卖出 / 做空'}</button>{orderMessage && <div className="order-message">{orderMessage}</div>}<div className="api-note"><span>⌁</span><div><b>{health.tradingEnabled ? '实盘交易已启用' : '实盘交易未启用'}</b><small>{health.privateApiConfigured ? (health.tradingEnabled ? '订单将经过本地后端签名后提交' : 'API 已配置，但安全开关仍为关闭') : '请在后端配置 Binance API Key 后启用下单'}</small></div></div></div> : <div className="ai-content"><div className="ai-intro"><div className="ai-spark">✦</div><h3>交易助手</h3><p>结合当前图表、画线和行情，帮你梳理交易计划。</p></div><div className="messages">{messages.map((message, index) => <div className={message.startsWith('你：') ? 'message user' : 'message'} key={`${message}-${index}`}>{message}</div>)}</div><div className="quick-prompts"><button onClick={() => setQuestion('当前支撑和止损位置合理吗？')}>支撑位合理吗？</button><button onClick={() => setQuestion('帮我梳理这个交易计划')}>梳理交易计划</button></div><div className="ai-input"><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="问问关于当前图表的问题..." /><button onClick={ask}>↑</button></div><small className="ai-disclaimer">AI 仅提供信息参考，不构成投资建议，也不会自动下单。</small></div>}</aside>
    </main>
    <section className="bottom-panel panel"><div className="bottom-tabs"><button className="active">持仓 <span>0</span></button><button>当前委托 <span>0</span></button><button>历史订单</button><span className="bottom-spacer" /><span className="account-state"><i />{health.privateApiConfigured ? '私有 API 已配置' : '未连接私有 API'}</span></div><div className="empty-state"><div className="empty-icon">⌁</div><div><b>暂无持仓</b><span>{health.privateApiConfigured ? '账户没有可展示的持仓' : '连接 Binance 私有 API 后，持仓和订单会显示在这里'}</span></div><button>查看配置说明 →</button></div></section>
    <nav className="mobile-nav"><button className="active">⌂<span>交易</span></button><button>⌁<span>行情</span></button><button>＋<span>下单</span></button><button onClick={() => setTab('ai')}>✦<span>AI 助手</span></button><button>☻<span>账户</span></button></nav>
  </div>
}

export default App
