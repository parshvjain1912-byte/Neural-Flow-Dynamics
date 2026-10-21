# Neural Flow Dynamics · Atmos

Atmos is a weather dashboard (forecast, alerts, air quality, route planner, assistant). Its **weather map**
shows ECMWF data (temperature, wind, pressure, rainfall) served by the Python backend and drawn with the
WebGL layer from the standalone map app.

## Layout

```
backend/    FastAPI service: ERA5 + ECMWF IFS grids as compact binary (port 8000)
frontend/   Standalone full-screen map app. Its WebGLWeatherLayer.jsx and Colorscales.js
            are also imported by the website, so there is one renderer and one set of colours.
src/        The Atmos website (React + TypeScript)
  App.tsx                       Dashboard shell and all tabs
  components/ForecastMap.tsx    The map panel (MapLibre + ECMWF layer, legend, wind particles)
  components/TinyFishAdvisories.tsx, Chart.tsx, Metric.tsx
  lib/weather.ts                Open-Meteo requests, formatting helpers, alert rules
  lib/forecastData.ts           Loads/decodes backend grids, picks the frame for the selected hour
  lib/mapLayers.ts              Map layer list
server.mjs  Optional TinyFish advisories proxy (port 8787, needs TINYFISH_API_KEY)
```

## Run

```bash
# 1. Weather API
cd backend && pip install -r requirements.txt && uvicorn main:app --port 8000

# 2. Website (http://localhost:5175)
npm install && npm run dev

# 3. Optional: official-advisory search
TINYFISH_API_KEY=... npm run server

# Standalone map only
cd frontend && npm install && npm run dev
```

In dev, Vite proxies `/weather-api/*` to the backend (`/api/*` on port 8000) and `/api/*` to `server.mjs`.
Set `VITE_WEATHER_API_URL` to point the map at a deployed backend.

## How the map follows the dashboard

The hour selected on the dashboard timeline is converted to UTC. `forecastData.ts` fetches that UTC date
(ERA5 for past dates, the IFS forecast run for future dates) and `ForecastMap` shows the 6-hourly frame closest
to the selected hour. Dates the backend has no data for hide the layer and show a message.

## Checks

`npm run lint`, `npx tsc -b`, `npm run build`
