
import { useCallback, useEffect, useRef, useState } from "react";
import {
    Map as MapLibreMap,
    Marker,
    NavigationControl,
    setWorkerUrl,
    type GeoJSONSource,
    type MapMouseEvent,
    type Marker as MapLibreMarker,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import {
    Maximize2,
    Minimize2,
    Pause,
    Play,
    Wind,
} from "lucide-react";
import "maplibre-gl/dist/maplibre-gl.css";

setWorkerUrl(workerUrl);

export type Coordinates = {
    lat: number;
    lon: number;
};

export type WeatherLayer =
    | "wind"
    | "temperature"
    | "rain"
    | "clouds"
    | "humidity";

type WeatherMapProps = {
    center: Coordinates;
    activeLayer: WeatherLayer;
    selectedHour: number;
    onLocationSelect: (location: Coordinates) => void;
};

type Sample = {
    lat: number;
    lon: number;
    temperature: number;
    rain: number;
    wind: number;
    direction: number;
    clouds: number;
    humidity: number;
};

type ForecastLocation = {
    latitude: number;
    longitude: number;
    current?: Record<string, string | number | null>;
    hourly?: {
        time?: string[];
        temperature_2m?: number[];
        precipitation_probability?: number[];
        wind_speed_10m?: number[];
        wind_direction_10m?: number[];
        cloud_cover?: number[];
        relative_humidity_2m?: number[];
    };
};

type Vector = {
    x: number;
    y: number;
    u: number;
    v: number;
    speed: number;
};

type Particle = {
    x: number;
    y: number;
    age: number;
};

const SOURCE = "atmos-weather-source";
const DOTS = "atmos-weather-dots";
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

const GRID_ROWS = 9;
const GRID_COLUMNS = 11;
const PARTICLE_COUNT = 800;
const MAX_AGE = 115;
const FIELD_COLUMNS = 120;
const FIELD_ROWS = 75;
const FIELD_MAX_DISTANCE = 380;

const buttonStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 38,
    padding: "9px 12px",
    border: "1px solid rgba(112,220,210,0.35)",
    borderRadius: 9,
    background: "rgba(10,31,40,0.96)",
    color: "#75f0d0",
    cursor: "pointer",
    font: "600 11px system-ui, sans-serif",
};

function numberValue(
    value: string | number | null | undefined,
): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }

    return 0;
}

function colorFor(value: number, layer: WeatherLayer): string {
    if (layer === "temperature") {
        if (value < 0) return "#648cff";
        if (value < 10) return "#43c8ed";
        if (value < 20) return "#4cdbab";
        if (value < 30) return "#ffd166";
        return "#ff665e";
    }

    if (layer === "rain") {
        if (value < 10) return "#9ae5f7";
        if (value < 25) return "#399bff";
        if (value < 50) return "#625df6";
        if (value < 75) return "#a75ff3";
        return "#ed6fd8";
    }

    if (layer === "clouds") {
        if (value < 25) return "#f4d579";
        if (value < 50) return "#bdcbdc";
        if (value < 75) return "#8298b5";
        return "#526780";
    }

    if (layer === "humidity") {
        if (value < 20) return "#f5d76e";
        if (value < 40) return "#8bdc9b";
        if (value < 60) return "#36c9b5";
        if (value < 80) return "#328be8";
        return "#7358d8";
    }

    if (value < 5) return "#9af0c8";
    if (value < 10) return "#40dcae";
    if (value < 20) return "#36cbe8";
    if (value < 30) return "#628eff";
    if (value < 40) return "#a17af8";
    if (value < 55) return "#e27bcf";
    return "#ff956b";
}

