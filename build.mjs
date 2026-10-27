// Precios de cartas de baloncesto (NBA y WNBA) a partir de las ventas de TheCardAPI, publicados como JSON
// estáticos en GitHub Pages para la app. Se ejecuta cada día (.github/workflows/update-prices.yml):
//   THECARDAPI_KEY=... node build.mjs <carpeta de salida>
// La carpeta de salida tiene lo ya publicado: el histórico de cada carta se completa con los días nuevos.
//
// Las ventas se buscan por nombre de jugador (data/players.json) y sus títulos se leen con cardParser.js, el
// mismo archivo que usa la app para leer el texto de la foto, así que las claves coinciden.
// No se publican las ventas sueltas, solo el resumen de cada día por carta (mediana, nº de ventas, mín. y máx.).
//
// Archivos publicados:
//   index.json         { updated, epoch, days: { 'YYYY-MM-DD': 'final' | 'partial' }, players: { slug: nº de cartas } }
//   players.json       [[nombre, slug, activo], ...] (todos los jugadores, para reconocer el nombre en la app)
//   rules.json         sets, parallels, equipos, alias y palabras excluidas (para cardParser.js en la app)
//   p/<slug>.json      { name, slug, team, epoch, cards: [{ year, set, number, parallel, printRun, auto,
//                        memorabilia, rookie, image, grades: { 'Raw' | 'PSA 10' | ...: { price, low, high, sales,
//                        lastSale, history: [[día, mediana, ventas, mín, máx], ...] } } }] }
// Precios en céntimos de USD. El día es el nº de días desde epoch. price/low/high/sales son de los últimos
// SUMMARY_DAYS días; si la carta no se ha vendido en ese tiempo, price es la mediana de su última venta.

import { readFile, writeFile, readdir, mkdir, rm, appendFile } from 'node:fs/promises'
import { createParser, variantKey } from './cardParser.js'

const API_URL = 'https://www.thecardapi.com/api/v1/market/sales'
const API_KEY = process.env.THECARDAPI_KEY
// Días hacia atrás que permite consultar el plan (gratis: 3, Starter: 14)
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 3)
const FORCE = !!process.env.FORCE

const EPOCH = '2026-01-01'
const HISTORY_DAYS = 180
const SUMMARY_DAYS = 30
// Nombres por búsqueda: la API acepta "(nombre, nombre, ...)" como O. Con 700 aún responde, se deja margen
const NAMES_PER_QUERY = 600
const PAGE_LIMIT = 1000
// Filas que hay que tener disponibles en el día para empezar un día nuevo (un día son ~2.500)
const MIN_ROWS_FOR_DAY = 3500

const DAY_MS = 24 * 3600 * 1000
const toDayNumber = (date) => Math.round((new Date(`${date}T00:00:00Z`) - new Date(`${EPOCH}T00:00:00Z`)) / DAY_MS)
const toDate = (dayNumber) => new Date(new Date(`${EPOCH}T00:00:00Z`).getTime() + dayNumber * DAY_MS).toISOString().slice(0, 10)
const todayNumber = () => toDayNumber(new Date().toISOString().slice(0, 10))
const cents = (value) => Math.round(value * 100)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (e) {
    return null
  }
}

// Filas que quedan hoy en el plan (de la última respuesta)
let rowsRemaining = Infinity

class BudgetError extends Error {}

const request = async (params) => {
  const url = `${API_URL}?${new URLSearchParams(params)}`

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'x-market-api-key': API_KEY } })
    const remaining = res.headers.get('x-ratelimit-remaining')
    if(remaining !== null) rowsRemaining = Number(remaining)

    if(res.ok) return res.json()
    if(res.status === 429 && rowsRemaining === 0) throw new BudgetError('Sin filas disponibles hoy')
    if(attempt >= 4 || (res.status < 500 && res.status !== 429)) throw new Error(`${res.status} ${await res.text()}`)
    await sleep(2000 * attempt)
  }
}

