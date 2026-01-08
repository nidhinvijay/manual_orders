const express = require("express")
const fs = require("fs")
const path = require("path")
const http = require("http")
const { Server } = require("socket.io")
const { KiteTicker } = require("kiteconnect")
const storage = require("./storage")
const instruments = require("./instruments")
const tradesFile = path.join(__dirname, "data/trades.json")

const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: "*" }
})

app.use(express.json())
app.use(express.static(path.join(__dirname, "public")))

// Socket.IO connection handler
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id)

  // Send current state on connect
  socket.emit("state", storage.state.get())
  socket.emit("mode", storage.config.get())

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id)
  })
})

const WORKER_URL = "https://zerodha-order-worker.information-710.workers.dev"
const INTERNAL_KEY = "pass123"

async function placeOrder(account, instrument, side) {
  try {
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

    if (!resp.ok) {
      const text = await resp.text()
      return { status: "error", message: `HTTP ${resp.status}: ${text}` }
    }
    return await resp.json()
  } catch (err) {
    console.error("placeOrder error:", err)
    return { status: "error", message: err.message }
  }
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
  try {
    const { instrumentToken } = req.body

    const accounts = storage.accounts.get()
    const instruments = storage.instruments.get()
    const state = storage.state.get()
    const config = storage.config.get()

    const inst = instruments.find(i => i.token === instrumentToken)
    state[instrumentToken] = state[instrumentToken] || {}

    // SIM MODE (unchanged, sequential is fine)
    if (config.execution_mode === "SIM") {
      const results = []
      for (const acc of accounts) {
        state[instrumentToken][acc.name] = {
          buyposition: true,
          entry: state[instrumentToken]?.ltp || 0
        }
        results.push({
          account: acc.name,
          result: { status: "success" }
        })
      }
      storage.state.set(state)
      io.emit("position", { token: instrumentToken, state: state[instrumentToken] })
      return res.json({ results })
    }

    // LIVE MODE — PARALLEL
    const promises = accounts.map(acc =>
      placeOrder(acc, inst, "BUY")
        .then(r => ({ account: acc.name, result: r }))
    )

    const results = await Promise.all(promises)

    for (const r of results) {
      if (r.result.status === "success") {
        state[instrumentToken][r.account] = {
          buyposition: true,
          entry: state[instrumentToken]?.ltp || 0
        }
      }
    }

    storage.state.set(state)
    io.emit("position", { token: instrumentToken, state: state[instrumentToken] })
    res.json({ results })
  } catch (e) {
    console.error("/buy error:", e)
    res.status(500).json({ error: e.message })
  }
})

app.post("/sell", async (req, res) => {
  try {
    const { token } = req.body

    const accounts = storage.accounts.get()
    const instruments = storage.instruments.get()
    const state = storage.state.get()
    const config = storage.config.get()

    const inst = instruments.find(i => i.token === token)
    if (!state[token]) return res.json({ status: "error", message: "No positions" })

    // SIM MODE
    if (config.execution_mode === "SIM") {
      const exit = state[token].ltp || 0

      // Find entry from ANY account that has a buy position (assuming identical in SIM)
      const entryAccName = Object.keys(state[token]).find(k => state[token][k].buyposition)
      const entry = entryAccName ? state[token][entryAccName].entry : 0

      // Log ONE aggregated trade
      if (entryAccName) {
        const pnl = (exit - entry) * inst.lot
        logTrade({
          symbol: inst.symbol,
          entry,
          exit,
          lot: inst.lot,
          pnl,
          mode: "SIM",
          account: "NIL"
        })
      }

      // Clear position for ALL accounts
      for (const acc of accounts) {
        if (state[token][acc.name]) {
          state[token][acc.name].buyposition = false
          state[token][acc.name].entry = 0
        }
      }

      storage.state.set(state)
      io.emit("position", { token, state: state[token] })
      io.emit("trade", { symbol: inst.symbol, entry, exit, lot: inst.lot, pnl: (exit - entry) * inst.lot, mode: "SIM", account: "NIL" })

      return res.json({
        results: accounts.map(acc => ({
          account: acc.name,
          result: { status: "success" }
        }))
      })
    }

    // 🔥 LIVE MODE — PARALLEL
    const promises = accounts.map(acc => {
      const pos = state[token][acc.name]
      if (!pos || !pos.buyposition) return null

      return placeOrder(acc, inst, "SELL")
        .then(r => ({ account: acc.name, result: r, pos }))
    }).filter(Boolean)

    const results = await Promise.all(promises)

    for (const r of results) {
      if (r.result.status === "success") {
        const exit = state[token].ltp || 0
        const pnl = (exit - r.pos.entry) * inst.lot

        logTrade({
          symbol: inst.symbol,
          entry: r.pos.entry,
          exit,
          lot: inst.lot,
          pnl,
          mode: "LIVE",
          account: r.account
        })

        r.pos.buyposition = false
        r.pos.entry = 0
      }
    }

    storage.state.set(state)
    io.emit("position", { token, state: state[token] })
    res.json({ results })
  } catch (e) {
    console.error("/sell error:", e)
    res.status(500).json({ error: e.message })
  }
})

