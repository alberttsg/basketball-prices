# basketball-prices

Precios diarios de cartas de baloncesto (NBA y WNBA) para la app de escáner de cartas de basket, a partir de las
ventas de [TheCardAPI](https://www.thecardapi.com) (eBay, Fanatics Collect, Goldin...).

Una tarea de GitHub Actions (`.github/workflows/update-prices.yml`) ejecuta cada día `node build.mjs public` y
publica el resultado en la rama `gh-pages` (GitHub Pages). El formato de los archivos está al principio de
`build.mjs`. Solo se publica el resumen diario de cada carta, no las ventas sueltas.

## Archivos

- `build.mjs`: descarga las ventas, las agrupa por carta y genera el feed.
- `cardParser.js`: lee jugador, año, set, número, parallel, tirada y grado de un texto. **Es el mismo archivo que
  usa la app** (`basketball/Components/Prices/cardParser.js`): si se cambia aquí, hay que copiarlo allí.
- `data/players.json`: jugadores de la NBA y la WNBA (de [nba_api](https://github.com/swar/nba_api)). Se
  regenera con `node players.mjs` al empezar cada temporada.
- `data/rules.json`: sets, parallels, equipos, alias de jugadores y palabras que descartan una venta. La app
  lo descarga del feed, así que los cambios llegan sin publicar una versión nueva.

## Configuración en GitHub

1. Secreto del repositorio `THECARDAPI_KEY` (Settings > Secrets and variables > Actions).
2. Variable del repositorio `LOOKBACK_DAYS`: días hacia atrás del plan de TheCardAPI (gratis: 3, Starter: 14).
3. Settings > Pages: rama `gh-pages`, carpeta `/` (después de la primera ejecución).

## Probar en local

```
THECARDAPI_KEY=... LOOKBACK_DAYS=1 node build.mjs public
```
