// Genera data/players.json (jugadores de la NBA y la WNBA, en activo y retirados) a partir de la lista que
// mantiene el proyecto nba_api. Se ejecuta a mano de vez en cuando (al empezar cada temporada, para los rookies):
//   node players.mjs
// Formato: [[nombre, slug, activo], ...] ordenado por nombre

import { writeFile } from 'node:fs/promises'
import { slugify } from './cardParser.js'

const SOURCE_URL = 'https://raw.githubusercontent.com/swar/nba_api/master/src/nba_api/stats/library/data.py'

// En data.py cada lista es "nombre = [ [id, apellido, nombre, nombre completo, activo], ... ]" en sintaxis de Python
const readPythonList = (source, name) => {
  const match = source.match(new RegExp(`^${name} = (\\[[\\s\\S]*?^\\])`, 'm'))
  if(!match) throw new Error(`No está la lista ${name} en data.py`)
  return JSON.parse(match[1].replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/,(\s*\])/g, '$1'))
}

const main = async () => {
  const res = await fetch(SOURCE_URL)
  if(!res.ok) throw new Error(`${res.status} ${SOURCE_URL}`)
  const source = await res.text()

  const bySlug = new Map()
  for (const [, , , name, active] of [...readPythonList(source, 'players'), ...readPythonList(source, 'wnba_players')]) {
    const slug = slugify(name)
    // Mismo nombre en dos jugadores (padre e hijo, NBA y WNBA): uno solo, el que esté en activo
    if(!bySlug.has(slug) || active) bySlug.set(slug, [name, slug, active ? 1 : 0])
  }

  const players = [...bySlug.values()].sort((a, b) => a[1].localeCompare(b[1]))
  await writeFile('data/players.json', `[\n${players.map(e => JSON.stringify(e)).join(',\n')}\n]\n`)
  console.log(`${players.length} jugadores`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
