import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TinyFishAdvisories from "./components/TinyFishAdvisories";
import {
  Activity, AirVent, AlertTriangle, CalendarDays,
  ChevronDown, Cloud, CloudRain, Compass, Droplets,
  Gauge, Heart, History, MapPin, Menu, MessageCircle,
  Moon, Navigation, Pause, Play, Plus, RefreshCw, Route,
  Search, Send, Settings2, Share2, ShieldAlert, Thermometer,
  Wind, X, Maximize2, Minimize2
} from "lucide-react";
import {
  Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./App.css";
// @ts-expect-error NFD renderer is maintained as JavaScript.
import WebGLWeatherLayer from "./nfd/WebGLWeatherLayer.jsx";
import { fetchNFDForecast, type NFDForecast } from "./nfd/binaryForecast";
import { fetchJsonCached, isAbortError, RateLimitError } from "./lib/openMeteo";

setWorkerUrl(workerUrl);

type Place = { name: string; country?: string; lat: number; lon: number };

type Hour = {
  time: string;
  /** Absolute instant in ms since epoch (the `time` field is local wall-clock). */
  utc: number;
  temperature: number;
  feelsLike: number;
  wind: number;
  direction: number;
  rain: number;
  humidity: number;
  clouds: number;
  pressure: number;
  dewPoint: number;
  code: number;
};

type Day = {
  date: string;
  min: number;
  max: number;
  rain: number;
  sunrise: string;
  sunset: string;
  code: number;
};

type WeatherData = {
  current: Hour;
  hourly: Hour[];
  daily: Day[];
  timezone: string;
  updated: string;
};

type Layer = "wind" | "temperature" | "rain" | "clouds" | "humidity";
type Unit = "C" | "F";
type Tab = "overview" | "forecast" | "alerts" | "intelligence" | "routes" | "environment" | "settings";

const DEFAULT_PLACE: Place = {
  name: "New Delhi", country: "India", lat: 28.6139, lon: 77.209
};

const API = "https://api.open-meteo.com/v1/forecast";
const AQI_API = "https://air-quality-api.open-meteo.com/v1/air-quality";

const WEATHER_LABEL: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog", 51: "Light drizzle",
  53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain",
  65: "Heavy rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
  80: "Rain showers", 81: "Rain showers", 82: "Heavy rain showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Severe thunderstorm"
};

function weatherLabel(code: number) {
  return WEATHER_LABEL[code] ?? "Conditions unavailable";
}

function weatherIcon(code: number) {
  if (code >= 95) return "⛈";
  if (code >= 71) return "❄️";
  if (code >= 51 || (code >= 80 && code <= 82)) return "🌧";
  if (code >= 45) return "🌫";
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤";
  return "☁️";
}

function formatTime(value: string, timezone?: string) {
  if (!value) return "--:--";

  // Open-Meteo timestamps are local wall-clock times for the returned timezone.
  const match = value.match(/T(\d{2}):(\d{2})/);
  if (match) return `${match[1]}:${match[2]}`;

  return new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(timezone ? { timeZone: timezone } : {})
  }).format(new Date(value));
}

function formatDay(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short"
  });
}

function temperature(value: number, unit: Unit) {
  return Math.round(unit === "C" ? value : value * 9 / 5 + 32);
}

function windUnit(value: number, unit: string) {
  if (unit === "mph") return value * 0.621371;
  if (unit === "kn") return value * 0.539957;
  return value;
}

