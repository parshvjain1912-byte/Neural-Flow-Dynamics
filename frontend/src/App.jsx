
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WeatherMap from "./WeatherMap";
import { COLOR_SCALES, encode, legendGradient } from "./Colorscales";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const DEFAULT_TIMES = ["00:00", "06:00", "12:00", "18:00"];
const PLAY_MS = 1100;
const LAYERS = ["temperature", "wind", "pressure", "rainfall"];
const ICONS = {
  temperature: <path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z" />,
  wind: <path d="M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7" />,
  pressure: <><circle cx="12" cy="13" r="8" /><path d="M12 13l4-4" /></>,
  rainfall: <><path d="M7 15a4 4 0 0 1 0-8 5 5 0 0 1 9.6 1A3.5 3.5 0 0 1 17 15z" /><path d="M9 18l-1 3M13 18l-1 3M17 18l-1 3" /></>
};

const shortDate = d => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

async function fetchWeatherBinary(date, isForecast, run) {
  const endpoint = isForecast
    ? `/api/forecast-binary?date=${encodeURIComponent(date)}&run=${encodeURIComponent(run)}`
    : `/api/weather-binary?date=${encodeURIComponent(date)}`;
  const r = await fetch(`${API_BASE}${endpoint}`);
  if (!r.ok) throw new Error(`Weather request failed (${r.status})`);
  const buffer = await r.arrayBuffer();
  if (buffer.byteLength < 4) throw new Error("Invalid weather response");
  const headerLength = new DataView(buffer).getUint32(0, true);
  const headerEnd = 4 + headerLength, dataStart = Math.ceil(headerEnd / 4) * 4;
  if (headerEnd > buffer.byteLength || dataStart > buffer.byteLength) throw new Error("Invalid weather header");
  const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)));
  const count = metadata.shape.reduce((a, b) => a * b, 1);
  if (buffer.byteLength - dataStart !== count * 4) throw new Error("Invalid weather data size");
  return { ...metadata, values: new Float32Array(buffer, dataStart, count) };
}

// One time step -> { time, t2m: Float32Array, ... } (flat, row-major lat x lon).
function makeFrame(payload, timeIndex) {
  const [, variableCount, height, width] = payload.shape;
  const size = height * width;
  const frame = { time: payload.times[timeIndex] };
  payload.variables.forEach((name, vi) => {
    const start = (timeIndex * variableCount + vi) * size;
    frame[name] = payload.values.subarray(start, start + size);
  });
  return frame;
}

