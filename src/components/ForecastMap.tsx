import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, Wind } from "lucide-react";
import { Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
// The renderer and colour scales are shared with the standalone map app in /frontend.
import WebGLWeatherLayer from "../../frontend/src/WebGLWeatherLayer.jsx";
import { COLOR_SCALES, encode, legendGradient } from "../../frontend/src/Colorscales.js";
import { closestFrameIndex, fetchForecastGrid, type ForecastGrid } from "../lib/forecastData";
import type { MapLayer } from "../lib/mapLayers";
import type { Hour, Place } from "../lib/weather";

setWorkerUrl(workerUrl);

const LAYER_ID = "ecmwf-weather";

const LEGEND_TITLE: Record<MapLayer, string> = {
  temperature: "TEMPERATURE",
  wind: "WIND SPEED",
  pressure: "SURFACE PRESSURE",
  rainfall: "PRECIPITATION · 6 H",
};

/** Open-Meteo value for the selected place and hour, shown next to the layer name. */
function placeValue(layer: MapLayer, hour: Hour | undefined) {
  if (!hour) return "Loading weather…";
  switch (layer) {
    case "temperature": return `${Math.round(hour.temperature)}°C`;
    case "wind": return `${Math.round(hour.wind)} km/h`;
    case "pressure": return `${Math.round(hour.pressure)} hPa`;
    case "rainfall": return `${Math.round(hour.rain)}% rain chance`;
  }
}

type Props = {
  place: Place;
  layer: MapLayer;
  hour: Hour | undefined;
  onSelect: (place: Place) => void;
};

export default function ForecastMap({ place, layer, hour, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const weatherLayerRef = useRef<InstanceType<typeof WebGLWeatherLayer> | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const onSelectRef = useRef(onSelect);

  const [mapReady, setMapReady] = useState(false);
  const [grid, setGrid] = useState<ForecastGrid | null>(null);
  const [failure, setFailure] = useState<{ date: string; message: string } | null>(null);
  const [windOn, setWindOn] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // Create the map once.
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
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: true }), "top-right");

    map.once("load", () => {
      const weatherLayer = new WebGLWeatherLayer({ id: LAYER_ID, alpha: 0.82, particleCount: 5000 });
      // Insert below the first label layer so place names stay readable.
      const firstLabel = map.getStyle().layers?.find((l) => l.type === "symbol");
      map.addLayer(weatherLayer, firstLabel?.id);
      weatherLayerRef.current = weatherLayer;
      setMapReady(true);
    });

    const markerElement = document.createElement("div");
    markerElement.className = "map-marker";
    markerElement.innerHTML = "<span></span>";
    markerRef.current = new Marker({ element: markerElement }).setLngLat([place.lon, place.lat]).addTo(map);

    map.on("click", (event) =>
      onSelectRef.current({
        name: `${event.lngLat.lat.toFixed(3)}, ${event.lngLat.lng.toFixed(3)}`,
        country: "Map location",
        lat: event.lngLat.lat,
        lon: event.lngLat.lng,
      })
    );

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container);

    return () => {
      observer.disconnect();
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
      weatherLayerRef.current = null;
      setMapReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the map is created once; place changes are handled below
  }, []);

  // Follow the selected place.
  useEffect(() => {
    mapRef.current?.flyTo({ center: [place.lon, place.lat], duration: 500 });
    markerRef.current?.setLngLat([place.lon, place.lat]);
  }, [place.lat, place.lon]);

  // Load the ECMWF grid for the selected UTC date.
  const utc = hour?.utc;
  const date = utc === undefined ? null : new Date(utc).toISOString().slice(0, 10);
  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    fetchForecastGrid(date)
      .then((loaded) => {
        if (cancelled) return;
        setGrid(loaded);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setGrid(null);
        setFailure({ date, message: error instanceof Error ? error.message : "Could not load weather data" });
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  const status =
    failure?.date === date ? failure.message : grid?.date === date ? "" : "Loading weather field…";

  // Frame for the selected hour (stable object, so the layer only reloads when it really changes).
  const frame = useMemo(
    () => (grid && utc !== undefined ? (grid.frames[closestFrameIndex(grid, utc)] ?? null) : null),
    [grid, utc]
  );

  // Push grid, frame, layer and wind setting to the WebGL layer.
  useEffect(() => {
    const map = mapRef.current;
    const weatherLayer = weatherLayerRef.current;
    if (!map || !weatherLayer || !mapReady) return;
    map.setLayoutProperty(LAYER_ID, "visibility", frame ? "visible" : "none");
    weatherLayer.update(grid?.coords ?? null, frame, layer, windOn);
  }, [mapReady, grid, frame, layer, windOn]);

  useEffect(() => {
    const id = requestAnimationFrame(() => mapRef.current?.resize());
    return () => cancelAnimationFrame(id);
  }, [fullscreen]);

  const scale = COLOR_SCALES[layer];

  return (
    <div className={`map-shell forecast-map ${fullscreen ? "fullscreen" : ""}`}>
      <div ref={containerRef} className="weather-map" />

      <div className="map-overlay map-overlay-top">
        <div className="map-layer-pill">
          <span className="live-dot" />
          {layer.toUpperCase()} LAYER
        </div>
        <div className="map-weather-value">{placeValue(layer, hour)}</div>
        <button
          type="button"
          className={windOn ? "active" : ""}
          onClick={() => setWindOn((on) => !on)}
          title={windOn ? "Hide wind particles" : "Show wind particles"}
          aria-label={windOn ? "Hide wind particles" : "Show wind particles"}
        >
          <Wind size={15} />
        </button>
        <button
          type="button"
          onClick={() => setFullscreen((on) => !on)}
          title={fullscreen ? "Exit fullscreen" : "Fullscreen map"}
          aria-label={fullscreen ? "Exit fullscreen map" : "Open fullscreen map"}
        >
          {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>

      <div className="forecast-legend" aria-label={`${layer} colour scale`}>
        <div className="forecast-legend-title">{LEGEND_TITLE[layer]}</div>
        <div className="forecast-legend-bar" style={{ background: legendGradient(scale) }} />
        <div className="forecast-legend-ticks">
          {scale.ticks.map((value: number, index: number) => (
            <span key={value} style={{ left: `${encode(value, scale) * 100}%` }}>
              {value}
              {index === scale.ticks.length - 1 ? ` ${scale.unit}` : ""}
            </span>
          ))}
        </div>
      </div>

      {status && <div className="forecast-status" role="status">{status}</div>}

      <div className="map-overlay map-overlay-bottom">
        <span>{place.name}</span>
        <span>{place.lat.toFixed(2)}°, {place.lon.toFixed(2)}°</span>
      </div>

      <div className="map-disclaimer">ECMWF data · 6-hourly steps · place values from Open-Meteo</div>
    </div>
  );
}