function windDirection(degrees: number) {
  return [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"
  ][Math.round(degrees / 22.5) % 16];
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function getForecast(
  place: Place,
  signal?: AbortSignal
): Promise<WeatherData> {
  const params = new URLSearchParams({
    latitude: String(place.lat),
    longitude: String(place.lon),
    current: [
      "temperature_2m", "apparent_temperature", "relative_humidity_2m",
      "precipitation", "weather_code", "wind_speed_10m", "wind_direction_10m",
      "cloud_cover", "surface_pressure", "dew_point_2m"
    ].join(","),
    hourly: [
      "temperature_2m", "apparent_temperature", "precipitation_probability",
      "wind_speed_10m", "wind_direction_10m", "relative_humidity_2m",
      "cloud_cover", "surface_pressure", "dew_point_2m", "weather_code"
    ].join(","),
    daily: [
      "temperature_2m_max", "temperature_2m_min",
      "precipitation_probability_max", "sunrise", "sunset", "weather_code"
    ].join(","),
    forecast_days: "14",
    timezone: "auto",
    wind_speed_unit: "kmh"
  });

  const response = await fetch(`${API}?${params}`, { signal });

  if (!response.ok) {
    throw new Error(`Forecast service returned ${response.status}`);
  }

  const json = await response.json();
  const c = json.current;
  const h = json.hourly;
  const d = json.daily;

  if (!c || !h?.time?.length || !d?.time?.length) {
    throw new Error("The forecast service returned incomplete data.");
  }

  // Convert local wall-clock forecast timestamps into absolute UTC instants.
  const utcOffsetMs = number(json.utc_offset_seconds) * 1000;

  const hourly: Hour[] = h.time.map((time: string, i: number) => ({
    time,
    utc: Date.parse(`${time}Z`) - utcOffsetMs,
    temperature: number(h.temperature_2m[i]),
    feelsLike: number(h.apparent_temperature[i]),
    wind: number(h.wind_speed_10m[i]),
    direction: number(h.wind_direction_10m[i]),
    rain: number(h.precipitation_probability[i]),
    humidity: number(h.relative_humidity_2m[i]),
    clouds: number(h.cloud_cover[i]),
    pressure: number(h.surface_pressure[i]),
    dewPoint: number(h.dew_point_2m[i]),
    code: number(h.weather_code[i])
  }));

  const currentTime = String(c.time).slice(0, 13);

  const current = {
    ...(hourly.find(v => v.time.slice(0, 13) === currentTime) ?? hourly[0])
  };

  current.temperature = number(c.temperature_2m);
  current.feelsLike = number(c.apparent_temperature);
  current.wind = number(c.wind_speed_10m);
  current.direction = number(c.wind_direction_10m);
  current.humidity = number(c.relative_humidity_2m);
  current.rain = number(c.precipitation);
  current.clouds = number(c.cloud_cover);
  current.pressure = number(c.surface_pressure);
  current.dewPoint = number(c.dew_point_2m);
  current.code = number(c.weather_code);

  const daily: Day[] = d.time.map((date: string, i: number) => ({
    date,
    min: number(d.temperature_2m_min[i]),
    max: number(d.temperature_2m_max[i]),
    rain: number(d.precipitation_probability_max[i]),
    sunrise: d.sunrise[i],
    sunset: d.sunset[i],
    code: number(d.weather_code[i])
  }));

  return {
    current,
    hourly,
    daily,
    timezone: json.timezone ?? "UTC",
    updated: new Date().toISOString()
  };
}

async function geocode(query: string): Promise<Place[]> {
  const params = new URLSearchParams({
    name: query,
    count: "7",
    language: "en",
    format: "json"
  });

  const response = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?${params}`
  );

  if (!response.ok) throw new Error("Location search failed.");

  const json = await response.json();

  return (json.results ?? []).map((r: Record<string, unknown>) => ({
    name: String(r.name ?? "Unknown place"),
    country: String(r.country ?? ""),
    lat: number(r.latitude),
    lon: number(r.longitude)
  }));
}

async function getAirQuality(place: Place) {
  const params = new URLSearchParams({
    latitude: String(place.lat),
    longitude: String(place.lon),
    current: "us_aqi,european_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,ozone",
    timezone: "auto"
  });

  const response = await fetch(`${AQI_API}?${params}`);

  if (!response.ok) {
    throw new Error("Air-quality data is unavailable.");
  }

  const json = await response.json();
  return json.current;
}

type WeatherAlert = {
  title: string;
  detail: string;
  level: "high" | "medium" | "low";
  time?: string;
};

function makeAlerts(
  data: WeatherData,
  windThreshold = 40,
  rainThreshold = 70
): WeatherAlert[] {
  const alerts: WeatherAlert[] = [];
  const now = Date.now();
  const next24Hours = data.hourly
    .filter(hour => hour.utc >= now && hour.utc <= now + 24 * 60 * 60 * 1000)
    .slice(0, 24);

  const current = data.current;
  const hoursToCheck = next24Hours.length
    ? next24Hours
    : [current];

  const addForecastAlert = (
    title: string,
    detail: string,
    level: WeatherAlert["level"],
    hour: Hour
  ) => {
    alerts.push({
      title,
      detail: `${detail} Expected around ${formatTime(hour.time, data.timezone)}.`,
      level,
      time: hour.time
    });
  };

  // Current conditions are checked separately because current.rain represents
  // measured precipitation, while hourly.rain represents precipitation probability.
  if (current.wind >= windThreshold) {
    alerts.push({
      title: "Strong winds",
      detail: `Current forecast wind speed is ${Math.round(current.wind)} km/h, at or above your ${windThreshold} km/h threshold.`,
      level: current.wind >= windThreshold + 20 ? "high" : "medium",
      time: current.time
    });
  }

  if (current.temperature >= 40) {
    alerts.push({
      title: "High temperature",
      detail: `Air temperature is ${Math.round(current.temperature)}°C. Heat exposure may be a concern.`,
      level: current.temperature >= 45 ? "high" : "medium",
      time: current.time
    });
  } else if (current.temperature <= 3) {
    alerts.push({
      title: "Low temperature",
      detail: `Air temperature is ${Math.round(current.temperature)}°C. Cold-sensitive people and exposed plants may need extra care.`,
      level: current.temperature <= 0 ? "high" : "medium",
      time: current.time
    });
  }

  if (current.code >= 95) {
    alerts.push({
      title: "Thunderstorm conditions",
      detail: `${weatherLabel(current.code)} is present in the current forecast. Check official local warnings and avoid exposed outdoor areas.`,
      level: "high",
      time: current.time
    });
  }

  for (const hour of hoursToCheck) {


    if (hour.rain >= rainThreshold) {
      addForecastAlert(
        "High precipitation probability",
        `${Math.round(hour.rain)}% chance of precipitation`,
        hour.rain >= 90 ? "high" : "medium",
        hour
      );
    }

    if (hour.wind >= windThreshold && hour.utc !== current.utc) {
      addForecastAlert(
        "Strong winds forecast",
        `Wind speed may reach ${Math.round(hour.wind)} km/h`,
        hour.wind >= windThreshold + 20 ? "high" : "medium",
        hour
      );
    }

    if (hour.temperature >= 40 && hour.utc !== current.utc) {
      addForecastAlert(
        "High temperature forecast",
        `Temperature may reach ${Math.round(hour.temperature)}°C`,
        hour.temperature >= 45 ? "high" : "medium",
        hour
      );
    } else if (hour.temperature <= 3 && hour.utc !== current.utc) {
      addForecastAlert(
        "Low temperature forecast",
        `Temperature may fall to ${Math.round(hour.temperature)}°C`,
        hour.temperature <= 0 ? "high" : "medium",
        hour
      );
    }

    if (hour.code >= 95 && hour.utc !== current.utc) {
      addForecastAlert(
        "Thunderstorm forecast",
        weatherLabel(hour.code),
        "high",
        hour
      );
    }
  }

  // Keep the panel useful without flooding it with repeated hourly alerts.
  const unique = new Map<string, WeatherAlert>();
  for (const alert of alerts) {
    const key = `${alert.title}|${alert.time ?? ""}`;
    if (!unique.has(key)) unique.set(key, alert);
  }

  const result = [...unique.values()]
    .sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 };
      return rank[a.level] - rank[b.level] ||
        (a.time ?? "").localeCompare(b.time ?? "");
    })
    .slice(0, 12);

  if (!result.length) {
    return [{
      title: "No threshold alerts",
      detail: "The current conditions and next 24 hours do not cross Atmos's configured thresholds. This is not an official all-clear.",
      level: "low"
    }];
  }

  return result;
}

function Chart({
  values,
  color = "#42d9c0",
  suffix = ""
}: {
  values: number[];
  color?: string;
  suffix?: string;
}) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(1, max - min);

  const points = values.map((v, i) =>
    `${values.length < 2 ? 0 : i / (values.length - 1) * 300},${85 - (v - min) / span * 65}`
  ).join(" ");

  return (
    <div className="chart-wrap">
      <svg viewBox="0 0 300 100" role="img" aria-label="Forecast trend chart">
        <defs>
          <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity=".25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {[20, 42, 64, 86].map(y => (
          <line
            key={y}
            x1="0"
            x2="300"
            y1={y}
            y2={y}
            stroke="currentColor"
            opacity=".08"
          />
        ))}

        <polygon points={`0,100 ${points} 300,100`} fill="url(#chart-fill)" />

        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {values.map((v, i) => {
          const x = values.length < 2 ? 0 : i / (values.length - 1) * 300;
          const y = 85 - (v - min) / span * 65;

          return (
            <circle key={i} cx={x} cy={y} r="2.6" fill={color}>
              <title>{Math.round(v)}{suffix}</title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}

/* ============================================================
   MAP GRID DATA AND VIEWPORT HELPERS — STAGE 1.1
   ============================================================ */

type GridPoint = {
  lat: number;
  lon: number;
  times: string[];
  temperature: number[];
  wind: number[];
  direction: number[];
  rain: number[];
  clouds: number[];
  humidity: number[];
};

const GRID_TTL_MS = 15 * 60_000;

function parseGrid(payload: unknown): GridPoint[] {
  const locations = Array.isArray(payload) ? payload : [payload];

  const series = (value: unknown, length: number) =>
    Array.from({ length }, (_, i) => {
      const v = Array.isArray(value) ? value[i] : undefined;

      return typeof v === "number" && Number.isFinite(v) ? v : NaN;
    });

  return locations.flatMap((raw): GridPoint[] => {
    const location = raw as {
      latitude?: unknown;
      longitude?: unknown;
      hourly?: Record<string, unknown>;
    } | null;

    const hourly = location?.hourly;
    const times = hourly?.time;

    if (!Array.isArray(times) || !times.length) return [];

    const n = times.length;

    return [{
      lat: number(location?.latitude),
      lon: number(location?.longitude),
      times: times.map(String),
      temperature: series(hourly?.temperature_2m, n),
      wind: series(hourly?.wind_speed_10m, n),
      direction: series(hourly?.wind_direction_10m, n),
      rain: series(hourly?.precipitation_probability, n),
      clouds: series(hourly?.cloud_cover, n),
      humidity: series(hourly?.relative_humidity_2m, n)
    }];
  });
}

/* Weather map with sampled forecast overlays and animated wind flow. */

/* Weather map with cached forecast grids, interpolated colour fields and wind particles. */
function MapPanel({ place, layer, onSelect, hour }: {
  place: Place;
  layer: Layer;
  onSelect: (p: Place) => void;
  hour: Hour | undefined;
}) {
  type Sample = {
    lat: number;
    lon: number;
    temperature: number;
    wind: number;
    direction: number;
    rain: number;
    clouds: number;
    humidity: number;
  };

  type Particle = {
    x: number;
    y: number;
    age: number;
    life: number;
  };

  const containerRef = useRef<HTMLDivElement | null>(null);
  const heatCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const particleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const nfdLayerRef = useRef<any>(null);
  const [nfdLayerReady, setNfdLayerReady] = useState(false);
  const [nfdForecast, setNfdForecast] = useState<NFDForecast | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const selectRef = useRef(onSelect);
  const layerRef = useRef(layer);
  const playingRef = useRef(true);
  const hourRef = useRef(hour);

  const cacheRef = useRef(
    new Map<string, { expiresAt: number; data: GridPoint[] }>()
  );

  const [fullscreen, setFullscreen] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [grid, setGrid] = useState<GridPoint[]>([]);
  const [mapError, setMapError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    selectRef.current = onSelect;
    layerRef.current = layer;
    playingRef.current = playing;
    hourRef.current = hour;
  }, [onSelect, layer, playing, hour]);

  const colorFor = (value: number, selectedLayer: Layer): [number, number, number] => {
    const stops: [number, [number, number, number]][] =
      selectedLayer === "temperature"
        ? [
          [-20, [72, 72, 220]],
          [-5, [60, 145, 255]],
          [5, [50, 205, 235]],
          [15, [65, 220, 155]],
          [25, [250, 220, 75]],
          [35, [255, 125, 55]],
          [45, [225, 45, 75]]
        ]
        : selectedLayer === "rain"
          ? [
            [0, [70, 35, 150]],
            [10, [45, 105, 235]],
            [25, [30, 195, 235]],
            [50, [45, 215, 130]],
            [75, [245, 225, 60]],
            [90, [255, 125, 40]],
            [100, [230, 45, 95]]
          ]
          : selectedLayer === "clouds"
            ? [
              [0, [255, 220, 100]],
              [20, [180, 220, 230]],
              [40, [115, 185, 220]],
              [60, [85, 130, 180]],
              [80, [65, 80, 140]],
              [100, [40, 35, 90]]
            ]
            : selectedLayer === "humidity"
              ? [
                [0, [245, 205, 75]],
                [20, [160, 220, 100]],
                [40, [60, 210, 145]],
                [60, [35, 190, 210]],
                [80, [65, 125, 240]],
                [100, [130, 65, 220]]
              ]
              : [
                [0, [80, 220, 180]],
                [5, [45, 205, 210]],
                [15, [55, 145, 255]],
                [25, [110, 90, 245]],
                [40, [215, 70, 190]],
                [60, [255, 100, 90]],
                [90, [255, 220, 95]]
              ];

    if (value <= stops[0][0]) return stops[0][1];

    for (let i = 1; i < stops.length; i++) {
      const [upperValue, upperColor] = stops[i];
      const [lowerValue, lowerColor] = stops[i - 1];

      if (value <= upperValue) {
        const t = (value - lowerValue) / (upperValue - lowerValue);
        return [
          Math.round(lowerColor[0] + (upperColor[0] - lowerColor[0]) * t),
          Math.round(lowerColor[1] + (upperColor[1] - lowerColor[1]) * t),
          Math.round(lowerColor[2] + (upperColor[2] - lowerColor[2]) * t)
        ];
      }
    }

    return stops[stops.length - 1][1];
  };

  const valueFor = (sample: Sample, selectedLayer: Layer) => {
    switch (selectedLayer) {
      case "temperature": return sample.temperature;
      case "rain": return sample.rain;
      case "clouds": return sample.clouds;
      case "humidity": return sample.humidity;
      default: return sample.wind;
    }
  };

  // The selected forecast hour is read from the already-loaded grid.
  // Changing the timeline does not initiate a weather-grid request.
  const samples = useMemo<Sample[]>(() => {
    if (!grid.length) return [];

    const selectedTime = hour?.time?.slice(0, 13);

    return grid.map(point => {
      let index = selectedTime
        ? point.times.findIndex(t => t.slice(0, 13) === selectedTime)
        : -1;

      if (index < 0) {
        index = 0;
      }

      const read = (values: number[]) => {
        const value = values[index];
        return typeof value === "number" && Number.isFinite(value)
          ? value
          : 0;
      };

      return {
        lat: point.lat,
        lon: point.lon,
        temperature: read(point.temperature),
        wind: read(point.wind),
        direction: read(point.direction),
        rain: read(point.rain),
        clouds: read(point.clouds),
        humidity: read(point.humidity)
      };
    });
  }, [grid, hour?.time]);

  // Initialise the map once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new MapLibreMap({
      container,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [place.lon, place.lat],
      zoom: 5,
      minZoom: 1,
      maxZoom: 14,
      attributionControl: { compact: true }
    });

    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: true }), "top-right");

    map.once("load", () => {
      const renderer = new WebGLWeatherLayer({
        id: "nfd-weather-webgl",
        alpha: 0.82,
        particleCount: 5000,
      });

      const firstSymbol = map.getStyle().layers?.find(
        (styleLayer) => styleLayer.type === "symbol"
      );

      map.addLayer(renderer as never, firstSymbol?.id);
      nfdLayerRef.current = renderer;
      setNfdLayerReady(true);
    });

    const markerElement = document.createElement("div");
    markerElement.className = "map-marker";
    markerElement.innerHTML = "<span></span>";

    markerRef.current = new Marker({ element: markerElement })
      .setLngLat([place.lon, place.lat])
      .addTo(map);

    map.on("click", event => {
      selectRef.current({
        name: `${event.lngLat.lat.toFixed(3)}, ${event.lngLat.lng.toFixed(3)}`,
        country: "Map location",
        lat: event.lngLat.lat,
        lon: event.lngLat.lng
      });
    });

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container);

    return () => {
      observer.disconnect();
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
      nfdLayerRef.current = null;
      setNfdLayerReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    map.flyTo({
      center: [place.lon, place.lat],
      duration: 500
    });

    markerRef.current?.setLngLat([place.lon, place.lat]);
  }, [place.lat, place.lon]);

  const useNFD =
    layer === "wind" || layer === "temperature" || layer === "rain";

  // Load NFD's binary forecast for the active timeline date.
  useEffect(() => {
    const date =
      hour?.time?.slice(0, 10) ??
      new Date().toISOString().slice(0, 10);

    const controller = new AbortController();
    let disposed = false;

    void fetchNFDForecast(date, controller.signal)
      .then((forecast) => {
        if (!disposed) setNfdForecast(forecast);
      })
      .catch((error: unknown) => {
        if (disposed || controller.signal.aborted) return;
        console.error("[Atmos/NFD] Forecast load failed:", error);
      });

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [hour?.time?.slice(0, 10)]);

  // Render NFD's forecast at the selected timeline hour.
  useEffect(() => {
    const map = mapRef.current;
    const renderer = nfdLayerRef.current;

    if (!map || !renderer || !nfdLayerReady || !nfdForecast) return;

    const supported =
      layer === "wind" || layer === "temperature" || layer === "rain";

    renderer.enabled = supported;
    map.triggerRepaint();

    if (!supported) return;

    const selectedHour = Number(hour?.time?.slice(11, 13) ?? "12");
    const frameIndex = Math.max(
      0,
      Math.min(nfdForecast.frames.length - 1, Math.floor(selectedHour / 6))
    );
    const frame = nfdForecast.frames[frameIndex];

    if (!frame) return;

    renderer.update(
      nfdForecast.coords,
      frame,
      layer === "rain" ? "rainfall" : layer,
      layer === "wind" && playing
    );

    map.triggerRepaint();
  }, [nfdLayerReady, nfdForecast, layer, hour?.time, playing]);

  // Fetch a grid only when the map viewport changes.
  // A snapped viewport key avoids requests for tiny pans.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let disposed = false;
    let debounce = 0;
    let controller: AbortController | null = null;
    let lastKey = "";

    const loadGrid = async () => {
      const bounds = map.getBounds();
      const snap = (value: number) => Math.round(value * 2) / 2;

      const south = Math.max(-75, snap(bounds.getSouth()));
      const north = Math.min(75, snap(bounds.getNorth()));
      const west = snap(bounds.getWest());
      const east = snap(bounds.getEast());

      const key = [south, north, west, east].join(":");
      if (key === lastKey) return;
      lastKey = key;

      const cached = cacheRef.current.get(key);

      if (cached && cached.expiresAt > Date.now()) {
        setGrid(cached.data);
        setMapError("");
        setLoading(false);
        return;
      }

      const rows = 7;
      const columns = 9;
      const points: { lat: number; lon: number }[] = [];

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < columns; col++) {
          points.push({
            lat: south + ((north - south) * row) / (rows - 1),
            lon: west + ((east - west) * col) / (columns - 1)
          });
        }
      }

      controller?.abort();
      controller = new AbortController();
      setLoading(true);

      const params = new URLSearchParams({
        latitude: points.map(p => p.lat.toFixed(3)).join(","),
        longitude: points.map(p => p.lon.toFixed(3)).join(","),
        hourly: [
          "temperature_2m",
          "wind_speed_10m",
          "wind_direction_10m",
          "precipitation_probability",
          "cloud_cover",
          "relative_humidity_2m"
        ].join(","),
        forecast_days: "2",
        timezone: "auto",
        wind_speed_unit: "kmh"
      });

      try {
        const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
        const payload = await fetchJsonCached<unknown>(url, {
          ttlMs: GRID_TTL_MS,
          signal: controller.signal
        });
        const result = parseGrid(payload);

        if (disposed || controller.signal.aborted) return;
        if (result.length === 0) {
          throw new Error("The weather API returned no usable grid data.");
        }

        cacheRef.current.set(key, {
          expiresAt: Date.now() + GRID_TTL_MS,
          data: result
        });
        setGrid(result);
        setMapError("");
      } catch (error: unknown) {
        if (
          disposed ||
          controller.signal.aborted ||
          isAbortError(error)
        ) {
          return;
        }

        console.error("Atmos weather grid failed:", error);
        if (error instanceof RateLimitError) {
          const retrySeconds = Math.max(
            1,
            Math.ceil((error.retryAt - Date.now()) / 1000)
          );
          setMapError(
            `Weather service rate limit reached. Try again in ${retrySeconds} seconds.`
          );
        } else {
          setMapError(
            error instanceof Error
              ? `Weather overlay unavailable: ${error.message}`
              : "Weather overlay unavailable. Showing the last loaded data."
          );
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    const scheduleLoad = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void loadGrid(), 500);
    };

    map.on("moveend", scheduleLoad);
    void loadGrid();

    return () => {
      disposed = true;
      window.clearTimeout(debounce);
      controller?.abort();
      map.off("moveend", scheduleLoad);
    };
  }, []);

  // Draw a continuous-looking interpolated colour field on its own canvas.
  useEffect(() => {
    const canvas = heatCanvasRef.current;
    const map = mapRef.current;
    if (!canvas || !map) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    let width = 0;
    let height = 0;
    let ratio = 1;

    const drawField = () => {
      const rect = canvas.getBoundingClientRect();
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;

      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      if (!samples.length) return;

      const selectedLayer = layerRef.current;

      // Wind is represented by animated particles only. Do not draw the
      // coloured interpolation field over the geographic basemap in this mode.
      if (selectedLayer === "wind") return;

      const points = samples.map(sample => ({
        sample,
        point: map.project([sample.lon, sample.lat])
      }));

      const radius = Math.max(80, Math.min(width, height) / 5.5);

      for (const item of points) {
        const { sample, point } = item;
        const [r, g, b] = colorFor(
          valueFor(sample, selectedLayer),
          selectedLayer
        );

        const gradient = context.createRadialGradient(
          point.x, point.y, 0,
          point.x, point.y, radius
        );

        gradient.addColorStop(0, `rgba(${r},${g},${b},0.62)`);
        gradient.addColorStop(0.45, `rgba(${r},${g},${b},0.30)`);
        gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);

        context.fillStyle = gradient;
        context.fillRect(
          point.x - radius,
          point.y - radius,
          radius * 2,
          radius * 2
        );
      }
    };

    const observer = new ResizeObserver(drawField);
    observer.observe(canvas);
    map.on("move", drawField);
    drawField();

    return () => {
      observer.disconnect();
      map.off("move", drawField);
      context.clearRect(0, 0, width, height);
    };
  }, [samples, layer, fullscreen]);

  // Animate wind particles independently so heatmap redraws cannot erase trails.
  useEffect(() => {
    const canvas = particleCanvasRef.current;
    const map = mapRef.current;
    if (!canvas || !map) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    let width = 0;
    let height = 0;
    let ratio = 1;
    let frame = 0;
    let lastFrame = 0;
    let particles: Particle[] = [];

    const resetParticles = () => {
      particles = Array.from({ length: 1350 }, () => ({
        x: Math.random() * Math.max(width, 1),
        y: Math.random() * Math.max(height, 1),
        age: Math.random() * 90,
        life: 70 + Math.random() * 90
      }));
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;

      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      resetParticles();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const clearTrails = () => {
      context.clearRect(0, 0, width, height);
      resetParticles();
    };

    const draw = (time: number) => {
      const delta = lastFrame
        ? Math.min((time - lastFrame) / 16.67, 2.5)
        : 1;

      lastFrame = time;

      if (layerRef.current !== "wind") {
        context.clearRect(0, 0, width, height);
      } else if (playingRef.current && samples.length) {
        // Fade particle trails using alpha erasure. Painting a dark colour
        // here accumulates an opaque layer over time and hides the map tiles.
        context.save();
        context.globalCompositeOperation = "destination-out";
        context.fillStyle = "rgba(0, 0, 0, 0.12)";
        context.fillRect(0, 0, width, height);
        context.restore();

        const points = samples.map(sample => {
          const angle = sample.direction * Math.PI / 180;

          return {
            ...sample,
            ...map.project([sample.lon, sample.lat]),
            // Meteorological direction describes where wind comes FROM.
            // Screen y increases downward, so north-to-south flow is positive y.
            u: -Math.sin(angle) * sample.wind,
            v: Math.cos(angle) * sample.wind
          };
        });

        const vectorAt = (x: number, y: number) => {
          let u = 0;
          let v = 0;
          let speed = 0;
          let total = 0;

          for (const point of points) {
            const dx = point.x - x;
            const dy = point.y - y;
            const distanceSquared = dx * dx + dy * dy;

            if (distanceSquared > 480 * 480) continue;

            const weight = 1 / (distanceSquared + 1600);
            u += point.u * weight;
            v += point.v * weight;
            speed += point.wind * weight;
            total += weight;
          }

          return total
            ? { u: u / total, v: v / total, speed: speed / total }
            : { u: 0, v: 0, speed: 0 };
        };

        for (const particle of particles) {
          particle.age += delta;

          if (
            particle.age >= particle.life ||
            particle.x < 0 || particle.x > width ||
            particle.y < 0 || particle.y > height
          ) {
            particle.x = Math.random() * Math.max(width, 1);
            particle.y = Math.random() * Math.max(height, 1);
            particle.age = 0;
            particle.life = 70 + Math.random() * 90;
            continue;
          }

          const vector = vectorAt(particle.x, particle.y);
          const speedScale = Math.max(0.15, Math.min(vector.speed / 12, 2.8));
          const dx = vector.u * 0.055 * speedScale * delta;
          const dy = vector.v * 0.055 * speedScale * delta;

          const [r, g, b] = colorFor(vector.speed, "wind");
          const opacity = Math.max(0.12, 1 - particle.age / particle.life);

          context.beginPath();
          context.moveTo(
            particle.x - dx * 9,
            particle.y - dy * 9
          );
          context.lineTo(particle.x, particle.y);
          context.strokeStyle = `rgba(${r},${g},${b},${opacity.toFixed(2)})`;
          context.lineWidth = 1.35;
          context.lineCap = "round";
          context.stroke();

          particle.x += dx;
          particle.y += dy;
        }
      }

      frame = requestAnimationFrame(draw);
    };

    const onMoveStart = () => clearTrails();
    map.on("movestart", onMoveStart);

    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      map.off("movestart", onMoveStart);
      observer.disconnect();
      context.clearRect(0, 0, width, height);
    };
  }, [samples, fullscreen]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const frame = requestAnimationFrame(() => map.resize());
    return () => cancelAnimationFrame(frame);
  }, [fullscreen]);

  const weatherValue = hour
    ? layer === "wind" ? `${Math.round(hour.wind)} km/h`
      : layer === "temperature" ? `${Math.round(hour.temperature)}°C`
        : layer === "rain" ? `${Math.round(hour.rain)}%`
          : layer === "clouds" ? `${Math.round(hour.clouds)}%`
            : `${Math.round(hour.humidity)}%`
    : "Loading weather…";

  const legend = layer === "wind"
    ? ["0", "5", "10", "15", "20", "30 m/s"]
    : layer === "temperature"
      ? ["−45°", "−25°", "0°", "25°", "50°C"]
      : layer === "rain"
        ? ["0", "1", "5", "10", "25", "50 mm / 6h"]
        : ["0", "20", "40", "60", "80", "100%"];

  const legendColors = legend.map((_, index) => {
    const values = layer === "wind"
      ? [0, 5, 10, 15, 20, 30]
      : layer === "temperature"
        ? [-45, -25, 0, 25, 50]
        : layer === "rain"
          ? [0, 1, 5, 10, 25, 50]
          : [0, 20, 40, 60, 80, 100];

    const [r, g, b] = colorFor(values[index], layer);
    return `rgb(${r},${g},${b})`;
  });

  return (
    <div
      className="map-shell"
      style={{
        position: fullscreen ? "fixed" : "relative",
        inset: fullscreen ? 0 : undefined,
        zIndex: fullscreen ? 9999 : undefined,
        width: "100%",
        height: fullscreen ? "100dvh" : "100%",
        minHeight: fullscreen ? undefined : 300,
        background: "#dce6eb"
      }}
    >
      <div
        ref={containerRef}
        className="weather-map"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />

      <canvas
        ref={heatCanvasRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 3,
          pointerEvents: "none",
          display: useNFD ? "none" : undefined
        }}
      />

      <canvas
        ref={particleCanvasRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 4,
          pointerEvents: "none",
          display: useNFD ? "none" : undefined
        }}
      />

      <div
        className="map-overlay map-overlay-top"
        style={{
          zIndex: 5,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap"
        }}
      >
        <div className="map-layer-pill">
          <span className="live-dot" />
          {layer.toUpperCase()} LAYER
        </div>

        <div className="map-weather-value">{weatherValue}</div>

        <button
          type="button"
          onClick={() => setPlaying(value => !value)}
          title={playing ? "Pause wind animation" : "Play wind animation"}
          aria-label={playing ? "Pause wind animation" : "Play wind animation"}
          style={{ cursor: "pointer", padding: "7px 10px", borderRadius: 8 }}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>

        <button
          type="button"
          onClick={() => setFullscreen(value => !value)}
          title={fullscreen ? "Exit fullscreen" : "Fullscreen map"}
          aria-label={fullscreen ? "Exit fullscreen map" : "Open fullscreen map"}
          style={{ cursor: "pointer", padding: "7px 10px", borderRadius: 8 }}
        >
          {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>

      <div
        aria-label={`${layer} colour scale`}
        style={{
          position: "absolute",
          zIndex: 5,
          left: 12,
          bottom: 44,
          width: "min(310px, calc(100% - 24px))",
          padding: "10px 12px",
          borderRadius: 10,
          color: "#fff",
          background: "rgba(8, 18, 32, 0.82)",
          backdropFilter: "blur(8px)",
          pointerEvents: "none"
        }}
      >
        <div style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.12em",
          marginBottom: 7,
          opacity: 0.85
        }}>
          {layer === "wind"
            ? "WIND SPEED · M/S"
            : layer === "temperature"
              ? "TEMPERATURE · °C"
              : layer === "rain"
                ? "PRECIPITATION · MM / 6H"
                : layer.toUpperCase()}
        </div>

        <div style={{
          height: 8,
          borderRadius: 99,
          background: `linear-gradient(90deg, ${legendColors.join(", ")})`
        }} />

        <div style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 4,
          marginTop: 5,
          fontSize: 9,
          opacity: 0.9
        }}>
          {legend.map(label => <span key={label}>{label}</span>)}
        </div>
      </div>

      {(mapError || loading) && (
        <div
          role="status"
          style={{
            position: "absolute",
            zIndex: 8,
            right: 10,
            bottom: 12,
            maxWidth: "70%",
            padding: "8px 10px",
            borderRadius: 8,
            color: "#fff",
            background: "rgba(15,25,35,.88)",
            fontSize: 11
          }}
        >
          {mapError || "Loading weather field…"}
        </div>
      )}

      <div className="map-overlay map-overlay-bottom" style={{ zIndex: 5 }}>
        <span>{place.name}</span>
        <span>{place.lat.toFixed(2)}°, {place.lon.toFixed(2)}°</span>
      </div>

      <div className="map-disclaimer" style={{ zIndex: 5 }}>
        Open-Meteo forecast samples · Interpolated weather visualisation
      </div>
    </div>
  );
}

function Metric({
  icon,
  title,
  value,
  detail
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-title">
        {icon}
        <small>{title}</small>
      </div>
      <b className="metric-value">{value}</b>
      <span>{detail}</span>
    </div>
  );
}

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

function assistantReply(
  message: string,
  weather: WeatherData,
  place: Place,
  unit: Unit
) {
  const text = message.toLowerCase();
  const c = weather.current;

  if (text.includes("rain") || text.includes("umbrella")) {
    return `For ${place.name}, the selected forecast hour has a ${Math.round(c.rain)}% precipitation probability. Conditions are ${weatherLabel(c.code).toLowerCase()}. Check the hourly forecast before heading out.`;
  }

  if (text.includes("wind")) {
    return `Wind at ${place.name} is around ${Math.round(c.wind)} km/h from the ${windDirection(c.direction)} (${Math.round(c.direction)}°). ${c.wind >= 40 ? "That is strong enough to pay attention to, especially outdoors." : "Current forecast wind speed is below the default strong-wind threshold."}`;
  }

  if (
    text.includes("tomorrow") ||
    text.includes("forecast") ||
    text.includes("week")
  ) {
    const day = weather.daily[1];

    if (!day) {
      return "I don't have tomorrow's daily forecast available right now.";
    }

    return `Tomorrow in ${place.name}: ${weatherLabel(day.code)}, a high of ${temperature(day.max, unit)}°${unit} and a low of ${temperature(day.min, unit)}°${unit}. The forecast precipitation probability reaches ${Math.round(day.rain)}%.`;
  }

  if (
    text.includes("temperature") ||
    text.includes("hot") ||
    text.includes("cold")
  ) {
    return `It's ${temperature(c.temperature, unit)}°${unit} in ${place.name}, with a feels-like temperature of ${temperature(c.feelsLike, unit)}°${unit}. The reported conditions are ${weatherLabel(c.code).toLowerCase()}.`;
  }

  return `At ${place.name}, the current forecast is ${weatherLabel(c.code).toLowerCase()}, ${temperature(c.temperature, unit)}°${unit}, wind ${Math.round(c.wind)} km/h, and ${Math.round(c.rain)}% precipitation probability. Try asking about rain, wind, temperature, or tomorrow's forecast.`;
}

