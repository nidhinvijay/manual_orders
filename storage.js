const fs = require("fs")
const path = require("path")

function load(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  try {
    const data = fs.readFileSync(file, "utf8")
    return data ? JSON.parse(data) : fallback
  } catch {
    return fallback
  }
}

function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

const DATA = path.join(__dirname, "data")

const FILES = {
  accounts: path.join(DATA, "accounts.json"),
  positions: path.join(DATA, "positions.json"),
  instruments: path.join(DATA, "selected_instruments.json"),
  state: path.join(DATA, "state.json"),
  config: path.join(DATA, "config.json")
}

const storage = {
  accounts: {
    get: () => load(FILES.accounts, []),
    set: (v) => save(FILES.accounts, v)
  },

  positions: {
    get: () => load(FILES.positions, []),
    set: (v) => save(FILES.positions, v)
  },

  instruments: {
    get: () => load(FILES.instruments, []),
    set: (v) => save(FILES.instruments, v)
  },

  state: {
    get: () => load(FILES.state, {}),
    set: (v) => save(FILES.state, v)
  },

  config: {
    get: () => load(FILES.config, { execution_mode: "SIM" }),
    set: (v) => save(FILES.config, v)
  }
}

module.exports = storage
