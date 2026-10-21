
import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import WebGLWeatherLayer from "./WebGLWeatherLayer";

setWorkerUrl(workerUrl);

export default function WeatherMap({ coords, frame, layer, showWind }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const latest = useRef({ coords, frame, layer, showWind });

  useEffect(() => {
    latest.current = { coords, frame, layer, showWind };
    layerRef.current?.update(coords, frame, layer, showWind);
  }, [coords, frame, layer, showWind]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      center: [78, 21],
      zoom: 3.4,
      minZoom: 2,
      maxZoom: 12,
      attributionControl: { compact: true },
      renderWorldCopies: true,
      canvasContextAttributes: { antialias: true },
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          }
        },
        layers: [{
          id: "osm-base",
          type: "raster",
          source: "osm",
          paint: { "raster-fade-duration": 0 }
        }]
      }
    });

    const weatherLayer = new WebGLWeatherLayer();
    mapRef.current = map;
    layerRef.current = weatherLayer;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      map.addLayer(weatherLayer);
      const l = latest.current;
      weatherLayer.update(l.coords, l.frame, l.layer, l.showWind);
    });

    map.on("error", e => console.warn("[NFD] MapLibre error:", e.error?.message || e.error));

    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  return <div ref={containerRef} className="weather-map" />;
}
