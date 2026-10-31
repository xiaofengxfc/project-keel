import { useEffect, useRef, useState } from 'react'
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type MouseEventParams, type SeriesMarker, type Time } from 'lightweight-charts'
import type { ChartIndicatorKey, TechnicalIndicatorSet } from './technicalIndicators'

type Candle = { time: number; open: number; high: number; low: number; close: number }
type Level = { id: number; price: number; label: string; color: string; deletable?: boolean }
type Trend = { id: number; start: { time: number; price: number }; end: { time: number; price: number } }
type Trade = { id: number; side: 'BUY' | 'SELL'; price: number; time: number }
type Tool = 'cursor' | 'horizontal' | 'trend'

type Props = {
  data: Candle[]
  marketKey?: string
  currentPrice?: number | null
  trades?: Trade[]
  levels: Level[]
  trends: Trend[]
  indicators: TechnicalIndicatorSet
  enabledIndicators: Record<ChartIndicatorKey, boolean>
  tool: Tool
  levelLabel: string
  onAddLevel: (price: number) => void
  onAddTrend: (start: Trend['start'], end: Trend['end']) => void
  onRemoveLevel: (id: number) => void
  onRemoveTrend: (id: number) => void
  onLoadOlder: () => void
}

export default function LiveChart({ data, marketKey = '', currentPrice = null, trades = [], levels, trends, indicators, enabledIndicators, tool, levelLabel, onAddLevel, onAddTrend, onRemoveLevel, onRemoveTrend, onLoadOlder }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const trendOverlayRef = useRef<SVGSVGElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const priceLineRef = useRef<Map<number, IPriceLine>>(new Map())
  const currentPriceLineRef = useRef<IPriceLine | null>(null)
  const indicatorSeries = useRef<Map<string, ISeriesApi<'Line' | 'Histogram'>>>(new Map())
  const savedVisibleRange = useRef<{ from: number; to: number } | null>(null)
  const pendingTrend = useRef<Trend['start'] | null>(null)
  const previousData = useRef<Candle[]>([])
  const hasInitializedData = useRef(false)
  const toolRef = useRef(tool)
  const levelsRef = useRef(levels)
  const trendsRef = useRef(trends)
  const callbacks = useRef({ onAddLevel, onAddTrend, onRemoveLevel, onRemoveTrend, onLoadOlder })
  const [revision, setRevision] = useState(0)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    toolRef.current = tool
    levelsRef.current = levels
    trendsRef.current = trends
    callbacks.current = { onAddLevel, onAddTrend, onRemoveLevel, onRemoveTrend, onLoadOlder }
  }, [levelLabel, levels, onAddLevel, onAddTrend, onRemoveLevel, onRemoveTrend, onLoadOlder, tool, trends])

  useEffect(() => {
    const element = host.current
    if (!element) return
    const indicatorSeriesMap = indicatorSeries.current
    const priceLineMap = priceLineRef.current
    const chart = createChart(element, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#94a0ad', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: '#f0f2f5' }, horzLines: { color: '#edf0f3' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#b9c4ce', style: LineStyle.Dashed, labelBackgroundColor: '#303c4a' }, horzLine: { color: '#b9c4ce', style: LineStyle.Dashed, labelBackgroundColor: '#303c4a' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 8 },
      localization: { locale: 'zh-CN', dateFormat: 'yyyy/MM/dd' },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#1b9b73', downColor: '#e07070', borderUpColor: '#1b9b73', borderDownColor: '#e07070', wickUpColor: '#1b9b73', wickDownColor: '#e07070',
      priceLineVisible: false, lastValueVisible: false,
    })
    chartRef.current = chart
    seriesRef.current = series
    markersRef.current = createSeriesMarkers(series, [])
    const addLine = (key: string, color: string, paneIndex = 0, lineWidth: 1 | 2 = 2) => {
      const line = chart.addSeries(LineSeries, { color, lineWidth, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, paneIndex)
      indicatorSeriesMap.set(key, line)
    }
    if (enabledIndicators.ema20) addLine('ema20', '#e79a32')
    if (enabledIndicators.ema50) addLine('ema50', '#7c69d5')
    if (enabledIndicators.sma200) addLine('sma200', '#d85b67')
    if (enabledIndicators.bollinger) {
      addLine('bollingerUpper', '#6696d8', 0, 1)
      addLine('bollingerMiddle', '#6696d8', 0, 1)
      addLine('bollingerLower', '#6696d8', 0, 1)
    }
    if (enabledIndicators.vwap) addLine('vwap', '#27a380')
    if (enabledIndicators.volume) {
      chart.addPane(false).setHeight(76)
      const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false }, 1)
      volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } })
      indicatorSeriesMap.set('volume', volumeSeries)
    }
    const addIndicatorPane = (key: ChartIndicatorKey, height: number, series: Array<[string, string]>, histogram = false) => {
      const paneIndex = chart.panes().length
      chart.addPane(false).setHeight(height)
      series.forEach(([suffix, color]) => {
        const id = `${key}:${suffix}`
        if (histogram && suffix === 'histogram') {
          const created = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, paneIndex)
          indicatorSeriesMap.set(id, created)
        } else addLine(id, color, paneIndex, 1)
      })
    }
    if (enabledIndicators.rsi) addIndicatorPane('rsi', 92, [['value', '#7c69d5']])
    if (enabledIndicators.macd) addIndicatorPane('macd', 96, [['value', '#2588c7'], ['signal', '#e79a32'], ['histogram', '#8ebca8']], true)
    if (enabledIndicators.stochastic) addIndicatorPane('stochastic', 92, [['k', '#2588c7'], ['d', '#e79a32']])
    if (enabledIndicators.atr) addIndicatorPane('atr', 76, [['value', '#dc7a42']])
    if (enabledIndicators.adx) addIndicatorPane('adx', 76, [['value', '#735cc8'], ['plus', '#279780'], ['minus', '#df8585']])
    if (enabledIndicators.obv) addIndicatorPane('obv', 76, [['value', '#279780']])
    const clickHandler = (event: MouseEventParams<Time>) => {
      if (!event.point || event.time === undefined || !seriesRef.current) return
      const value = seriesRef.current.coordinateToPrice(event.point.y)
      if (value === null || typeof event.time !== 'number') return
      if (toolRef.current === 'horizontal') callbacks.current.onAddLevel(value)
      else if (toolRef.current === 'trend') {
        if (!pendingTrend.current) pendingTrend.current = { time: event.time, price: value }
        else { callbacks.current.onAddTrend(pendingTrend.current, { time: event.time, price: value }); pendingTrend.current = null }
      }
    }
    const findNearestLevel = (event: MouseEventParams<Time>) => {
      if (!event.point || !seriesRef.current) return
      const nearest = levelsRef.current.filter((item) => item.deletable !== false).reduce<{ id: number; distance: number } | null>((best, item) => {
        const coordinate = seriesRef.current?.priceToCoordinate(item.price)
        if (coordinate === null || coordinate === undefined) return best
        const distance = Math.abs(coordinate - event.point!.y)
        return distance <= 12 && (!best || distance < best.distance) ? { id: item.id, distance } : best
      }, null)
      if (nearest) callbacks.current.onRemoveLevel(nearest.id)
      return nearest
    }
    const findNearestTrend = (event: MouseEventParams<Time>) => {
      if (!event.point || !seriesRef.current) return
      const nearestTrend = trendsRef.current.reduce<{ id: number; distance: number } | null>((best, trend) => {
        const x1 = chart.timeScale().timeToCoordinate(trend.start.time as Time)
        const x2 = chart.timeScale().timeToCoordinate(trend.end.time as Time)
        const y1 = seriesRef.current?.priceToCoordinate(trend.start.price)
        const y2 = seriesRef.current?.priceToCoordinate(trend.end.price)
        if (x1 === null || x1 === undefined || x2 === null || x2 === undefined || y1 === null || y1 === undefined || y2 === null || y2 === undefined) return best
        const dx = x2 - x1
        const dy = y2 - y1
        const lengthSquared = dx * dx + dy * dy
        const projection = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((event.point!.x - x1) * dx + (event.point!.y - y1) * dy) / lengthSquared))
        const distance = Math.hypot(event.point!.x - (x1 + projection * dx), event.point!.y - (y1 + projection * dy))
        return distance <= 8 && (!best || distance < best.distance) ? { id: trend.id, distance } : best
      }, null)
      if (nearestTrend) callbacks.current.onRemoveTrend(nearestTrend.id)
      return nearestTrend
    }
    const doubleClickHandler = (event: MouseEventParams<Time>) => {
      if (toolRef.current !== 'cursor') return
      if (findNearestLevel(event)) return
      findNearestTrend(event)
    }
    chart.subscribeClick(clickHandler)
    chart.subscribeDblClick(doubleClickHandler)
    const redraw = () => setRevision((value) => value + 1)
    const onVisibleRangeChange = () => {
      redraw()
      const range = chart.timeScale().getVisibleLogicalRange()
      if (hasInitializedData.current && range && range.from < 24) callbacks.current.onLoadOlder()
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onVisibleRangeChange)
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setSize({ width: rect.width, height: rect.height })
      redraw()
    })
    observer.observe(element)
    return () => {
      savedVisibleRange.current = chart.timeScale().getVisibleLogicalRange() ?? savedVisibleRange.current
      observer.disconnect()
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onVisibleRangeChange)
      chart.unsubscribeClick(clickHandler)
      chart.unsubscribeDblClick(doubleClickHandler)
      chart.remove()
      priceLineMap.clear()
      indicatorSeriesMap.clear()
      previousData.current = []
      hasInitializedData.current = false
      chartRef.current = null
      seriesRef.current = null
      markersRef.current = null
    }
  }, [enabledIndicators, marketKey])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    const chart = chartRef.current
    const previous = previousData.current
    if (!data.length) {
      series.setData([])
      previousData.current = []
      hasInitializedData.current = false
      return
    }
    const previousFirstTime = previous[0]?.time
    const firstTime = data[0]?.time
    const previousLastTime = previous[previous.length - 1]?.time
    const last = data[data.length - 1]

    if (previous.length && last && (data.length === previous.length && firstTime === previousFirstTime && last.time === previousLastTime || data.length === previous.length + 1 && firstTime === previousFirstTime && last.time > (previousLastTime ?? -Infinity))) {
      series.update({ ...last, time: last.time as Time })
    } else {
      const visibleRange = chart?.timeScale().getVisibleLogicalRange()
      let prependCount = 0
      if (previous.length && previousFirstTime !== undefined && firstTime !== undefined && firstTime < previousFirstTime) {
        prependCount = data.findIndex((candle) => candle.time === previousFirstTime)
      }
      series.setData(data.map((candle) => ({ ...candle, time: candle.time as Time })))
      if (!previous.length && data.length) {
        const savedRange = savedVisibleRange.current
        // Keep a stable window for every symbol, including when an indicator
        // change rebuilds the chart. Small-cap pairs need dynamic price precision.
        const defaultFrom = Math.max(0, data.length - 120)
        const defaultTo = data.length + 4
        chart?.timeScale().setVisibleLogicalRange(savedRange ?? { from: defaultFrom, to: defaultTo })
        savedVisibleRange.current = null
        hasInitializedData.current = true
      } else if (visibleRange && prependCount > 0) {
        chart?.timeScale().setVisibleLogicalRange({ from: visibleRange.from + prependCount, to: visibleRange.to + prependCount })
      } else if (visibleRange) {
        chart?.timeScale().setVisibleLogicalRange(visibleRange)
      }
    }
    previousData.current = data
  }, [data, enabledIndicators])

  useEffect(() => {
    const positivePrices = data.flatMap(({ low, high, close }) => [low, high, close]).filter((value) => Number.isFinite(value) && value > 0)
    const referencePrice = positivePrices.at(-1)
    if (referencePrice === undefined) return
    // Lightweight Charts defaults to cent precision, which compresses the
    // vertical scale for coins priced below one cent and rounds their labels.
    const precision = Math.min(8, Math.max(2, Math.floor(-Math.log10(referencePrice)) + 3))
    const priceFormat = { type: 'price' as const, precision, minMove: 10 ** -precision }
    seriesRef.current?.applyOptions({ priceFormat })
    for (const [key, series] of indicatorSeries.current) {
      if (/^(ema20|ema50|sma200|bollingerUpper|bollingerMiddle|bollingerLower|vwap|macd:(value|signal|histogram)|atr:value)$/.test(key)) {
        series.applyOptions({ priceFormat })
      }
    }
  }, [data])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const rows: Record<string, Array<{ time: number; value: number; color?: string }>> = {
      ema20: indicators.ema20,
      ema50: indicators.ema50,
      sma200: indicators.sma200,
      bollingerUpper: indicators.bollingerUpper,
      bollingerMiddle: indicators.bollingerMiddle,
      bollingerLower: indicators.bollingerLower,
      vwap: indicators.vwap,
      volume: indicators.volume.map((item, index) => ({ ...item, color: data[index]?.close >= (data[index]?.open ?? 0) ? '#64b697' : '#df8585' })),
      'rsi:value': indicators.rsi,
      'macd:value': indicators.macd,
      'macd:signal': indicators.macdSignal,
      'macd:histogram': indicators.macdHistogram.map((item) => ({ ...item, color: item.value >= 0 ? '#72b398' : '#df8585' })),
      'stochastic:k': indicators.stochasticK,
      'stochastic:d': indicators.stochasticD,
      'atr:value': indicators.atr,
      'adx:value': indicators.adx,
      'adx:plus': indicators.plusDi,
      'adx:minus': indicators.minusDi,
      'obv:value': indicators.obv,
    }
    for (const [key, series] of indicatorSeries.current) {
      const values = rows[key] ?? []
      series.setData(values.map((item) => ({ time: item.time as Time, value: item.value, ...(item.color ? { color: item.color } : {}) })) as never)
    }
  }, [data, enabledIndicators, indicators])

  useEffect(() => {
    const markers = trades.flatMap((trade) => Number.isFinite(trade.time) && Number.isFinite(trade.price) && trade.price > 0 ? [{
      id: String(trade.id),
      time: Math.floor(trade.time / 1000) as Time,
      price: trade.price,
      position: trade.side === 'BUY' ? 'atPriceBottom' as const : 'atPriceTop' as const,
      color: trade.side === 'BUY' ? '#168b63' : '#ca6865',
      shape: trade.side === 'BUY' ? 'arrowUp' as const : 'arrowDown' as const,
      text: trade.side === 'BUY' ? '买' : '卖',
    }] : []).sort((left, right) => Number(left.time) - Number(right.time))
    markersRef.current?.setMarkers(markers as SeriesMarker<Time>[])
  }, [trades])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    for (const line of priceLineRef.current.values()) series.removePriceLine(line)
    priceLineRef.current.clear()
    const candlePrices = data.flatMap((candle) => [candle.low, candle.high]).filter((price) => Number.isFinite(price) && price > 0)
    if (!candlePrices.length) return
    const minPrice = Math.min(...candlePrices)
    const maxPrice = Math.max(...candlePrices)
    const span = Math.max(maxPrice - minPrice, maxPrice * 0.001)
    const visibleLevels = levels.filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price >= minPrice - span * 0.15 && level.price <= maxPrice + span * 0.15)
    const isPrimaryLabel = (level: Level) => /止损|止盈|入场|均价|强平/.test(level.label)
    const isStructureLabel = (level: Level) => /支撑|阻力/.test(level.label)
    const labelCandidates = [...visibleLevels].sort((left, right) => Number(isPrimaryLabel(right)) - Number(isPrimaryLabel(left)) || Number(isStructureLabel(right)) - Number(isStructureLabel(left)) || Number(right.deletable === false) - Number(left.deletable === false))
    const labeledCoordinates: number[] = []
    const labeledPrices = new Set<number>()
    for (const level of labelCandidates) {
      const coordinate = series.priceToCoordinate(level.price)
      if (coordinate === null) continue
      const isPrimary = isPrimaryLabel(level)
      const isStructure = isStructureLabel(level)
      const canLabel = (isPrimary || isStructure || level.deletable === false) && labeledCoordinates.every((existing) => Math.abs(existing - coordinate) >= 19)
      if (canLabel) { labeledCoordinates.push(coordinate); labeledPrices.add(level.price) }
    }
    for (const level of visibleLevels) {
      const isPrimary = isPrimaryLabel(level)
      const canLabel = labeledPrices.has(level.price)
      const line = series.createPriceLine({ price: level.price, color: level.color, lineWidth: isPrimary ? 2 : 1, lineStyle: isPrimary ? LineStyle.Dashed : canLabel ? LineStyle.Dotted : LineStyle.SparseDotted, axisLabelVisible: canLabel, title: canLabel ? `${level.label} ${level.price.toLocaleString(undefined, { maximumFractionDigits: 8 })}` : '' })
      priceLineRef.current.set(level.id, line)
    }
  }, [data, enabledIndicators, levels, size.height])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    if (currentPriceLineRef.current) series.removePriceLine(currentPriceLineRef.current)
    currentPriceLineRef.current = currentPrice !== null && Number.isFinite(currentPrice) && currentPrice > 0
      ? series.createPriceLine({ price: currentPrice, color: '#202a38', lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: `当前价格 ${currentPrice.toLocaleString(undefined, { maximumFractionDigits: 8 })}` })
      : null
  }, [currentPrice])

  useEffect(() => {
    if (!data.length) return
    chartRef.current?.applyOptions({ localization: { locale: 'zh-CN' } })
  }, [data.length])

  useEffect(() => {
    const overlay = trendOverlayRef.current
    const chart = chartRef.current
    const series = seriesRef.current
    if (!overlay || !chart || !series) return
    const lines = trends.flatMap((trend) => {
      const x1 = chart.timeScale().timeToCoordinate(trend.start.time as Time)
      const x2 = chart.timeScale().timeToCoordinate(trend.end.time as Time)
      const y1 = series.priceToCoordinate(trend.start.price)
      const y2 = series.priceToCoordinate(trend.end.price)
      if (x1 === null || x2 === null || y1 === null || y2 === null) return []
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', String(x1))
      line.setAttribute('y1', String(y1))
      line.setAttribute('x2', String(x2))
      line.setAttribute('y2', String(y2))
      line.setAttribute('stroke', '#7a69d5')
      line.setAttribute('stroke-width', '2')
      line.setAttribute('stroke-dasharray', '5 3')
      return [line]
    })
    overlay.replaceChildren(...lines)
  }, [data, enabledIndicators, levels, revision, size, trends])

  return <div className={`live-chart ${tool !== 'cursor' ? 'drawing' : ''}`} ref={host} data-level-label={levelLabel} data-chart-width={size.width} data-redraw={revision}>
    <svg ref={trendOverlayRef} className="trend-overlay" width={size.width} height={size.height} aria-hidden="true" />
    {tool === 'trend' && <div className="drawing-hint">在图表上依次点选起点和终点</div>}
    {tool === 'horizontal' && <div className="drawing-hint">点击图表放置{levelLabel}</div>}
  </div>
}