export default function App() {
  const [dates, setDates] = useState([]);
  const [cache, setCache] = useState({});
  const [coords, setCoords] = useState(null);
  const [slot, setSlot] = useState(0);
  const [layer, setLayer] = useState("temperature");
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [windOn, setWindOn] = useState(true);
  const cacheRef = useRef({});
  const inflight = useRef(new Set());
  const slotRef = useRef(0);
  const datesRef = useRef([]);
  const viewDate = useRef("");
  const forecastDatesRef = useRef(new Set());
  const forecastRunRef = useRef(null);

  useEffect(() => { cacheRef.current = cache; }, [cache]);

  const fetchDate = useCallback(async date => {
    if (!date || cacheRef.current[date] || inflight.current.has(date)) return;
    inflight.current.add(date);
    try {
      const isForecast = forecastDatesRef.current.has(date);
      const run = forecastRunRef.current;
      if (isForecast && !run) throw new Error("Forecast run is unavailable");
      const payload = await fetchWeatherBinary(date, isForecast, run);
      if (!payload.latitude?.length || !payload.longitude?.length || !payload.shape || payload.shape.length !== 4)
        throw new Error("Invalid weather grid metadata");
      setCoords(c => c || payload);
      setCache(prev => {
        const next = { ...prev, [date]: payload };
        const list = datesRef.current, vi = list.indexOf(viewDate.current);
        if (vi >= 0) Object.keys(next).forEach(d => {
          if (d !== date && Math.abs(list.indexOf(d) - vi) > 1) delete next[d];
        });
        return next;
      });
    } catch (e) {
      setError(e.message || "Could not load weather data");
    } finally {
      inflight.current.delete(date);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/available-dates`)
      .then(r => { if (!r.ok) throw new Error(`Dates request failed (${r.status})`); return r.json(); })
      .then(p => {
        if (cancelled) return;
        const list = (p.dates || []).slice().sort();
        if (!list.length) throw new Error("No data available");
        forecastDatesRef.current = new Set(p.forecast_dates || []);
        forecastRunRef.current = p.forecast_run || null;
        datesRef.current = list;
        viewDate.current = list[0];
        setDates(list);
        fetchDate(list[0]);
        if (list[1]) fetchDate(list[1]);
      })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [fetchDate]);

  const slots = useMemo(() => dates.flatMap(date => {
    const times = cache[date]?.times || DEFAULT_TIMES;
    return times.map((time, idx) => ({ date, idx, time }));
  }), [dates, cache]);

  const safeSlot = Math.min(slot, Math.max(0, slots.length - 1));
  const current = slots[safeSlot];

  const goTo = useCallback(i => {
    const target = slots[i];
    if (!target) return;
    slotRef.current = i;
    viewDate.current = target.date;
    setSlot(i);
    const k = datesRef.current.indexOf(target.date);
    fetchDate(target.date);
    if (target.idx >= 2 && datesRef.current[k + 1]) fetchDate(datesRef.current[k + 1]);
    if (target.idx <= 1 && datesRef.current[k - 1]) fetchDate(datesRef.current[k - 1]);
  }, [slots, fetchDate]);

  const currentDate = current?.date, currentIdx = current?.idx;
  const currentPayload = currentDate ? cache[currentDate] : null;
  const target = useMemo(() => currentPayload && currentIdx != null ? makeFrame(currentPayload, currentIdx) : null, [currentPayload, currentIdx]);
  const loading = !!current && !target;

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const nextIndex = slotRef.current + 1;
      if (nextIndex >= slots.length) { setPlaying(false); return; }
      const next = slots[nextIndex];
      if (cacheRef.current[next.date]) goTo(nextIndex);
      else {
        viewDate.current = next.date;
        fetchDate(next.date);
      }
    }, PLAY_MS);
    return () => clearInterval(id);
  }, [playing, slots, goTo, fetchDate]);

  const scale = COLOR_SCALES[layer];
  const dayStarts = slots.map((s, i) => s.idx === 0 && i > 0 ? i : null).filter(i => i !== null);
  const pct = i => slots.length > 1 ? i / (slots.length - 1) * 100 : 0;

  return (
    <div className="nfd-app">
      <WeatherMap coords={coords} frame={target} layer={layer} showWind={windOn} />
      <div className="layers">
        {LAYERS.map(id => (
          <button key={id} title={id} aria-label={id} className={id === layer ? "on" : ""} onClick={() => setLayer(id)}>
            <svg viewBox="0 0 24 24">{ICONS[id]}</svg>
          </button>
        ))}
        <button title="wind particles" aria-label="wind particles" className={windOn ? "on" : ""} onClick={() => setWindOn(w => !w)}>
          <svg viewBox="0 0 24 24"><path d="M4 12h13M13 7l5 5-5 5" /></svg>
        </button>
      </div>
      <div className="legend">
        <div className="bar" style={{ background: legendGradient(scale) }} />
        <div className="ticks">
          {scale.ticks.map((v, i) => <span key={v} style={{ left: `${encode(v, scale) * 100}%` }}>{v}{i === scale.ticks.length - 1 ? ` ${scale.unit}` : ""}</span>)}
        </div>
      </div>
      {slots.length > 0 && (
        <div className="timeline">
          <button className="play" aria-label={playing ? "pause" : "play"} onClick={() => setPlaying(p => !p)}>
            <svg viewBox="0 0 24 24">{playing ? <path d="M8 5v14M16 5v14" /> : <path d="M8 5l11 7-11 7z" />}</svg>
          </button>
          <div className="track">
            <div className="ticks-day">{dayStarts.map(i => <i key={i} style={{ left: `${pct(i)}%` }} />)}</div>
            <input type="range" min={0} max={slots.length - 1} value={safeSlot} onChange={e => { setPlaying(false); goTo(Number(e.target.value)); }} onPointerDown={() => setDragging(true)} onPointerUp={() => setDragging(false)} onPointerCancel={() => setDragging(false)} aria-label="time" />
            {dragging && current && <span className="bubble" style={{ left: `${pct(safeSlot)}%` }}>{shortDate(current.date)} {current.time}</span>}
          </div>
          <span className={`dot ${loading ? "busy" : ""}`} />
        </div>
      )}
      {error && <div className="toast" onClick={() => setError("")}>{error}</div>}
    </div>
  );
}
