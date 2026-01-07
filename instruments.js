const fs = require("fs")
const path = require("path")

const file = path.join(__dirname, "instruments.csv")
const lines = fs.readFileSync(file, "utf8").trim().split("\n")
const headers = lines.shift().split(",")

function parse(line) {
  const cols = line.split(",")
  const obj = {}
  headers.forEach((h, i) => obj[h] = cols[i])
  return obj
}

const instruments = lines
  .map(parse)
  .filter(r => r.instrument_type === "CE" || r.instrument_type === "PE")
  .map(r => ({
    token: Number(r.instrument_token),
    symbol: r.tradingsymbol,
    exchange: r.exchange,
    lot: Number(r.lot_size),
    type: r.instrument_type,
    expiry: r.expiry,
    strike: Number(r.strike)
  }))

function search(q) {
  return instruments.filter(i => i.symbol.includes(q.toUpperCase()))
}

function findByToken(token) {
  return instruments.find(i => i.token === token)
}

module.exports = { all: instruments, search, findByToken }