function colorStops(value: number): [number, number, number] {
    const stops: Array<{
        value: number;
        color: [number, number, number];
    }> = [
            { value: 0, color: [154, 240, 200] },
            { value: 5, color: [64, 220, 174] },
            { value: 10, color: [54, 203, 232] },
            { value: 20, color: [98, 142, 255] },
            { value: 30, color: [161, 122, 248] },
            { value: 40, color: [226, 123, 207] },
            { value: 55, color: [255, 149, 107] },
        ];

    if (value <= stops[0].value) return stops[0].color;

    for (let i = 1; i < stops.length; i++) {
        const previous = stops[i - 1];
        const next = stops[i];

        if (value <= next.value) {
            const ratio =
                (value - previous.value) /
                (next.value - previous.value);

            return [
                Math.round(
                    previous.color[0] +
                    (next.color[0] - previous.color[0]) * ratio,
                ),
                Math.round(
                    previous.color[1] +
                    (next.color[1] - previous.color[1]) * ratio,
                ),
                Math.round(
                    previous.color[2] +
                    (next.color[2] - previous.color[2]) * ratio,
                ),
            ];
        }
    }

    return stops[stops.length - 1].color;
}

function sampleValue(sample: Sample, layer: WeatherLayer): number {
    switch (layer) {
        case "temperature":
            return sample.temperature;
        case "rain":
            return sample.rain;
        case "clouds":
            return sample.clouds;
        case "humidity":
            return sample.humidity;
        default:
            return sample.wind;
    }
}

function makeFeatures(samples: Sample[], layer: WeatherLayer) {
    return {
        type: "FeatureCollection" as const,
        features: samples.map((sample) => ({
            type: "Feature" as const,
            geometry: {
                type: "Point" as const,
                coordinates: [sample.lon, sample.lat],
            },
            properties: {
                color: colorFor(sampleValue(sample, layer), layer),
            },
        })),
    };
}

function makeParticle(width: number, height: number): Particle {
    return {
        x: Math.random() * Math.max(1, width),
        y: Math.random() * Math.max(1, height),
        age: Math.random() * MAX_AGE,
    };
}

function getViewportPoints(map: MapLibreMap): Coordinates[] {
    const bounds = map.getBounds();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = Math.max(-75, bounds.getSouth());
    const north = Math.min(75, bounds.getNorth());

    const points: Coordinates[] = [];

    for (let row = 0; row < GRID_ROWS; row++) {
        const lat = south + ((north - south) * row) / (GRID_ROWS - 1);

        for (let column = 0; column < GRID_COLUMNS; column++) {
            const lon =
                west + ((east - west) * column) / (GRID_COLUMNS - 1);

            points.push({
                lat,
                lon: ((lon + 540) % 360) - 180,
            });
        }
    }

    return points;
}

function buildSamples(
    locations: ForecastLocation[],
    selectedHour: number,
): Sample[] {
    return locations.flatMap((location) => {
        const hourly = location.hourly;
        const current = location.current;

        if (!hourly?.time?.length) return [];

        const currentTime = String(current?.time ?? "").slice(0, 13);

        const foundIndex = hourly.time.findIndex(
            (time) => time.slice(0, 13) === currentTime,
        );

        const startIndex = Math.max(0, foundIndex);
        const index = Math.min(
            startIndex + Math.max(0, selectedHour),
            hourly.time.length - 1,
        );

        return [
            {
                lat: numberValue(location.latitude),
                lon: numberValue(location.longitude),
                temperature:
                    hourly.temperature_2m?.[index] ??
                    numberValue(current?.temperature_2m),
                rain:
                    hourly.precipitation_probability?.[index] ??
                    numberValue(current?.precipitation_probability),
                wind:
                    hourly.wind_speed_10m?.[index] ??
                    numberValue(current?.wind_speed_10m),
                direction:
                    hourly.wind_direction_10m?.[index] ??
                    numberValue(current?.wind_direction_10m),
                clouds:
                    hourly.cloud_cover?.[index] ??
                    numberValue(current?.cloud_cover),
                humidity:
                    hourly.relative_humidity_2m?.[index] ??
                    numberValue(current?.relative_humidity_2m),
            },
        ];
    });
}

function projectSamples(
    map: MapLibreMap,
    samples: Sample[],
): Vector[] {
    return samples.map((sample) => {
        const point = map.project([sample.lon, sample.lat]);
        const angle = (sample.direction * Math.PI) / 180;

        return {
            x: point.x,
            y: point.y,
            u: -Math.sin(angle) * sample.wind,
            v: -Math.cos(angle) * sample.wind,
            speed: sample.wind,
        };
    });
}