export default function App() {
  const [place, setPlace] = useState<Place>(DEFAULT_PLACE);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [aqi, setAqi] = useState<Record<string, unknown> | null>(null);
  const [aqiError, setAqiError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [layer, setLayer] = useState<Layer>("wind");
  const [unit, setUnit] = useState<Unit>("C");
  const [windUnits, setWindUnits] = useState("km/h");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  const [favorites, setFavorites] = useState<Place[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("atmos-favorites") || "[]");
    } catch {
      return [];
    }
  });

  const [history, setHistory] = useState<Place[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("atmos-history") || "[]");
    } catch {
      return [];
    }
  });

  const [hourIndex, setHourIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [thresholdWind, setThresholdWind] = useState(40);
  const [thresholdRain, setThresholdRain] = useState(70);

  const [chat, setChat] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: "Hi! I can explain the selected forecast. Ask me about rain, wind, temperature, or tomorrow."
    }
  ]);

  const [chatInput, setChatInput] = useState("");
  const [routeFrom, setRouteFrom] = useState("New Delhi");
  const [routeTo, setRouteTo] = useState("Gurugram");
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeResult, setRouteResult] = useState("");
  const [mobileMenu, setMobileMenu] = useState(false);

  const load = useCallback(async (target: Place) => {
    setLoading(true);
    setError("");
    setAqiError("");

    try {
      const data = await getForecast(target);
      setWeather(data);
      setHourIndex(0);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load the forecast."
      );
      setWeather(null);
    }

    try {
      const air = await getAirQuality(target);
      setAqi(air);
    } catch (err) {
      setAqi(null);
      setAqiError(
        err instanceof Error ? err.message : "Air-quality data unavailable."
      );
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void load(place);
  }, [load, place]);

  useEffect(() => {
    if (!playing) return;

    const timer = window.setInterval(() => {
      setHourIndex(index => {
        const max = Math.max(0, (weather?.hourly.length ?? 1) - 1);
        return index >= max ? 0 : index + 1;
      });
    }, Math.max(250, 1200 / speed));

    return () => window.clearInterval(timer);
  }, [playing, speed, weather?.hourly.length]);

  const current = weather?.current;
  const shown = weather?.hourly[hourIndex];
  const displayHour = shown ?? current;

  const alerts = useMemo(
    () => weather
      ? makeAlerts(
        { ...weather, current: displayHour ?? weather.current },
        thresholdWind,
        thresholdRain
      )
      : [],
    [weather, displayHour, thresholdWind, thresholdRain]
  );

  const navItems: {
    id: Tab;
    label: string;
    icon: React.ReactNode;
  }[] = [
      { id: "overview", label: "Overview", icon: <Activity size={17} /> },
      { id: "forecast", label: "Forecast", icon: <CalendarDays size={17} /> },
      { id: "alerts", label: "Alerts", icon: <ShieldAlert size={17} /> },
      { id: "intelligence", label: "Intelligence", icon: <MessageCircle size={17} /> },
      { id: "routes", label: "Route planner", icon: <Route size={17} /> },
      { id: "environment", label: "Environment", icon: <AirVent size={17} /> },
      { id: "settings", label: "Settings", icon: <Settings2 size={17} /> }
    ];

  const tempLabel = (value: number) =>
    `${temperature(value, unit)}°${unit}`;

  const windLabel = (value: number) =>
    `${windUnit(value, windUnits).toFixed(1)} ${windUnits}`;

  const choosePlace = (target: Place) => {
    setPlace(target);
    setHourIndex(0);
    setSearchResults([]);
    setQuery("");
    setMobileMenu(false);

    setHistory(old => {
      const next = [
        target,
        ...old.filter(p => p.lat !== target.lat || p.lon !== target.lon)
      ].slice(0, 8);

      try {
        localStorage.setItem("atmos-history", JSON.stringify(next));
      } catch {
        // Local history is optional.
      }

      return next;
    });
  };

  const search = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!query.trim()) return;

    setSearching(true);
    setSearchError("");

    try {
      const results = await geocode(query.trim());

      setSearchResults(results);

      if (!results.length) {
        setSearchError("No locations found. Try a city or town name.");
      }
    } catch (err) {
      setSearchResults([]);
      setSearchError(
        err instanceof Error ? err.message : "Location search failed."
      );
    } finally {
      setSearching(false);
    }
  };

  const toggleFavorite = () => {
    const exists = favorites.some(
      p => p.lat === place.lat && p.lon === place.lon
    );

    const next = exists
      ? favorites.filter(p => p.lat !== place.lat || p.lon !== place.lon)
      : [place, ...favorites].slice(0, 12);

    setFavorites(next);

    try {
      localStorage.setItem("atmos-favorites", JSON.stringify(next));
    } catch {
      // Favorites are optional if browser storage is unavailable.
    }
  };

  const sendChat = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const message = chatInput.trim();

    if (!message || !weather) return;

    const reply = assistantReply(message, weather, place, unit);

    setChat(old => [
      ...old,
      { role: "user", text: message },
      { role: "assistant", text: reply }
    ]);

    setChatInput("");
  };

  const planRoute = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setRouteLoading(true);
    setRouteResult("");

    try {
      const [from, to] = await Promise.all([
        geocode(routeFrom),
        geocode(routeTo)
      ]);

      if (!from[0] || !to[0]) {
        throw new Error("Could not find the origin or destination.");
      }

      const url =
        `https://router.project-osrm.org/route/v1/driving/${from[0].lon},${from[0].lat};${to[0].lon},${to[0].lat}?overview=false`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error("The route service is unavailable.");
      }

      const json = await response.json();
      const route = json.routes?.[0];

      if (!route) {
        throw new Error("No driving route was found.");
      }

      const km = route.distance / 1000;
      const minutes = route.duration / 60;
      const hours = Math.floor(minutes / 60);
      const remainder = Math.round(minutes % 60);

      setRouteResult(
        `Estimated driving route: ${km.toFixed(1)} km · ${hours ? `${hours} h ` : ""}${remainder} min. Origin and destination were geocoded using Open-Meteo.`
      );
    } catch (err) {
      setRouteResult(
        err instanceof Error
          ? err.message
          : "Could not calculate this route."
      );
    } finally {
      setRouteLoading(false);
    }
  };

  const shareLocation = async () => {
    const url = new URL(window.location.href);

    url.searchParams.set("lat", String(place.lat));
    url.searchParams.set("lon", String(place.lon));
    url.searchParams.set("name", place.name);

    try {
      await navigator.clipboard.writeText(url.toString());
      setError("");
      window.history.replaceState({}, "", url.toString());
    } catch {
      setError(
        "Could not copy the share link. Check browser clipboard permissions."
      );
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const lat = Number(params.get("lat"));
    const lon = Number(params.get("lon"));
    const name = params.get("name");

    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      params.has("lat") &&
      params.has("lon")
    ) {
      setPlace({
        name: name || "Shared location",
        country: "Shared link",
        lat,
        lon
      });
    }
  }, []);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Wind size={22} /></div>

          <div>
            <b>atmos</b>
            <small>WEATHER INTELLIGENCE</small>
          </div>

          <button
            className="mobile-close"
            onClick={() => setMobileMenu(false)}
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        <form className="search-form" onSubmit={search}>
          <Search size={16} />

          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search location…"
            aria-label="Search location"
          />

          <button
            type="submit"
            disabled={searching}
            aria-label="Search"
          >
            {searching
              ? <RefreshCw size={15} className="spin" />
              : <Search size={15} />}
          </button>
        </form>

        {searchError && (
          <p className="search-error">{searchError}</p>
        )}

        {searchResults.length > 0 && (
          <div className="search-results">
            {searchResults.map((p, i) => (
              <button
                key={`${p.lat}-${p.lon}-${i}`}
                onClick={() => choosePlace(p)}
              >
                <MapPin size={14} />

                <span>
                  {p.name}
                  <small>
                    {p.country || `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}`}
                  </small>
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="sidebar-label">WORKSPACE</div>

        <nav className="nav-list">
          {navItems.map(item => (
            <button
              key={item.id}
              className={`nav-item ${tab === item.id ? "active" : ""}`}
              onClick={() => {
                setTab(item.id);
                setMobileMenu(false);
              }}
            >
              {item.icon}
              <span>{item.label}</span>

              {item.id === "alerts" &&
                alerts.some(a => a.level === "high") &&
                <span className="nav-alert-dot" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-label saved-label">
          SAVED LOCATIONS
          <button
            onClick={toggleFavorite}
            title="Save current location"
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="saved-list">
          {favorites.length === 0 && (
            <p className="muted tiny saved-empty">
              Save a location using the + button.
            </p>
          )}

          {favorites.map(p => (
            <div
              className="saved-place"
              key={`${p.lat}-${p.lon}`}
              role="button"
              tabIndex={0}
              onClick={() => choosePlace(p)}
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") {
                  choosePlace(p);
                }
              }}
            >
              <MapPin size={14} />

              <span>
                {p.name}
                <small>
                  {p.country || `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}`}
                </small>
              </span>

              <button
                className="mini-remove"
                onClick={e => {
                  e.stopPropagation();

                  const next = favorites.filter(
                    v => v.lat !== p.lat || v.lon !== p.lon
                  );

                  setFavorites(next);

                  try {
                    localStorage.setItem(
                      "atmos-favorites",
                      JSON.stringify(next)
                    );
                  } catch {
                    // Favorites are optional if storage is unavailable.
                  }
                }}
                aria-label={`Remove ${p.name}`}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="data-source">
            <span className="source-dot" />
            <div>
              <b>Open-Meteo</b>
              <small>Forecast and air quality</small>
            </div>
          </div>

          <div className="tiny muted">
            ATMOS / WEATHER INTELLIGENCE
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <button
            className="mobile-menu"
            onClick={() => setMobileMenu(true)}
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>

          <div className="breadcrumb">
            <span>Atmos</span>
            <span>/</span>
            <b>{navItems.find(n => n.id === tab)?.label}</b>
          </div>

          <nav className="top-nav" aria-label="Main navigation">
            {([
              ["overview", "Map"],
              ["forecast", "Forecast"],
              ["alerts", "Alerts"],
              ["routes", "Routes"],
              ["intelligence", "AI Assistant"]
            ] as [Tab, string][]).map(([id, label]) => (
              <button
                key={id}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="topbar-actions">
            <span className="live-status">
              <span className="live-dot" />
              {loading ? "Updating" : "Live forecast"}
            </span>

            <button
              className="icon-button"
              onClick={() => void load(place)}
              title="Refresh forecast"
              aria-label="Refresh forecast"
            >
              <RefreshCw size={17} className={loading ? "spin" : ""} />
            </button>

            <button
              className={`icon-button ${favorites.some(
                p => p.lat === place.lat && p.lon === place.lon
              ) ? "is-favorite" : ""
                }`}
              onClick={toggleFavorite}
              title="Save location"
              aria-label="Save location"
            >
              <Heart size={17} />
            </button>

            <button
              className="icon-button"
              onClick={() => void shareLocation()}
              title="Share location"
              aria-label="Share location"
            >
              <Share2 size={17} />
            </button>
          </div>
        </header>

        <main className="main-content">
          {error && (
            <div className="error-banner">
              <AlertTriangle size={17} />
              <span>{error}</span>
              <button onClick={() => void load(place)}>Retry</button>
            </div>
          )}

          <div className="content-heading">
            <div>
              <div className="eyebrow">
                {navItems.find(n => n.id === tab)?.label.toUpperCase()}
              </div>

              <h1>{place.name}</h1>

              <p>
                {place.country || "Selected location"}
                {" · "}
                {place.lat.toFixed(3)}°, {place.lon.toFixed(3)}°
                {" · "}
                Updated {weather
                  ? new Date(weather.updated).toLocaleTimeString()
                  : "—"}
              </p>
            </div>

            <div className="heading-actions">
              <div className="unit-switch">
                <button
                  className={unit === "C" ? "active" : ""}
                  onClick={() => setUnit("C")}
                >
                  °C
                </button>

                <button
                  className={unit === "F" ? "active" : ""}
                  onClick={() => setUnit("F")}
                >
                  °F
                </button>
              </div>

              <button
                className="button secondary"
                onClick={() => void load(place)}
              >
                <RefreshCw size={15} />
                Refresh
              </button>
            </div>
          </div>

          {tab === "overview" && (
            <>
              <section className="hero-grid">
                <div className="panel current-panel">
                  <div className="panel-topline">
                    <span className="eyebrow">CURRENT CONDITIONS</span>
                    <span className="live-badge">NOW</span>
                  </div>

                  {current ? (
                    <>
                      <div className="current-weather">
                        <div>
                          <div className="weather-emoji">
                            {weatherIcon(current.code)}
                          </div>
                          <div className="condition-text">
                            {weatherLabel(current.code)}
                          </div>
                        </div>

                        <div className="temperature-large">
                          {tempLabel(current.temperature)}
                        </div>
                      </div>

                      <p className="feels-like">
                        Feels like {tempLabel(current.feelsLike)}
                        {" · "}
                        {place.name}
                      </p>

                      <div className="current-divider" />

                      <div className="current-mini-grid">
                        <div>
                          <span><Wind size={15} /> Wind</span>
                          <b>{windLabel(current.wind)}</b>
                          <small>{windDirection(current.direction)}</small>
                        </div>

                        <div>
                          <span><Droplets size={15} /> Humidity</span>
                          <b>{Math.round(current.humidity)}%</b>
                          <small>Relative humidity</small>
                        </div>

                        <div>
                          <span><CloudRain size={15} /> Rain chance</span>
                          <b>{Math.round(displayHour?.rain ?? current.rain)}%</b>
                          <small>Selected hour</small>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="empty-state">
                      {loading
                        ? "Loading current conditions…"
                        : "Current weather is unavailable."}
                    </div>
                  )}
                </div>

                <div className="panel map-panel">
                  <div className="panel-heading">
                    <div>
                      <div className="eyebrow">WEATHER MAP</div>
                      <h2>Atmospheric conditions</h2>
                    </div>
                    <Compass size={20} />
                  </div>

                  <div className="layer-switcher">
                    {([
                      ["wind", "Wind"],
                      ["temperature", "Temp"],
                      ["rain", "Rain"],
                      ["clouds", "Clouds"],
                      ["humidity", "Humidity"]
                    ] as [Layer, string][]).map(([id, label]) => (
                      <button
                        key={id}
                        className={layer === id ? "active" : ""}
                        onClick={() => setLayer(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <MapPanel
                    place={place}
                    layer={layer}
                    onSelect={choosePlace}
                    hour={displayHour}
                  />
                </div>
              </section>

              <section className="section-block">
                <div className="section-title">
                  <div>
                    <div className="eyebrow">NEXT 24 HOURS</div>
                    <h2>Hourly forecast</h2>
                  </div>

                  <button
                    className="text-button"
                    onClick={() => setTab("forecast")}
                  >
                    View forecast <Navigation size={14} />
                  </button>
                </div>

                <div className="panel hourly-panel">
                  <div className="hourly-list">
                    {(weather?.hourly.slice(0, 24) ?? []).map((h, i) => (
                      <button
                        key={h.time}
                        className={`hour-item ${hourIndex === i ? "selected" : ""
                          }`}
                        onClick={() => setHourIndex(i)}
                      >
                        <span>
                          {i === 0 ? "Now" : formatTime(h.time, weather?.timezone)}
                        </span>

                        <span className="hour-icon">{weatherIcon(h.code)}</span>

                        <b>{tempLabel(h.temperature)}</b>

                        <small>
                          <Droplets size={12} />
                          {Math.round(h.rain)}%
                        </small>
                      </button>
                    ))}

                    {!weather && (
                      <div className="empty-state">
                        {loading
                          ? "Loading hourly forecast…"
                          : "Hourly forecast unavailable."}
                      </div>
                    )}
                  </div>

                  <div className="timeline-controls">
                    <button
                      className="play-button"
                      onClick={() => setPlaying(v => !v)}
                      aria-label={playing
                        ? "Pause forecast animation"
                        : "Play forecast animation"}
                    >
                      {playing ? <Pause size={15} /> : <Play size={15} />}
                    </button>

                    <span className="timeline-label">
                      {displayHour
                        ? formatTime(displayHour.time, weather?.timezone)
                        : "—"}
                    </span>

                    <input
                      aria-label="Forecast timeline"
                      type="range"
                      min="0"
                      max={Math.max(0, (weather?.hourly.length ?? 1) - 1)}
                      value={Math.min(
                        hourIndex,
                        Math.max(0, (weather?.hourly.length ?? 1) - 1)
                      )}
                      onChange={e => setHourIndex(Number(e.target.value))}
                    />

                    <select
                      value={speed}
                      onChange={e => setSpeed(Number(e.target.value))}
                      aria-label="Animation speed"
                    >
                      <option value={0.5}>0.5×</option>
                      <option value={1}>1×</option>
                      <option value={2}>2×</option>
                      <option value={4}>4×</option>
                    </select>
                  </div>
                </div>
              </section>

              <section className="section-block">
                <div className="section-title">
                  <div>
                    <div className="eyebrow">KEY METRICS</div>
                    <h2>Atmosphere at a glance</h2>
                  </div>

                  <button
                    className="text-button"
                    onClick={() => setTab("environment")}
                  >
                    Environment <Navigation size={14} />
                  </button>
                </div>

                <div className="metric-grid">
                  <Metric
                    icon={<Gauge />}
                    title="Pressure"
                    value={current ? `${Math.round(current.pressure)} hPa` : "—"}
                    detail="Surface pressure"
                  />

                  <Metric
                    icon={<Droplets />}
                    title="Humidity"
                    value={current ? `${Math.round(current.humidity)}%` : "—"}
                    detail="Relative humidity"
                  />

                  <Metric
                    icon={<Thermometer />}
                    title="Dew point"
                    value={current ? tempLabel(current.dewPoint) : "—"}
                    detail="Condensation indicator"
                  />

                  <Metric
                    icon={<Cloud />}
                    title="Cloud cover"
                    value={current ? `${Math.round(current.clouds)}%` : "—"}
                    detail="Sky coverage"
                  />
                </div>
              </section>

              <section className="section-block">
                <div className="section-title">
                  <div>
                    <div className="eyebrow">COMING DAYS</div>
                    <h2>14-day outlook</h2>
                  </div>

                  <button
                    className="text-button"
                    onClick={() => setTab("forecast")}
                  >
                    Full forecast <Navigation size={14} />
                  </button>
                </div>

                <div className="panel daily-panel">
                  {(weather?.daily.slice(0, 7) ?? []).map(day => (
                    <div className="daily-row" key={day.date}>
                      <span>{formatDay(day.date)}</span>
                      <span className="daily-icon">{weatherIcon(day.code)}</span>
                      <span className="daily-condition">
                        {weatherLabel(day.code)}
                      </span>

                      <div className="daily-bar">
                        <span style={{ width: `${Math.max(4, day.rain)}%` }} />
                      </div>

                      <small>
                        <Droplets size={12} />
                        {Math.round(day.rain)}%
                      </small>

                      <b>{tempLabel(day.max)}</b>
                      <span className="muted">{tempLabel(day.min)}</span>
                    </div>
                  ))}

                  {!weather && (
                    <div className="empty-state">
                      {loading ? "Loading forecast…" : "Daily forecast unavailable."}
                    </div>
                  )}
                </div>
              </section>
            </>
          )}

          {tab === "forecast" && (
            <div className="page-grid">
              <section className="panel wide-panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">FORECAST TRENDS</div>
                    <h2>Next 24 hours</h2>
                  </div>
                </div>

                <Chart
                  values={weather?.hourly.slice(0, 24).map(h => h.temperature) ?? []}
                  color="#42d9c0"
                  suffix={`°${unit}`}
                />

                <div className="chart-legend">
                  <span>Temperature</span>
                  <b>{current ? tempLabel(current.temperature) : "—"}</b>
                </div>
              </section>

              <section className="panel wide-panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">WIND</div>
                    <h2>Wind speed trend</h2>
                  </div>
                </div>

                <Chart
                  values={weather?.hourly.slice(0, 24).map(h => h.wind) ?? []}
                  color="#8b83ff"
                  suffix=" km/h"
                />
              </section>

              <section className="panel wide-panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">PRECIPITATION</div>
                    <h2>Rain probability</h2>
                  </div>
                </div>

                <Chart
                  values={weather?.hourly.slice(0, 24).map(h => h.rain) ?? []}
                  color="#43b9ff"
                  suffix="%"
                />
              </section>

              <section className="panel wide-panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">14-DAY FORECAST</div>
                    <h2>Daily conditions</h2>
                  </div>
                </div>

                <div className="daily-panel">
                  {(weather?.daily ?? []).map(day => (
                    <div className="daily-row" key={day.date}>
                      <span>{formatDay(day.date)}</span>
                      <span className="daily-icon">{weatherIcon(day.code)}</span>
                      <span className="daily-condition">
                        {weatherLabel(day.code)}
                      </span>

                      <div className="daily-bar">
                        <span style={{ width: `${Math.max(4, day.rain)}%` }} />
                      </div>

                      <small>
                        <Droplets size={12} />
                        {Math.round(day.rain)}%
                      </small>

                      <b>{tempLabel(day.max)}</b>
                      <span className="muted">{tempLabel(day.min)}</span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}

          {tab === "alerts" && (
            <div className="page-grid">
              <section className="panel wide-panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">RULE-BASED MONITORING</div>
                    <h2>Weather alerts</h2>
                    <p className="muted">
                      Threshold checks from the selected forecast; not official warnings.
                    </p>
                  </div>
                </div>

                {alerts.map((a, i) => (
                  <div className={`alert-card ${a.level}`} key={i}>
                    <div className="alert-symbol">
                      <AlertTriangle size={20} />
                    </div>

                    <div>
                      <b>{a.title}</b>
                      <p>{a.detail}</p>
                      <small>
                        {place.name} · {new Date().toLocaleTimeString()}
                      </small>
                    </div>

                    <span className={`severity ${a.level}`}>
                      {a.level.toUpperCase()}
                    </span>
                  </div>
                ))}
              </section>

              <section className="panel wide-panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">CUSTOM THRESHOLDS</div>
                    <h2>Alert settings</h2>
                  </div>
                </div>

                <label className="setting-row">
                  <span>
                    Strong wind threshold
                    <small>Alert when wind speed reaches this value</small>
                  </span>
                  <b>{thresholdWind} km/h</b>
                </label>

                <input
                  className="range"
                  type="range"
                  min="15"
                  max="100"
                  step="5"
                  value={thresholdWind}
                  onChange={e => setThresholdWind(Number(e.target.value))}
                />

                <label className="setting-row">
                  <span>
                    Rain probability threshold
                    <small>Alert when probability reaches this value</small>
                  </span>
                  <b>{thresholdRain}%</b>
                </label>

                <input
                  className="range"
                  type="range"
                  min="20"
                  max="100"
                  step="5"
                  value={thresholdRain}
                  onChange={e => setThresholdRain(Number(e.target.value))}
                />

                <p className="muted tiny">
                  Thresholds are stored for this session. Browser push notifications and official warning feeds are not configured.
                </p>
              </section>
            </div>
          )}

          {tab === "alerts" && (
            <TinyFishAdvisories location={place.name} />
          )}

          {tab === "intelligence" && (
            <section className="panel chat-panel">
              <div className="panel-heading">
                <div className="panel-icon">
                  <MessageCircle size={18} />
                </div>

                <div>
                  <div className="eyebrow">ATMOS INTELLIGENCE</div>
                  <h2>Weather assistant</h2>
                  <small className="muted">
                    Forecast-grounded rule-based assistant
                  </small>
                </div>
              </div>

              <div className="chat-messages">
                {chat.map((m, i) => (
                  <div className={`chat-message ${m.role}`} key={i}>
                    <span className="chat-avatar">
                      {m.role === "user" ? "YOU" : <Wind size={17} />}
                    </span>
                    <p>{m.text}</p>
                  </div>
                ))}
              </div>

              <div className="suggestion-row">
                {["Will it rain?", "Explain the wind", "Tomorrow's forecast"].map(s => (
                  <button
                    className="button secondary small"
                    key={s}
                    onClick={() => setChatInput(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>

              <form className="chat-form" onSubmit={sendChat}>
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  placeholder="Ask about the weather…"
                  disabled={!weather}
                />

                <button
                  className="button primary"
                  type="submit"
                  disabled={!weather || !chatInput.trim()}
                >
                  <Send size={16} /> Send
                </button>
              </form>

              <p className="muted tiny">
                This is not a generative AI model. AI integration requires a configured backend and API credentials.
              </p>
            </section>
          )}

          {tab === "routes" && (
            <div className="page-grid">
              <section className="panel wide-panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">TRAVEL WEATHER</div>
                    <h2>Weather-aware route planner</h2>
                    <p className="muted">
                      Calculate a road route and review the selected location's forecast.
                    </p>
                  </div>
                </div>

                <form className="route-form" onSubmit={planRoute}>
                  <label>
                    Origin
                    <input
                      value={routeFrom}
                      onChange={e => setRouteFrom(e.target.value)}
                      required
                    />
                  </label>

                  <label>
                    Destination
                    <input
                      value={routeTo}
                      onChange={e => setRouteTo(e.target.value)}
                      required
                    />
                  </label>

                  <button
                    className="button primary"
                    type="submit"
                    disabled={routeLoading}
                  >
                    <Route size={16} />
                    {routeLoading ? "Planning…" : "Calculate route"}
                  </button>
                </form>

                {routeResult && (
                  <div className="route-result">
                    <Navigation size={19} />
                    <p>{routeResult}</p>
                  </div>
                )}

                <p className="muted tiny">
                  Routing uses the public OSRM demo service. This calculates driving distance/time, not a safety-certified weather route. Route-wide weather sampling is not yet implemented.
                </p>
              </section>

              <section className="panel wide-panel">
                <div className="eyebrow">CURRENT WEATHER AT SELECTED LOCATION</div>
                <h2>{place.name}</h2>

                {current && (
                  <div className="route-weather">
                    {weatherIcon(current.code)}
                    <b>{tempLabel(current.temperature)}</b>
                    <span>{weatherLabel(current.code)}</span>
                    <span><Wind size={14} />{windLabel(current.wind)}</span>
                    <span>
                      <CloudRain size={14} />
                      {current.rain}% rain chance
                    </span>
                  </div>
                )}
              </section>
            </div>
          )}

          {tab === "environment" && (
            <div className="page-grid">
              <section className="panel wide-panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">AIR QUALITY</div>
                    <h2>Environmental intelligence</h2>
                    <p className="muted">Current Open-Meteo air-quality estimates</p>
                  </div>
                  <AirVent size={22} />
                </div>

                {aqi ? (
                  <>
                    <div className="aqi-score">
                      <span>US AQI</span>
                      <b>{Math.round(number(aqi.us_aqi))}</b>
                      <small>
                        {number(aqi.us_aqi) <= 50
                          ? "Good"
                          : number(aqi.us_aqi) <= 100
                            ? "Moderate"
                            : number(aqi.us_aqi) <= 150
                              ? "Unhealthy for sensitive groups"
                              : "Unhealthy or worse"}
                      </small>
                    </div>

                    <div className="metric-grid">
                      <Metric
                        icon={<AirVent />}
                        title="PM2.5"
                        value={`${number(aqi.pm2_5).toFixed(1)} μg/m³`}
                        detail="Fine particles"
                      />

                      <Metric
                        icon={<AirVent />}
                        title="PM10"
                        value={`${number(aqi.pm10).toFixed(1)} μg/m³`}
                        detail="Coarse particles"
                      />

                      <Metric
                        icon={<Activity />}
                        title="Ozone"
                        value={`${number(aqi.ozone).toFixed(1)} μg/m³`}
                        detail="O₃"
                      />

                      <Metric
                        icon={<Activity />}
                        title="NO₂"
                        value={`${number(aqi.nitrogen_dioxide).toFixed(1)} μg/m³`}
                        detail="Nitrogen dioxide"
                      />
                    </div>
                  </>
                ) : (
                  <div className="empty-state">
                    {aqiError ||
                      (loading
                        ? "Loading air quality…"
                        : "Air-quality data unavailable.")}
                  </div>
                )}
              </section>

              <section className="panel wide-panel">
                <div className="eyebrow">ATMOSPHERIC MEASUREMENTS</div>
                <h2>Current environment</h2>

                <div className="metric-grid">
                  <Metric
                    icon={<Gauge />}
                    title="Pressure"
                    value={current ? `${Math.round(current.pressure)} hPa` : "—"}
                    detail="Surface pressure"
                  />

                  <Metric
                    icon={<Droplets />}
                    title="Humidity"
                    value={current ? `${Math.round(current.humidity)}%` : "—"}
                    detail="Relative humidity"
                  />

                  <Metric
                    icon={<Thermometer />}
                    title="Dew point"
                    value={current ? tempLabel(current.dewPoint) : "—"}
                    detail="Estimated dew point"
                  />

                  <Metric
                    icon={<Cloud />}
                    title="Cloud cover"
                    value={current ? `${Math.round(current.clouds)}%` : "—"}
                    detail="Sky coverage"
                  />
                </div>

                <p className="muted tiny">
                  Visibility and historical observations require a compatible data source and are not fabricated when unavailable.
                </p>
              </section>

              <section className="panel wide-panel">
                <div className="eyebrow">DATA QUALITY</div>
                <h2>Sources and freshness</h2>

                <div className="source-row">
                  <span className="source-dot" />
                  <div>
                    <b>Open-Meteo Forecast API</b>
                    <small>
                      Forecast model data · Retrieved{" "}
                      {weather
                        ? new Date(weather.updated).toLocaleString()
                        : "not yet loaded"}
                    </small>
                  </div>
                  <span className="live-badge">FORECAST</span>
                </div>

                <div className="source-row">
                  <span className={`source-dot ${aqi ? "" : "offline"}`} />
                  <div>
                    <b>Open-Meteo Air Quality API</b>
                    <small>
                      {aqi ? "Data available" : aqiError || "Waiting for response"}
                    </small>
                  </div>
                  <span className="live-badge">
                    {aqi ? "CONNECTED" : "PENDING"}
                  </span>
                </div>
              </section>
            </div>
          )}

          {tab === "settings" && (
            <div className="page-grid">
              <section className="panel wide-panel">
                <div className="eyebrow">DISPLAY</div>
                <h2>Preferences</h2>

                <div className="setting-row">
                  <span>
                    Temperature unit
                    <small>Choose Celsius or Fahrenheit</small>
                  </span>

                  <div className="segmented">
                    <button
                      className={unit === "C" ? "active" : ""}
                      onClick={() => setUnit("C")}
                    >
                      °C
                    </button>

                    <button
                      className={unit === "F" ? "active" : ""}
                      onClick={() => setUnit("F")}
                    >
                      °F
                    </button>
                  </div>
                </div>

                <div className="setting-row">
                  <span>
                    Wind speed unit
                    <small>Display wind speed in your preferred unit</small>
                  </span>

                  <select
                    value={windUnits}
                    onChange={e => setWindUnits(e.target.value)}
                  >
                    <option>km/h</option>
                    <option>mph</option>
                    <option>kn</option>
                  </select>
                </div>

                <div className="setting-row">
                  <span>
                    Appearance
                    <small>Atmos currently uses its dark theme</small>
                  </span>
                  <span className="muted"><Moon size={15} /> Dark</span>
                </div>

                <div className="setting-row">
                  <span>
                    Saved locations
                    <small>Stored in this browser only</small>
                  </span>
                  <b>{favorites.length}</b>
                </div>

                <button
                  className="button secondary"
                  onClick={() => {
                    setFavorites([]);
                    localStorage.removeItem("atmos-favorites");
                  }}
                >
                  <X size={15} /> Clear favorites
                </button>
              </section>

              <section className="panel wide-panel">
                <div className="eyebrow">RECENT SEARCHES</div>
                <h2>Location history</h2>

                {history.length
                  ? history.map(p => (
                    <button
                      className="history-row"
                      key={`${p.lat}-${p.lon}`}
                      onClick={() => choosePlace(p)}
                    >
                      <History size={16} />
                      <span>
                        {p.name}
                        <small>
                          {p.country ||
                            `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}`}
                        </small>
                      </span>
                      <ChevronDown size={14} />
                    </button>
                  ))
                  : (
                    <div className="empty-state">
                      Your recently selected locations appear here.
                    </div>
                  )}
              </section>
            </div>
          )}

          <footer className="page-footer">
            <span>
              <span className="live-dot" />
              {loading ? "UPDATING DATA" : "ATMOS SYSTEM OPERATIONAL"}
            </span>

            <span>
              Forecasts are estimates · Verify official alerts for safety-critical decisions
            </span>

            <span>ATMOS WEATHER INTELLIGENCE © 2026</span>
          </footer>
        </main>
      </div>
    </div>
  );
}