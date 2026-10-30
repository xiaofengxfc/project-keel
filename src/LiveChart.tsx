import { useEffect, useRef, useState } from 'react'
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type MouseEventParams, type Time } from 'lightweight-charts'
import type { ChartIndicatorKey, TechnicalIndicatorSet } from './technicalIndicators'

type Candle = { time: number; open: number; high: number; low: number; close: number }
type Level = { id: number; price: number; label: string; color: string }
type Trend = { id: number; start: { time: number; price: number }; end: { time: number; price: number } }
type Tool = 'cursor' | 'horizontal' | 'trend'

type Props = {
  data: Candle[]
  livePrice: number | null
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

export default function LiveChart({ data, livePrice, levels, trends, indicators, enabledIndicators, tool, levelLabel, onAddLevel, onAddTrend, onRemoveLevel, onRemoveTrend, onLoadOlder }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const trendOverlayRef = useRef<SVGSVGElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const priceLineRef = useRef<Map<number, IPriceLine>>(new Map())
  const indicatorSeries = useRef<Map<string, ISeriesApi<'Line' | 'Histogram'>>>(new Map())
  const savedVisibleRange = useRef<{ from: number; to: number } | null>(null)
  const currentPriceLine = useRef<IPriceLine | null>(null)
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
      priceLineVisible: false, lastValueVisible: true,
    })
    chartRef.current = chart
    seriesRef.current = series
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
      const nearest = levelsRef.current.reduce<{ id: number; distance: number } | null>((best, item) => {
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
      const visibleRange = chart.timeScale().getVisibleLogicalRange()
      if (visibleRange) savedVisibleRange.current = visibleRange
      observer.disconnect()
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onVisibleRangeChange)
      chart.unsubscribeClick(clickHandler)
      chart.unsubscribeDblClick(doubleClickHandler)
      chart.remove()
      priceLineMap.clear()
      currentPriceLine.current = null
      indicatorSeriesMap.clear()
      previousData.current = []
      hasInitializedData.current = false
      chartRef.current = null
      seriesRef.current = null
    }
  }, [enabledIndicators])

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
        chart?.timeScale().setVisibleLogicalRange(savedRange ?? { from: Math.max(0, data.length - 120), to: data.length + 4 })
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
    const series = seriesRef.current
    if (!series || livePrice === null) return
    const line = currentPriceLine.current
    if (line) {
      line.applyOptions({ price: livePrice, title: '最新成交价' })
    } else {
      currentPriceLine.current = series.createPriceLine({ price: livePrice, color: '#2487e8', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '最新成交价' })
    }
  }, [enabledIndicators, livePrice])

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
    const series = seriesRef.current
    if (!series) return
    for (const line of priceLineRef.current.values()) series.removePriceLine(line)
    priceLineRef.current.clear()
    for (const level of levels) {
      const line = series.createPriceLine({ price: level.price, color: level.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `${level.label} ${level.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` })
      priceLineRef.current.set(level.id, line)
    }
    setRevision((value) => value + 1)
  }, [enabledIndicators, levels])

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
  }, [data, enabledIndicators, revision, size, trends])

  return <div className={`live-chart ${tool !== 'cursor' ? 'drawing' : ''}`} ref={host} data-level-label={levelLabel} data-chart-width={size.width} data-redraw={revision}>
    <svg ref={trendOverlayRef} className="trend-overlay" width={size.width} height={size.height} aria-hidden="true" />
    {tool === 'trend' && <div className="drawing-hint">在图表上依次点选起点和终点</div>}
    {tool === 'horizontal' && <div className="drawing-hint">点击图表放置{levelLabel}</div>}
  </div>
}
