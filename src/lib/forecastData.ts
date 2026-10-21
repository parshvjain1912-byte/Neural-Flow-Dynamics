// Loads the ECMWF grids served by the Python backend (/backend/main.py).
// Every request is for one UTC date = four 6-hourly frames of raw SI-unit grids.
// Unit conversion (K -> °C, Pa -> hPa, m -> mm) happens in the WebGL layer.

const API_BASE = import.meta.env.VITE_WEATHER_API_URL ?? "/weather-api";
const MAX_CACHED_DATES = 3;

export type Frame = Record<string, Float32Array>;

export type ForecastGrid = {
  date: string;
  coords: { latitude: number[]; longitude: number[] };
  /** UTC clock time ("HH:MM") of every frame. */
  times: string[];
  frames: Frame[];
};

type AvailableDates = { dates: string[]; forecastDates: Set<string>; forecastRun: string | null };

let availableDates: Promise<AvailableDates> | null = null;
const grids = new Map<string, Promise<ForecastGrid>>();
let sharedCoords: ForecastGrid["coords"] | null = null;

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { signal });
  if (!response.ok) throw new Error(`Weather API returned ${response.status}`);
  return response.json() as Promise<T>;
}

function loadAvailableDates(): Promise<AvailableDates> {
  availableDates ??= getJson<{ dates?: string[]; forecast_dates?: string[]; forecast_run?: string | null }>(
    "/available-dates"
  )
    .then((json) => ({
      dates: json.dates ?? [],
      forecastDates: new Set(json.forecast_dates ?? []),
      forecastRun: json.forecast_run ?? null,
    }))
    .catch((error) => {
      availableDates = null; // allow a retry after the backend comes up
      throw error;
    });
  return availableDates;
}

// The grid is identical for every date; reuse one object so the WebGL layer
// keeps its mesh instead of rebuilding it whenever the date changes.
function reuseCoords(latitude: number[], longitude: number[]) {
  const same =
    sharedCoords &&
    sharedCoords.latitude.length === latitude.length &&
    sharedCoords.longitude.length === longitude.length &&
    sharedCoords.latitude[0] === latitude[0] &&
    sharedCoords.longitude[0] === longitude[0];
  if (!same) sharedCoords = { latitude, longitude };
  return sharedCoords!;
}

/** Decode the backend's binary format: [u32 header length][JSON header][pad to 4][float32 data]. */
function decode(date: string, buffer: ArrayBuffer): ForecastGrid {
  if (buffer.byteLength < 4) throw new Error("Empty weather response");
  const headerLength = new DataView(buffer).getUint32(0, true);
  const dataStart = Math.ceil((4 + headerLength) / 4) * 4;
  if (dataStart > buffer.byteLength) throw new Error("Invalid weather header");

  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength))) as {
    variables: string[];
    shape: [number, number, number, number]; // time, variable, lat, lon
    times: string[];
    latitude: number[];
    longitude: number[];
  };
  const [timeCount, variableCount, rows, cols] = meta.shape;
  const valueCount = timeCount * variableCount * rows * cols;
  if (buffer.byteLength - dataStart !== valueCount * 4) throw new Error("Invalid weather data size");

  const values = new Float32Array(buffer, dataStart, valueCount);
  const size = rows * cols;
  const frames: Frame[] = Array.from({ length: timeCount }, (_, t) =>
    Object.fromEntries(
      meta.variables.map((name, v) => {
        const start = (t * variableCount + v) * size;
        return [name, values.subarray(start, start + size)];
      })
    )
  );

  return { date, coords: reuseCoords(meta.latitude, meta.longitude), times: meta.times, frames };
}

async function download(date: string): Promise<ForecastGrid> {
  const { dates, forecastDates, forecastRun } = await loadAvailableDates();
  if (!dates.includes(date)) throw new Error(`No ECMWF data for ${date}`);

  const query = `date=${encodeURIComponent(date)}`;
  const path = forecastDates.has(date)
    ? `/forecast-binary?${query}&run=${encodeURIComponent(forecastRun ?? "")}`
    : `/weather-binary?${query}`;

  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) throw new Error(`Weather API returned ${response.status}`);
  return decode(date, await response.arrayBuffer());
}

export function fetchForecastGrid(date: string): Promise<ForecastGrid> {
  let grid = grids.get(date);
  if (!grid) {
    grid = download(date).catch((error) => {
      grids.delete(date);
      throw error;
    });
    grids.set(date, grid);
    while (grids.size > MAX_CACHED_DATES) grids.delete(grids.keys().next().value!);
  }
  return grid;
}

/** Index of the frame whose clock time is closest to the given UTC instant. */
export function closestFrameIndex(grid: ForecastGrid, utcMs: number): number {
  const instant = new Date(utcMs);
  const minutes = instant.getUTCHours() * 60 + instant.getUTCMinutes();
  let best = 0;
  let bestDistance = Infinity;
  grid.times.forEach((time, index) => {
    const [h, m] = time.split(":").map(Number);
    const distance = Math.abs(h * 60 + (m || 0) - minutes);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}
