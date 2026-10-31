export type ProtectionOrderKind = 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'

export type ProtectionOrderValue = {
  kind: ProtectionOrderKind
  triggerPrice: string
  workingType: string
}

export type ProtectionOrderSnapshot<TOrder> = {
  order: TOrder
  value: ProtectionOrderValue
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '未知错误'
}

/** Replace close-position protection orders as a set, attempting rollback on failure. */
export async function replaceProtectionOrderSet<TOrder, TPlaced>(options: {
  previous: ProtectionOrderSnapshot<TOrder>[]
  replacements: ProtectionOrderValue[]
  cancel: (order: TOrder) => Promise<unknown>
  afterCancel?: () => Promise<void>
  place: (value: ProtectionOrderValue) => Promise<TPlaced>
  remove: (order: TPlaced) => Promise<unknown>
  restore: (value: ProtectionOrderValue) => Promise<unknown>
}) {
  const cancelled: ProtectionOrderSnapshot<TOrder>[] = []
  if (options.afterCancel) {
    const cancelErrors: unknown[] = []
    for (const snapshot of options.previous) {
      try {
        await options.cancel(snapshot.order)
        cancelled.push(snapshot)
      } catch (error) {
        cancelErrors.push(error)
      }
    }
    try {
      await options.afterCancel()
    } catch (error) {
      const detail = cancelErrors.length ? `；撤单响应：${errorMessage(cancelErrors[0])}` : ''
      await Promise.allSettled(cancelled.map(({ value }) => options.restore(value)))
      throw new Error(`旧保护单撤销状态未确认，未创建新单：${errorMessage(error)}${detail}`)
    }
    if (cancelErrors.length) {
      await Promise.allSettled(cancelled.map(({ value }) => options.restore(value)))
      throw new Error(`撤销旧保护单失败，已尝试恢复已撤销订单：${errorMessage(cancelErrors[0])}`)
    }
  } else {
    try {
      for (const snapshot of options.previous) {
        await options.cancel(snapshot.order)
        cancelled.push(snapshot)
      }
    } catch (error) {
      await Promise.allSettled(cancelled.map(({ value }) => options.restore(value)))
      throw new Error(`撤销旧保护单失败，已尝试恢复已撤销订单：${errorMessage(error)}`)
    }
  }

  const placed: TPlaced[] = []
  try {
    for (const value of options.replacements) placed.push(await options.place(value))
  } catch (error) {
    await Promise.allSettled(placed.map((order) => options.remove(order)))
    await Promise.allSettled(options.previous.map(({ value }) => options.restore(value)))
    throw new Error(`创建新保护单失败，已尝试恢复原保护单：${errorMessage(error)}`)
  }

  return { placed, canceled: options.previous.length }
}
