import assert from 'node:assert/strict'
import test from 'node:test'
import { getBinanceApiCredentials, getBinanceEnvironmentConfig } from '../src/binanceEnvironment.ts'
import { parseWatchlist, reorderWatchlist } from '../src/watchlist.ts'

test('Binance environment selects matching REST and WebSocket endpoints', () => {
  assert.deepEqual(getBinanceEnvironmentConfig(undefined), {
    environment: 'mainnet',
    restBaseUrl: 'https://fapi.binance.com',
    websocketBaseUrl: 'wss://fstream.binance.com',
  })
  assert.deepEqual(getBinanceEnvironmentConfig('testnet'), {
    environment: 'testnet',
    restBaseUrl: 'https://testnet.binancefuture.com',
    websocketBaseUrl: 'wss://stream.binancefuture.com',
  })
})

test('Binance endpoint overrides are trimmed and invalid environment values are rejected', () => {
  assert.deepEqual(getBinanceEnvironmentConfig(' mainnet ', 'http://localhost:8080/', 'ws://localhost:8081/'), {
    environment: 'mainnet',
    restBaseUrl: 'http://localhost:8080',
    websocketBaseUrl: 'ws://localhost:8081',
  })
  assert.throws(() => getBinanceEnvironmentConfig('test'), /BINANCE_ENV/)
})

test('testnet never falls back to live API credentials', () => {
  assert.deepEqual(getBinanceApiCredentials('testnet', {
    BINANCE_API_KEY: 'live-key',
    BINANCE_API_SECRET: 'live-secret',
  }), { apiKey: '', apiSecret: '' })
  assert.deepEqual(getBinanceApiCredentials('testnet', {
    BINANCE_TESTNET_API_KEY: 'test-key',
    BINANCE_TESTNET_API_SECRET: 'test-secret',
  }), { apiKey: 'test-key', apiSecret: 'test-secret' })
  assert.deepEqual(getBinanceApiCredentials('mainnet', {
    BINANCE_API_KEY: 'legacy-key',
    BINANCE_API_SECRET: 'legacy-secret',
  }), { apiKey: 'legacy-key', apiSecret: 'legacy-secret' })
})

test('watchlist parsing returns an empty list by default and filters invalid or duplicate entries', () => {
  assert.deepEqual(parseWatchlist(null), [])
  assert.deepEqual(parseWatchlist('not-json'), [])
  assert.deepEqual(parseWatchlist(JSON.stringify(['BTCUSDT', 'BTCUSDT', 'ETHUSDT', 12, 'bad symbol', ''])), ['BTCUSDT', 'ETHUSDT'])
})

test('watchlist reordering preserves other favorites and ignores unknown symbols', () => {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
  assert.deepEqual(reorderWatchlist(symbols, 'BTCUSDT', 'SOLUSDT'), ['ETHUSDT', 'SOLUSDT', 'BTCUSDT'])
  assert.deepEqual(reorderWatchlist(symbols, 'UNKNOWN', 'SOLUSDT'), symbols)
})