function interpolateWind(x: number, y: number, vectors: Vector[]) {
    let totalWeight = 0;
    let u = 0;
    let v = 0;
    let speed = 0;

    let nearest: Vector | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const vector of vectors) {
        const dx = vector.x - x;
        const dy = vector.y - y;
        const distanceSquared = dx * dx + dy * dy;

        if (distanceSquared < nearestDistance) {
            nearestDistance = distanceSquared;
            nearest = vector;
        }

        if (distanceSquared > FIELD_MAX_DISTANCE ** 2) continue;

        const weight = 1 / Math.pow(distanceSquared + 625, 1.05);

        u += vector.u * weight;
        v += vector.v * weight;
        speed += vector.speed * weight;
        totalWeight += weight;
    }

    if (totalWeight === 0) {
        return nearest
            ? { u: nearest.u, v: nearest.v, speed: nearest.speed }
            : { u: 0, v: 0, speed: 0 };
    }

    return {
        u: u / totalWeight,
        v: v / totalWeight,
        speed: speed / totalWeight,
    };
}

function renderWindField(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    vectors: Vector[],
) {
    if (width <= 0 || height <= 0 || vectors.length === 0) return;

    const image = context.createImageData(FIELD_COLUMNS, FIELD_ROWS);

    for (let y = 0; y < FIELD_ROWS; y++) {
        for (let x = 0; x < FIELD_COLUMNS; x++) {
            const screenX = (x / (FIELD_COLUMNS - 1)) * width;
            const screenY = (y / (FIELD_ROWS - 1)) * height;
            const wind = interpolateWind(screenX, screenY, vectors);
            const [red, green, blue] = colorStops(wind.speed);
            const index = (y * FIELD_COLUMNS + x) * 4;

            image.data[index] = red;
            image.data[index + 1] = green;
            image.data[index + 2] = blue;
            image.data[index + 3] = 105;
        }
    }

    const offscreen = document.createElement("canvas");
    offscreen.width = FIELD_COLUMNS;
    offscreen.height = FIELD_ROWS;

    const offscreenContext = offscreen.getContext("2d");
    if (!offscreenContext) return;

    offscreenContext.putImageData(image, 0, 0);

    context.clearRect(0, 0, width, height);
    context.save();
    context.globalAlpha = 0.78;
    context.imageSmoothingEnabled = true;
    context.drawImage(offscreen, 0, 0, width, height);
    context.restore();
}

