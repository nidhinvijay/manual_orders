const KiteTicker = require("kiteconnect").KiteTicker
const storage = require("./storage")

let ticker = null

function startTicker() {
  const accounts = storage.accounts.get()
  if (!accounts.length) {
    console.log("No accounts found")
    return
  }

  const account = accounts[0]
  const selected = storage.instruments.get()
  const tokens = selected.map(i => i.token)

  if (!tokens.length) {
    console.log("No instruments selected")
    return
  }

  ticker = new KiteTicker({
    api_key: account.api_key,
    access_token: account.access_token
  })

  ticker.on("connect", () => {
    console.log("Ticker connected")
    ticker.subscribe(tokens)
    ticker.setMode(ticker.modeLTP, tokens)
  })

  ticker.on("ticks", ticks => {
    const state = storage.state.get()

    ticks.forEach(t => {
      state[t.instrument_token] = {
        ltp: t.last_price,
        ts: Date.now()
      }
    })

    storage.state.set(state)
  })

  ticker.on("error", err => {
    console.log("Ticker error", err.message)
  })

  ticker.on("close", () => {
    console.log("Ticker closed")
  })

  ticker.connect()
}

module.exports = startTicker
