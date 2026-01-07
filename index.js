const express = require("express")
const fs = require("fs")
const path = require("path")
const { KiteTicker } = require("kiteconnect")
const storage = require("./storage")
const instruments = require("./instruments")
const tradesFile = path.join(__dirname, "data/trades.json")

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, "public")))

const WORKER_URL = "https://zerodha-order-worker.information-710.workers.dev"
const INTERNAL_KEY = "pass123"

async function placeOrder(account, instrument, side) {
  const resp = await fetch(WORKER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-INTERNAL-KEY": INTERNAL_KEY
    },
    body: JSON.stringify({
      api_key: account.api_key,
      access_token: account.access_token,
      tradingsymbol: instrument.symbol,
      exchange: instrument.exchange,
      transaction_type: side,
      quantity: instrument.lot
    })
  })

  return resp.json()
}

// --- Accounts API ---
app.get("/accounts", (req, res) => res.json(storage.accounts.get()))
app.post("/accounts", (req, res) => {
  const accs = storage.accounts.get()
  accs.push(req.body)
  storage.accounts.set(accs)
  res.json({ ok: true })
})

app.post("/accounts/update", (req, res) => {
  storage.accounts.set(req.body)
  res.json({ ok: true })
})

app.post("/buy", async (req, res) => {
  const { accountIndex, instrumentToken } = req.body

  const config = storage.config.get()
  const state = storage.state.get()

  const instrument = storage.instruments.get()
    .find(i => i.token === instrumentToken)

  if (config.execution_mode === "SIM") {
    state[instrumentToken] = {
      buyposition: true,
      entry: state[instrumentToken]?.ltp || 0
    }
    storage.state.set(state)

    return res.json({ status: "success", mode: "SIM" })
  }

  // LIVE MODE
  const account = storage.accounts.get()[accountIndex]
  const result = await placeOrder(account, instrument, "BUY")

  if (result.status === "success") {
    state[instrumentToken] = {
      buyposition: true,
      entry: state[instrumentToken]?.ltp || 0
    }
    storage.state.set(state)
  }

  res.json(result)
})


app.post("/sell", async (req, res) => {
  const { token } = req.body

  const config = storage.config.get()
  const state = storage.state.get()

  if (!state[token] || !state[token].buyposition) {
    return res.json({ status: "error", message: "No open position" })
  }

  if (config.execution_mode === "SIM") {
    const inst = storage.instruments.get().find(i => i.token === token)

    const entry = state[token].entry
    const exit = state[token].ltp
    const pnl = (exit - entry) * inst.lot

    // log trade
    const tradesFile = path.join(__dirname, "data/trades.json")
    const trades = fs.existsSync(tradesFile)
      ? JSON.parse(fs.readFileSync(tradesFile))
      : []

    trades.push({
      symbol: inst.symbol,
      entry,
      exit,
      lot: inst.lot,
      pnl,
      timestamp: new Date().toISOString(),
      mode: "SIM"
    })

    fs.writeFileSync(tradesFile, JSON.stringify(trades, null, 2))

    // clear position
    state[token].buyposition = false
    state[token].entry = 0
    storage.state.set(state)

    return res.json({ status: "success", mode: "SIM" })
  }


  // LIVE MODE
  const account = storage.accounts.get()[0]
  const instrument = storage.instruments.get()
    .find(i => i.token === token)

  const result = await placeOrder(account, instrument, "SELL")

  if (result.status === "success") {
    state[token].buyposition = false
    storage.state.set(state)
  }

  res.json(result)
})

// --- Instruments APIs ---
app.get("/instruments/search", (req, res) => res.json(instruments.search(req.query.q || "")))
app.post("/instruments/select", (req, res) => {
  const inst = instruments.findByToken(req.body.token)
  if (!inst) return res.status(400).json({ error: "invalid token" })
  const selected = storage.instruments.get()
  if (!selected.find(i => i.token === inst.token)) {
    selected.push(inst)
    storage.instruments.set(selected)
  }
  res.json({ ok: true })
})
app.get("/instruments/selected", (req, res) => res.json(storage.instruments.get()))

app.post("/instruments/update", (req, res) => {
  storage.instruments.set(req.body)
  res.json({ ok: true })
})

// Mode selection
app.get("/mode", (req, res) => {
  res.json(storage.config.get())
})

app.post("/mode", (req, res) => {
  const { execution_mode } = req.body
  storage.config.set({ execution_mode })
  res.json({ ok: true, execution_mode })
})


// --- State API ---
app.get("/ltp", (req, res) => res.json(storage.state.get()))
app.post("/updateState", (req, res) => {
  const { token, data } = req.body
  const st = storage.state.get()
  st[token] = data
  storage.state.set(st)
  res.json({ ok: true })
})


app.get("/trades", (req, res) => {
  const trades = fs.existsSync(tradesFile) ? JSON.parse(fs.readFileSync(tradesFile)) : []
  res.json(trades)
})

app.post("/trades/add", (req, res) => {
  const tradesFile = path.join(__dirname, "data/trades.json")
  const trades = fs.existsSync(tradesFile)
    ? JSON.parse(fs.readFileSync(tradesFile))
    : []

  const config = storage.config.get()

  trades.push({
    ...req.body,
    mode: config.execution_mode
  })

  fs.writeFileSync(tradesFile, JSON.stringify(trades, null, 2))
  res.json({ ok: true })
})


// --- KiteTicker setup ---
const accounts = storage.accounts.get()
const selectedInstruments = storage.instruments.get()
if (accounts.length === 0 || selectedInstruments.length === 0) {
  console.log("No accounts or instruments selected")
} else {
  const primary = accounts[0]
  const ticker = new KiteTicker({ api_key: primary.api_key, access_token: primary.access_token })
  const tokens = selectedInstruments.map(i => i.token)

  ticker.on("connect", () => {
    console.log("Ticker connected")
    ticker.subscribe(tokens)
    ticker.setMode(ticker.modeFull, tokens)
  })

  ticker.on("ticks", ticks => {
    const st = storage.state.get()
    ticks.forEach(t => {
      const tok = t.instrument_token
      st[tok] = st[tok] || {}
      st[tok].ltp = t.last_price
    })
    storage.state.set(st)
  })

  ticker.on("error", err => console.error("Ticker error:", err.message))
  ticker.on("close", () => console.log("Ticker closed"))
  ticker.connect()
}

// --- Start server ---
const PORT = 3000
app.listen(PORT, () => console.log(`Server running on port localhost:${PORT}`))
