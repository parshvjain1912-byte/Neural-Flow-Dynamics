import { useCallback, useEffect, useMemo, useState } from "react";
import TinyFishAdvisories from "./components/TinyFishAdvisories";
import Chart from "./components/Chart";
import Metric from "./components/Metric";
import ForecastMap from "./components/ForecastMap";
import { MAP_LAYERS, type MapLayer } from "./lib/mapLayers";
import {
  Activity, AirVent, AlertTriangle, CalendarDays,
  ChevronDown, Cloud, CloudRain, Compass, Droplets,
  Gauge, Heart, History, MapPin, Menu, MessageCircle,
  Moon, Navigation, Pause, Play, Plus, RefreshCw, Route,
  Search, Send, Settings2, Share2, ShieldAlert, Thermometer,
  Wind, X
} from "lucide-react";
import {
  DEFAULT_PLACE, assistantReply, formatDay, formatTime, geocode, getAirQuality, getForecast,
  makeAlerts, number, temperature, weatherIcon, weatherLabel, windDirection, windUnit,
  type Place, type Unit, type WeatherData
} from "./lib/weather";
import "./App.css";

type Tab = "overview" | "forecast" | "alerts" | "intelligence" | "routes" | "environment" | "settings";

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

export default function App() {
  const [place, setPlace] = useState<Place>(DEFAULT_PLACE);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [aqi, setAqi] = useState<Record<string, unknown> | null>(null);
  const [aqiError, setAqiError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [layer, setLayer] = useState<MapLayer>("temperature");
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
                    {MAP_LAYERS.map(({ id, label }) => (
                      <button
                        key={id}
                        className={layer === id ? "active" : ""}
                        onClick={() => setLayer(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <ForecastMap
                    place={place}
                    layer={layer}
                    hour={displayHour}
                    onSelect={choosePlace}
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