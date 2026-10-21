// Open-Meteo data access, formatting helpers and rule-based alerts for the Atmos dashboard.

export type Place = { name: string; country?: string; lat: number; lon: number };

export type Hour = {
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

export type Day = {
  date: string;
  min: number;
  max: number;
  rain: number;
  sunrise: string;
  sunset: string;
  code: number;
};

export type WeatherData = {
  current: Hour;
  hourly: Hour[];
  daily: Day[];
  timezone: string;
  updated: string;
};

export type Unit = "C" | "F";

export const DEFAULT_PLACE: Place = {
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

export function weatherLabel(code: number) {
  return WEATHER_LABEL[code] ?? "Conditions unavailable";
}

export function weatherIcon(code: number) {
  if (code >= 95) return "⛈";
  if (code >= 71) return "❄️";
  if (code >= 51 || (code >= 80 && code <= 82)) return "🌧";
  if (code >= 45) return "🌫";
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤";
  return "☁️";
}

export function formatTime(value: string, timezone?: string) {
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

export function formatDay(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short"
  });
}

export function temperature(value: number, unit: Unit) {
  return Math.round(unit === "C" ? value : value * 9 / 5 + 32);
}

export function windUnit(value: number, unit: string) {
  if (unit === "mph") return value * 0.621371;
  if (unit === "kn") return value * 0.539957;
  return value;
}

export function windDirection(degrees: number) {
  return [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"
  ][Math.round(degrees / 22.5) % 16];
}

export function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}


export async function getForecast(
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

export async function geocode(query: string): Promise<Place[]> {
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

export async function getAirQuality(place: Place) {
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

export type WeatherAlert = {
  title: string;
  detail: string;
  level: "high" | "medium" | "low";
  time?: string;
};

export function makeAlerts(
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

export function assistantReply(
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