export default function WeatherMap({
    center,
    activeLayer,
    selectedHour,
    onLocationSelect,
}: WeatherMapProps) {
    const mapElement = useRef<HTMLDivElement>(null);
    const fieldCanvas = useRef<HTMLCanvasElement>(null);
    const particleCanvas = useRef<HTMLCanvasElement>(null);

    const mapRef = useRef<MapLibreMap | null>(null);
    const markerRef = useRef<MapLibreMarker | null>(null);
    const samplesRef = useRef<Sample[]>([]);
    const requestRef = useRef(0);
    const redrawFieldRef = useRef<(() => void) | null>(null);

    const centerRef = useRef(center);
    const layerRef = useRef(activeLayer);
    const hourRef = useRef(selectedHour);
    const selectRef = useRef(onLocationSelect);

    const [windEnabled, setWindEnabled] = useState(true);
    const [isPlaying, setIsPlaying] = useState(true);
    const [animationSpeed, setAnimationSpeed] = useState(1);
    const [mapError, setMapError] = useState("");
    const [isFullscreen, setIsFullscreen] = useState(false);

    useEffect(() => {
        centerRef.current = center;
    }, [center]);

    useEffect(() => {
        layerRef.current = activeLayer;

        const map = mapRef.current;

        if (map?.isStyleLoaded()) {
            const source = map.getSource(SOURCE) as
                | GeoJSONSource
                | undefined;

            source?.setData(makeFeatures(samplesRef.current, activeLayer));

            if (map.getLayer(DOTS)) {
                map.setPaintProperty(
                    DOTS,
                    "circle-opacity",
                    activeLayer === "wind" ? 0 : 0.72,
                );
            }
        }

        redrawFieldRef.current?.();
    }, [activeLayer]);

    useEffect(() => {
        hourRef.current = selectedHour;
    }, [selectedHour]);

    useEffect(() => {
        selectRef.current = onLocationSelect;
    }, [onLocationSelect]);

    const loadGrid = useCallback(async () => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;

        const requestId = ++requestRef.current;
        const points = getViewportPoints(map);

        const params = new URLSearchParams({
            latitude: points.map((point) => point.lat.toFixed(3)).join(","),
            longitude: points.map((point) => point.lon.toFixed(3)).join(","),
            current:
                "temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m,cloud_cover,relative_humidity_2m",
            hourly:
                "temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m,cloud_cover,relative_humidity_2m",
            forecast_days: "2",
            timezone: "auto",
            wind_speed_unit: "kmh",
        });

        try {
            const response = await fetch(
                `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
            );

            if (!response.ok) {
                throw new Error(`Open-Meteo returned ${response.status}`);
            }

            const result: unknown = await response.json();

            const locations: ForecastLocation[] = Array.isArray(result)
                ? (result as ForecastLocation[])
                : [result as ForecastLocation];

            if (
                requestId !== requestRef.current ||
                mapRef.current !== map
            ) {
                return;
            }

            samplesRef.current = buildSamples(
                locations,
                hourRef.current,
            );

            const source = map.getSource(SOURCE) as
                | GeoJSONSource
                | undefined;

            source?.setData(
                makeFeatures(samplesRef.current, layerRef.current),
            );

            setMapError("");
            redrawFieldRef.current?.();
        } catch (error) {
            if (requestId !== requestRef.current) return;

            console.error("Atmos forecast grid failed:", error);
            setMapError("Weather data unavailable. Check your connection.");
        }
    }, []);

    useEffect(() => {
        const container = mapElement.current;
        if (!container) return;

        let disposed = false;

        const map = new MapLibreMap({
            container,
            style: MAP_STYLE,
            center: [centerRef.current.lon, centerRef.current.lat],
            zoom: 2.8,
            minZoom: 1.5,
            maxZoom: 12,
            renderWorldCopies: true,
            attributionControl: { compact: true },
        });

        mapRef.current = map;

        map.addControl(
            new NavigationControl({ visualizePitch: true }),
            "top-right",
        );

        map.on("error", (event) => {
            console.error("Atmos MapLibre error:", event.error);
        });

        map.on("click", (event: MapMouseEvent) => {
            selectRef.current({
                lat: event.lngLat.lat,
                lon: event.lngLat.lng,
            });
        });

        map.on("load", () => {
            if (disposed) return;

            if (!map.getSource(SOURCE)) {
                map.addSource(SOURCE, {
                    type: "geojson",
                    data: {
                        type: "FeatureCollection",
                        features: [],
                    },
                });
            }

            if (!map.getLayer(DOTS)) {
                map.addLayer({
                    id: DOTS,
                    type: "circle",
                    source: SOURCE,
                    paint: {
                        "circle-radius": [
                            "interpolate",
                            ["linear"],
                            ["zoom"],
                            2, 3,
                            5, 6,
                            8, 10,
                        ],
                        "circle-color": ["get", "color"],
                        "circle-opacity":
                            layerRef.current === "wind" ? 0 : 0.72,
                        "circle-stroke-color": "#ffffff",
                        "circle-stroke-width": 1,
                    },
                });
            }

            const initial = centerRef.current;

            markerRef.current = new Marker({ color: "#18bfc2" })
                .setLngLat([initial.lon, initial.lat])
                .addTo(map);

            map.resize();
            void loadGrid();
        });

        map.on("moveend", () => {
            if (disposed) return;
            redrawFieldRef.current?.();
            void loadGrid();
        });

        const observer = new ResizeObserver(() => {
            if (disposed) return;
            map.resize();
            redrawFieldRef.current?.();
        });

        observer.observe(container);

        return () => {
            disposed = true;
            requestRef.current += 1;
            observer.disconnect();

            markerRef.current?.remove();
            markerRef.current = null;

            map.remove();

            if (mapRef.current === map) {
                mapRef.current = null;
            }
        };
    }, [loadGrid]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        map.flyTo({
            center: [center.lon, center.lat],
            duration: 650,
        });

        markerRef.current?.setLngLat([center.lon, center.lat]);
    }, [center.lat, center.lon]);

    useEffect(() => {
        void loadGrid();
    }, [selectedHour, loadGrid]);

    useEffect(() => {
        const canvas = fieldCanvas.current;
        if (!canvas) return;

        const context = canvas.getContext("2d");
        if (!context) return;

        let width = 0;
        let height = 0;
        let pixelRatio = 1;

        const resize = () => {
            const rect = canvas.getBoundingClientRect();

            width = rect.width;
            height = rect.height;
            pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

            canvas.width = Math.round(width * pixelRatio);
            canvas.height = Math.round(height * pixelRatio);

            context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            redraw();
        };

        const redraw = () => {
            context.clearRect(0, 0, width, height);

            if (
                activeLayer !== "wind" ||
                !windEnabled ||
                !mapRef.current ||
                samplesRef.current.length === 0
            ) {
                return;
            }

            const vectors = projectSamples(
                mapRef.current,
                samplesRef.current,
            );

            renderWindField(context, width, height, vectors);
        };

        redrawFieldRef.current = redraw;

        const observer = new ResizeObserver(resize);
        observer.observe(canvas);
        resize();

        const map = mapRef.current;
        const onMapMove = () => redraw();

        map?.on("move", onMapMove);
        map?.on("moveend", onMapMove);

        return () => {
            observer.disconnect();
            map?.off("move", onMapMove);
            map?.off("moveend", onMapMove);

            if (redrawFieldRef.current === redraw) {
                redrawFieldRef.current = null;
            }

            context.clearRect(0, 0, width, height);
        };
    }, [activeLayer, windEnabled, selectedHour]);

    useEffect(() => {
        const canvas = particleCanvas.current;
        if (!canvas) return;

        const context = canvas.getContext("2d");
        if (!context) return;

        let frameId = 0;
        let lastTime = 0;
        let width = 0;
        let height = 0;
        let particles: Particle[] = [];

        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            const ratio = Math.min(window.devicePixelRatio || 1, 2);

            width = rect.width;
            height = rect.height;

            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
            context.setTransform(ratio, 0, 0, ratio, 0, 0);

            particles = Array.from(
                { length: PARTICLE_COUNT },
                () => makeParticle(width, height),
            );

            context.clearRect(0, 0, width, height);
        };

        const observer = new ResizeObserver(resize);
        observer.observe(canvas);
        resize();

        const animate = (time: number) => {
            const delta = lastTime
                ? Math.min((time - lastTime) / 16.67, 1.5)
                : 1;

            lastTime = time;

            const map = mapRef.current;
            const samples = samplesRef.current;

            if (
                !windEnabled ||
                !isPlaying ||
                activeLayer !== "wind" ||
                !map ||
                samples.length === 0
            ) {
                context.clearRect(0, 0, width, height);
                frameId = requestAnimationFrame(animate);
                return;
            }

            const vectors = projectSamples(map, samples);

            // Fade the previous trails gradually for continuous flow.
            context.globalCompositeOperation = "destination-out";
            context.fillStyle = "rgba(0, 0, 0, 0.085)";
            context.fillRect(0, 0, width, height);
            context.globalCompositeOperation = "source-over";

            for (const particle of particles) {
                if (
                    particle.x < -12 ||
                    particle.x > width + 12 ||
                    particle.y < -12 ||
                    particle.y > height + 12 ||
                    particle.age > MAX_AGE
                ) {
                    Object.assign(
                        particle,
                        makeParticle(width, height),
                    );
                    continue;
                }

                const wind = interpolateWind(
                    particle.x,
                    particle.y,
                    vectors,
                );

                const dx = wind.u * 0.34 * delta * animationSpeed;
                const dy = wind.v * 0.34 * delta * animationSpeed;

                context.beginPath();
                context.moveTo(
                    particle.x - dx * 5,
                    particle.y - dy * 5,
                );
                context.lineTo(particle.x, particle.y);

                context.strokeStyle = colorFor(wind.speed, "wind");
                context.globalAlpha = 0.76;
                context.lineWidth = wind.speed >= 30 ? 1.35 : 0.95;
                context.lineCap = "round";
                context.stroke();

                particle.x += dx;
                particle.y += dy;
                particle.age += delta;
            }

            context.globalAlpha = 1;
            context.globalCompositeOperation = "source-over";

            frameId = requestAnimationFrame(animate);
        };

        frameId = requestAnimationFrame(animate);

        return () => {
            cancelAnimationFrame(frameId);
            observer.disconnect();
            context.clearRect(0, 0, width, height);
        };
    }, [activeLayer, windEnabled, isPlaying, animationSpeed]);

    // Keep the map correctly sized when entering or leaving fullscreen.
    useEffect(() => {
        const frame = requestAnimationFrame(() => {
            mapRef.current?.resize();
            redrawFieldRef.current?.();
        });

        return () => cancelAnimationFrame(frame);
    }, [isFullscreen]);

    const toggleFullscreen = () => {
        setIsFullscreen((current) => !current);
    };

    return (
        <div
            className="weather-map"
            style={{
                position: isFullscreen ? "fixed" : "absolute",
                inset: 0,
                width: isFullscreen ? "100vw" : "100%",
                height: isFullscreen ? "100dvh" : "100%",
                minHeight: 420,
                zIndex: isFullscreen ? 9999 : undefined,
                overflow: "hidden",
                background: "#dce7ed",
            }}
        >
            <div
                ref={mapElement}
                style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                }}
            />

            <canvas
                ref={fieldCanvas}
                aria-hidden="true"
                style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    zIndex: 2,
                    pointerEvents: "none",
                }}
            />

            <canvas
                ref={particleCanvas}
                aria-hidden="true"
                style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    zIndex: 3,
                    pointerEvents: "none",
                }}
            />

            <div
                style={{
                    position: "absolute",
                    top: 14,
                    left: 14,
                    zIndex: 10,
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 8,
                    maxWidth: "calc(100% - 28px)",
                }}
            >
                <button
                    type="button"
                    onClick={() => setWindEnabled((value) => !value)}
                    aria-pressed={windEnabled}
                    style={{
                        ...buttonStyle,
                        color: windEnabled ? "#75f0d0" : "#d0d6df",
                    }}
                >
                    <Wind size={16} />
                    WIND FIELD
                    <span>{windEnabled ? "ON" : "OFF"}</span>
                </button>

                <button
                    type="button"
                    onClick={() => setIsPlaying((value) => !value)}
                    aria-label={
                        isPlaying
                            ? "Pause wind animation"
                            : "Play wind animation"
                    }
                    title={isPlaying ? "Pause animation" : "Play animation"}
                    style={{
                        ...buttonStyle,
                        width: 40,
                        padding: 8,
                    }}
                >
                    {isPlaying ? (
                        <Pause size={16} />
                    ) : (
                        <Play size={16} />
                    )}
                </button>

                <button
                    type="button"
                    onClick={() =>
                        setAnimationSpeed((speed) =>
                            speed >= 2 ? 0.5 : speed + 0.5,
                        )
                    }
                    title="Change wind animation speed"
                    style={buttonStyle}
                >
                    {animationSpeed.toFixed(1)}× SPEED
                </button>

                <button
                    type="button"
                    onClick={toggleFullscreen}
                    aria-label={
                        isFullscreen
                            ? "Exit fullscreen map"
                            : "Open fullscreen map"
                    }
                    aria-pressed={isFullscreen}
                    title={isFullscreen ? "Exit fullscreen" : "Fullscreen map"}
                    style={{
                        ...buttonStyle,
                        width: 40,
                        padding: 8,
                    }}
                >
                    {isFullscreen ? (
                        <Minimize2 size={16} />
                    ) : (
                        <Maximize2 size={16} />
                    )}
                </button>
            </div>

            {activeLayer === "wind" && windEnabled && (
                <div
                    style={{
                        position: "absolute",
                        right: 14,
                        top: 65,
                        zIndex: 8,
                        width: 190,
                        maxWidth: "calc(100% - 28px)",
                        padding: "12px 13px",
                        border: "1px solid rgba(30,48,65,0.14)",
                        borderRadius: 9,
                        background: "rgba(250,252,254,0.96)",
                        boxShadow: "0 4px 16px rgba(20,35,50,0.1)",
                        color: "#203246",
                        pointerEvents: "none",
                    }}
                >
                    <div
                        style={{
                            marginBottom: 10,
                            font: "500 9px ui-monospace, monospace",
                            letterSpacing: 0.5,
                        }}
                    >
                        GLOBAL WIND SPEED · km/h
                    </div>

                    <div
                        style={{
                            height: 7,
                            borderRadius: 10,
                            background:
                                "linear-gradient(90deg,#9af0c8,#40dcae,#36cbe8,#628eff,#a17af8,#e27bcf,#ff956b)",
                        }}
                    />

                    <div
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            marginTop: 7,
                            color: "#687b91",
                            font: "9px ui-monospace, monospace",
                        }}
                    >
                        <span>0</span>
                        <span>5</span>
                        <span>10</span>
                        <span>20</span>
                        <span>30</span>
                        <span>40+</span>
                    </div>
                </div>
            )}

            {activeLayer !== "wind" && (
                <div
                    style={{
                        position: "absolute",
                        right: 14,
                        bottom: 18,
                        zIndex: 8,
                        width: 205,
                        maxWidth: "calc(100% - 28px)",
                        padding: "12px 13px",
                        borderRadius: 9,
                        background: "rgba(250,252,254,0.96)",
                        boxShadow: "0 4px 16px rgba(20,35,50,0.1)",
                        color: "#203246",
                        pointerEvents: "none",
                    }}
                >
                    <div
                        style={{
                            marginBottom: 9,
                            font: "600 10px system-ui, sans-serif",
                        }}
                    >
                        {activeLayer === "temperature" && "TEMPERATURE · °C"}
                        {activeLayer === "rain" && "PRECIPITATION PROBABILITY · %"}
                        {activeLayer === "clouds" && "CLOUD COVER · %"}
                        {activeLayer === "humidity" && "RELATIVE HUMIDITY · %"}
                    </div>

                    <div
                        style={{
                            height: 8,
                            borderRadius: 10,
                            background:
                                activeLayer === "temperature"
                                    ? "linear-gradient(90deg,#648cff,#43c8ed,#4cdbab,#ffd166,#ff665e)"
                                    : activeLayer === "rain"
                                        ? "linear-gradient(90deg,#9ae5f7,#399bff,#625df6,#a75ff3,#ed6fd8)"
                                        : activeLayer === "clouds"
                                            ? "linear-gradient(90deg,#f4d579,#bdcbdc,#8298b5,#526780)"
                                            : "linear-gradient(90deg,#f5d76e,#8bdc9b,#36c9b5,#328be8,#7358d8)",
                        }}
                    />

                    <div
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            marginTop: 7,
                            color: "#687b91",
                            font: "9px ui-monospace, monospace",
                        }}
                    >
                        {activeLayer === "temperature" ? (
                            <>
                                <span>−10°</span>
                                <span>0°</span>
                                <span>15°</span>
                                <span>30°+</span>
                            </>
                        ) : (
                            <>
                                <span>0%</span>
                                <span>25%</span>
                                <span>50%</span>
                                <span>75%</span>
                                <span>100%</span>
                            </>
                        )}
                    </div>
                </div>
            )}

            {mapError && (
                <div
                    role="status"
                    style={{
                        position: "absolute",
                        left: 14,
                        bottom: 14,
                        zIndex: 10,
                        maxWidth: 300,
                        padding: "9px 12px",
                        borderRadius: 8,
                        background: "rgba(10,31,40,0.96)",
                        color: "#ffd166",
                        font: "12px system-ui, sans-serif",
                    }}
                >
                    {mapError}
                </div>
            )}
        </div>
    );
}