function logTrade(t) {
  const file = path.join(__dirname, "data/trades.json")
  const trades = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file))
    : []

  const trade = {
    ...t,
    timestamp: new Date().toISOString()
  }

  trades.push(trade)
  fs.writeFileSync(file, JSON.stringify(trades, null, 2))

  // Emit trade event to all connected clients
  io.emit("trade", trade)
}

// --- Instruments APIs ---
app.get("/instruments/search", (req, res) => res.json(instruments.search(req.query.q || "")))
app.post("/instruments/select", (req, res) => {
  const inst = instruments.findByToken(req.body.token)
  if (!inst) return res.status(400).json({ error: "invalid token" })
  const selected = storage.instruments.get()
  if (!selected.find(i => i.token === inst.token)) {
    selected.push(inst)
    storage.instruments.set(selected)

    // Dynamically subscribe to the new token
    subscribeNewToken(inst.token)
  }
  res.json({ ok: true })
})
app.get("/instruments/selected", (req, res) => res.json(storage.instruments.get()))

app.post("/instruments/update", (req, res) => {
  storage.instruments.set(req.body)
  res.json({ ok: true })
})

// Re-subscribe all instruments to ticker
app.post("/instruments/resubscribe", (req, res) => {
  const selected = storage.instruments.get()
  let subscribed = 0
  selected.forEach(inst => {
    if (subscribeNewToken(inst.token)) subscribed++
  })
  res.json({ ok: true, subscribed })
})

// Mode selection
app.get("/mode", (req, res) => {
  res.json(storage.config.get())
})

app.post("/mode", (req, res) => {
  const { execution_mode } = req.body
  storage.config.set({ execution_mode })
  io.emit("mode", { execution_mode })
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
let ticker = null
const subscribedTokens = new Set()

function initTicker() {
  const accounts = storage.accounts.get()
  const selectedInstruments = storage.instruments.get()

  if (accounts.length === 0) {
    console.log("No accounts found - ticker not started")
    return
  }

  const primary = accounts[0]
  ticker = new KiteTicker({ api_key: primary.api_key, access_token: primary.access_token })
  const tokens = selectedInstruments.map(i => i.token)

  ticker.on("connect", () => {
    console.log("Ticker connected")
    if (tokens.length > 0) {
      ticker.subscribe(tokens)
      ticker.setMode(ticker.modeFull, tokens)
      tokens.forEach(t => subscribedTokens.add(t))
      console.log("Subscribed to", tokens.length, "instruments")
    }
  })

  ticker.on("ticks", ticks => {
    const st = storage.state.get()
    const ltpUpdates = []

    ticks.forEach(t => {
      const tok = t.instrument_token
      st[tok] = st[tok] || {}
      st[tok].ltp = t.last_price
      ltpUpdates.push({ token: tok, ltp: t.last_price })
    })

    storage.state.set(st)

    // Push LTP updates to all connected browsers
    io.emit("ltp", ltpUpdates)
  })

  ticker.on("error", err => console.error("Ticker error:", err.message))
  ticker.on("close", () => console.log("Ticker closed"))
  ticker.connect()
}

// Subscribe to a new token dynamically
function subscribeNewToken(token) {
  if (!ticker || !ticker.connected) {
    console.log("Ticker not connected, cannot subscribe to", token)
    return false
  }

  if (subscribedTokens.has(token)) {
    console.log("Token", token, "already subscribed")
    return true
  }

  ticker.subscribe([token])
  ticker.setMode(ticker.modeFull, [token])
  subscribedTokens.add(token)
  console.log("Dynamically subscribed to token:", token)
  return true
}

// Initialize ticker
initTicker()

// --- Start server ---
const PORT = 3000
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))


