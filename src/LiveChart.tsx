import { useEffect, useRef, useState } from 'react'
import { CandlestickSeries, ColorType, CrosshairMode, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type MouseEventParams, type Time } from 'lightweight-charts'

type Candle = { time: number; open: number; high: number; low: number; close: number }
type Level = { id: number; price: number; label: string; color: string }
type Trend = { id: number; start: { time: number; price: number }; end: { time: number; price: number } }
type Tool = 'cursor' | 'horizontal' | 'trend'

type Props = {
  data: Candle[]
  levels: Level[]
  trends: Trend[]
  tool: Tool
  levelLabel: string
  onAddLevel: (price: number) => void
  onAddTrend: (start: Trend['start'], end: Trend['end']) => void
  onRemoveLevel: (id: number) => void
}

export default function LiveChart({ data, levels, trends, tool, levelLabel, onAddLevel, onAddTrend, onRemoveLevel }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const priceLineRef = useRef<Map<number, IPriceLine>>(new Map())
  const pendingTrend = useRef<Trend['start'] | null>(null)
  const toolRef = useRef(tool)
  const levelLabelRef = useRef(levelLabel)
  const callbacks = useRef({ onAddLevel, onAddTrend, onRemoveLevel })
  const [revision, setRevision] = useState(0)
  const [size, setSize] = useState({ width: 0, height: 0 })
  toolRef.current = tool
  levelLabelRef.current = levelLabel
  callbacks.current = { onAddLevel, onAddTrend, onRemoveLevel }

  useEffect(() => {
    const element = host.current
    if (!element) return
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
    const clickHandler = (event: MouseEventParams<Time>) => {
      if (!event.point || !event.time || !seriesRef.current) return
      const value = seriesRef.current.coordinateToPrice(event.point.y)
      if (value === null || typeof event.time !== 'number') return
      if (toolRef.current === 'horizontal') callbacks.current.onAddLevel(value)
      else if (toolRef.current === 'trend') {
        if (!pendingTrend.current) pendingTrend.current = { time: event.time, price: value }
        else { callbacks.current.onAddTrend(pendingTrend.current, { time: event.time, price: value }); pendingTrend.current = null }
      }
    }
    const doubleClickHandler = (event: MouseEventParams<Time>) => {
      if (!event.point || !seriesRef.current) return
      const clickedPrice = seriesRef.current.coordinateToPrice(event.point.y)
      if (clickedPrice === null) return
      const nearest = levels.reduce<{ id: number; distance: number } | null>((best, item) => {
        const coordinate = seriesRef.current?.priceToCoordinate(item.price)
        if (coordinate === null || coordinate === undefined) return best
        const distance = Math.abs(coordinate - event.point!.y)
        return distance <= 12 && (!best || distance < best.distance) ? { id: item.id, distance } : best
      }, null)
      if (nearest) callbacks.current.onRemoveLevel(nearest.id)
    }
    chart.subscribeClick(clickHandler)
    chart.subscribeDblClick(doubleClickHandler)
    const redraw = () => setRevision((value) => value + 1)
    chart.timeScale().subscribeVisibleLogicalRangeChange(redraw)
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setSize({ width: rect.width, height: rect.height })
      redraw()
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(redraw)
      chart.unsubscribeClick(clickHandler)
      chart.unsubscribeDblClick(doubleClickHandler)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    series.setData(data.map((candle) => ({ ...candle, time: candle.time as Time })))
    if (data.length) chartRef.current?.timeScale().fitContent()
  }, [data])

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
  }, [levels])

  useEffect(() => {
    if (!data.length) return
    chartRef.current?.applyOptions({ localization: { locale: 'zh-CN' } })
  }, [data.length])

  const paths = trends.map((trend) => {
    const x1 = chartRef.current?.timeScale().timeToCoordinate(trend.start.time as Time)
    const x2 = chartRef.current?.timeScale().timeToCoordinate(trend.end.time as Time)
    const y1 = seriesRef.current?.priceToCoordinate(trend.start.price)
    const y2 = seriesRef.current?.priceToCoordinate(trend.end.price)
    return x1 === null || x1 === undefined || x2 === null || x2 === undefined || y1 === null || y1 === undefined || y2 === null || y2 === undefined ? null : <line key={trend.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#7a69d5" strokeWidth="2" strokeDasharray="5 3" />
  })

  return <div className={`live-chart ${tool !== 'cursor' ? 'drawing' : ''}`} ref={host} data-level-label={levelLabel} data-chart-width={size.width} data-redraw={revision}>
    <svg className="trend-overlay" width={size.width} height={size.height} aria-hidden="true">{paths}</svg>
    {tool === 'trend' && <div className="drawing-hint">在图表上依次点选起点和终点</div>}
    {tool === 'horizontal' && <div className="drawing-hint">点击图表放置{levelLabel}</div>}
  </div>
}