// Todas las ventas de un día de los jugadores de la lista
const fetchDay = async (date, queries) => {
  const sales = new Map()

  for (const query of queries) {
    let cursor = null
    do {
      const params = { q: query, date_from: date, date_to: date, limit: PAGE_LIMIT }
      if(cursor) params.cursor = cursor
      const page = await request(params)
      for (const sale of page.data || []) sales.set(sale.id, sale)
      cursor = page.data?.length === PAGE_LIMIT ? page.pagination?.next_cursor : null
      await sleep(250)
    } while (cursor)
  }

  return [...sales.values()]
}

// Búsquedas "(nombre, nombre, ...)" con todos los jugadores y alias
const buildQueries = (players, rules) => {
  const terms = [...players.map(([name]) => name), ...Object.keys(rules.aliases)]
    .map(name => name.replace(/[(),"]/g, ' ').trim())
    .filter(Boolean)

  const queries = []
  for (let i = 0; i < terms.length; i += NAMES_PER_QUERY) queries.push(`(${terms.slice(i, i + NAMES_PER_QUERY).join(',')})`)
  return queries
}

// Resumen de los últimos SUMMARY_DAYS días: mediana de las medianas diarias ponderada por nº de ventas
const summarize = (history, today) => {
  const recent = history.filter(([day]) => day > today - SUMMARY_DAYS)
  const last = history[history.length - 1]

  if(!recent.length) return { price: last[1], low: last[3], high: last[4], sales: 0, lastSale: toDate(last[0]) }

  const weighted = recent.flatMap(([, value, count]) => Array(Math.min(count, 50)).fill(value))
  return {
    price: median(weighted),
    low: Math.min(...recent.map(e => e[3])),
    high: Math.max(...recent.map(e => e[4])),
    sales: recent.reduce((sum, e) => sum + e[2], 0),
    lastSale: toDate(last[0]),
  }
}

const loadPlayerFiles = async (out) => {
  const files = new Map()
  let names = []
  try {
    names = await readdir(`${out}/p`)
  } catch (e) {}

  for (const name of names) {
    const data = await readJson(`${out}/p/${name}`)
    if(data) files.set(data.slug, data)
  }
  return files
}

// Añade las ventas de un día a las cartas de cada jugador (sustituye lo que hubiera de ese día)
const mergeDay = (files, date, cards, playerNames) => {
  const day = toDayNumber(date)
  // slug -> clave de variante -> { card, grades: { grado: [precios] } }
  const byPlayer = new Map()

  for (const card of cards) {
    if(!byPlayer.has(card.player)) byPlayer.set(card.player, new Map())
    const variants = byPlayer.get(card.player)
    const key = variantKey(card)
    if(!variants.has(key)) variants.set(key, { card, grades: {}, teams: [] })
    const variant = variants.get(key)
    ;(variant.grades[card.grade] ||= []).push(card.price)
    if(card.image && !variant.image) variant.image = card.image
    if(card.team) variant.teams.push(card.team)
  }

  // Quitar ese día de todas las cartas (por si se vuelve a procesar)
  for (const file of files.values()) {
    for (const card of file.cards) {
      for (const grade of Object.values(card.grades)) grade.history = grade.history.filter(e => e[0] !== day)
    }
  }

  for (const [slug, variants] of byPlayer) {
    if(!files.has(slug)) files.set(slug, { name: playerNames.get(slug), slug, team: null, epoch: EPOCH, cards: [] })
    const file = files.get(slug)
    const teams = []

    for (const [key, variant] of variants) {
      let card = file.cards.find(e => e.key === key)
      if(!card){
        const { year, set, number, parallel, printRun, auto, memorabilia } = variant.card
        card = { key, year, set, number, parallel, printRun, auto, memorabilia, rookie: false, image: null, grades: {} }
        file.cards.push(card)
      }
      card.rookie = card.rookie || variant.card.rookie
      card.memorabilia = card.memorabilia || variant.card.memorabilia
      if(variant.image) card.image = variant.image
      teams.push(...variant.teams)

      for (const [grade, prices] of Object.entries(variant.grades)) {
        const entry = card.grades[grade] ||= { history: [] }
        entry.history.push([day, median(prices), prices.length, Math.min(...prices), Math.max(...prices)])
        entry.history.sort((a, b) => a[0] - b[0])
      }
    }

    // El equipo que más aparece en las ventas del día
    if(teams.length){
      const counts = teams.reduce((acc, team) => ({ ...acc, [team]: (acc[team] || 0) + 1 }), {})
      file.team = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    }
  }
}

const main = async () => {
  const out = process.argv[2]
  if(!out) throw new Error('Uso: node build.mjs <carpeta de salida>')
  if(!API_KEY) throw new Error('Falta THECARDAPI_KEY')

  const players = await readJson('data/players.json')
  const rules = await readJson('data/rules.json')
  const { parse } = createParser({ players, rules })
  const playerNames = new Map(players.map(([name, slug]) => [slug, name]))

  const index = (await readJson(`${out}/index.json`)) || { days: {} }
  const today = todayNumber()

  // Días por procesar: los de los últimos LOOKBACK_DAYS que no estén cerrados. Ayer se procesa pero queda
  // 'partial' (aún pueden llegar ventas) y se vuelve a procesar en la siguiente ejecución
  const pending = []
  for (let day = today - LOOKBACK_DAYS; day < today; day++) {
    const date = toDate(day)
    if(FORCE || index.days[date] !== 'final') pending.push(date)
  }

  const files = await loadPlayerFiles(out)
  const queries = buildQueries(players, rules)
  let processed = 0

  for (const date of pending) {
    if(rowsRemaining < MIN_ROWS_FOR_DAY){
      console.log(`::warning::Quedan ${rowsRemaining} filas hoy: ${date} se procesará en la siguiente ejecución`)
      break
    }

    let sales
    try {
      sales = await fetchDay(date, queries)
    } catch (e) {
      // Un día a medias no se guarda: se vuelve a intentar entero en la siguiente ejecución
      console.log(`::warning::${date}: ${e.message}`)
      if(e instanceof BudgetError) break
      continue
    }

    const cards = []
    for (const sale of sales) {
      const price = sale.price_usd ?? (sale.currency === 'USD' ? sale.price : null)
      if(!price || price <= 0) continue
      const card = parse(sale.title, { grader: sale.grader, grade: sale.grade })
      if(!card || (!card.set && !card.number)) continue
      cards.push({ ...card, price: cents(price), image: sale.thumbnail_url || null })
    }

    mergeDay(files, date, cards, playerNames)
    index.days[date] = toDayNumber(date) < today - 1 ? 'final' : 'partial'
    processed++
    console.log(`${date}: ${sales.length} ventas, ${cards.length} reconocidas (quedan ${rowsRemaining} filas hoy)`)
  }

  if(!processed && !FORCE){
    console.log('Sin días nuevos')
    return
  }

  // Resúmenes (cambian cada día aunque no haya ventas nuevas: la ventana de SUMMARY_DAYS avanza)
  await rm(`${out}/p`, { recursive: true, force: true })
  await mkdir(`${out}/p`, { recursive: true })
  index.players = {}

  for (const file of files.values()) {
    for (const card of file.cards) {
      for (const [grade, entry] of Object.entries(card.grades)) {
        entry.history = entry.history.filter(e => e[0] > today - HISTORY_DAYS)
        if(!entry.history.length){
          delete card.grades[grade]
          continue
        }
        Object.assign(entry, summarize(entry.history, today))
      }
    }
    file.cards = file.cards.filter(card => Object.keys(card.grades).length)
    if(!file.cards.length) continue

    const cardSales = (card) => Object.values(card.grades).reduce((sum, e) => sum + e.sales, 0)
    file.cards.sort((a, b) => cardSales(b) - cardSales(a))

    await writeFile(`${out}/p/${file.slug}.json`, JSON.stringify(file))
    index.players[file.slug] = file.cards.length
  }

  for (const date of Object.keys(index.days)) {
    if(toDayNumber(date) <= today - HISTORY_DAYS) delete index.days[date]
  }
  index.updated = new Date().toISOString()
  index.epoch = EPOCH

  await writeFile(`${out}/index.json`, JSON.stringify(index))
  await writeFile(`${out}/players.json`, JSON.stringify(players))
  await writeFile(`${out}/rules.json`, JSON.stringify(rules))

  if(process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'changed=true\n')
  console.log(`${Object.keys(index.players).length} jugadores con precios`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
