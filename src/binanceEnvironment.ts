export type BinanceEnvironment = 'mainnet' | 'testnet'

export type BinanceEnvironmentConfig = {
  environment: BinanceEnvironment
  restBaseUrl: string
  websocketBaseUrl: string
}

export type BinanceApiCredentials = { apiKey: string; apiSecret: string }

export function getBinanceApiCredentials(environment: BinanceEnvironment, values: Record<string, string | undefined>): BinanceApiCredentials {
  if (environment === 'testnet') {
    return { apiKey: values.BINANCE_TESTNET_API_KEY ?? '', apiSecret: values.BINANCE_TESTNET_API_SECRET ?? '' }
  }
  return {
    apiKey: values.BINANCE_MAINNET_API_KEY ?? values.BINANCE_API_KEY ?? '',
    apiSecret: values.BINANCE_MAINNET_API_SECRET ?? values.BINANCE_API_SECRET ?? '',
  }
}

export function getBinanceEnvironmentConfig(
  value: string | undefined,
  restBaseUrlOverride?: string,
  websocketBaseUrlOverride?: string,
): BinanceEnvironmentConfig {
  const selectedEnvironment = value?.trim().toLowerCase() || 'mainnet'
  if (selectedEnvironment !== 'mainnet' && selectedEnvironment !== 'testnet') throw new Error('BINANCE_ENV 只能是 mainnet 或 testnet')
  const environment: BinanceEnvironment = selectedEnvironment
  const defaults = environment === 'testnet'
    ? { restBaseUrl: 'https://testnet.binancefuture.com', websocketBaseUrl: 'wss://stream.binancefuture.com' }
    : { restBaseUrl: 'https://fapi.binance.com', websocketBaseUrl: 'wss://fstream.binance.com' }

  return {
    environment,
    restBaseUrl: (restBaseUrlOverride || defaults.restBaseUrl).replace(/\/$/, ''),
    websocketBaseUrl: (websocketBaseUrlOverride || defaults.websocketBaseUrl).replace(/\/$/, ''),
  }
}
