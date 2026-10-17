// WeatherLayer.jsx
import { useEffect } from "react";
import { useMap } from "react-leaflet";
//import L from "leaflet";

const COLORS = {
  t2m: [
    [0, "#542788"],
    [0.15, "#2c7bb6"],
    [0.3, "#00a6ca"],
    [0.45, "#00ccbc"],
    [0.6, "#90eb9d"],
    [0.72, "#ffff8c"],
    [0.84, "#f9d057"],
    [0.93, "#f29e2e"],
    [1, "#d7191c"],
  ],
  d2m: [
    [0, "#440154"],
    [0.25, "#3b528b"],
    [0.5, "#21918c"],
    [0.75, "#5ec962"],
    [1, "#fde725"],
  ],
  sp: [
    [0, "#313695"],
    [0.2, "#4575b4"],
    [0.4, "#74add1"],
    [0.6, "#abd9e9"],
    [0.8, "#fdae61"],
    [1, "#a50026"],
  ],
  tp: [
    [0, "#f7fbff"],
    [0.15, "#c6dbef"],
    [0.35, "#6baed6"],
    [0.55, "#3182bd"],
    [0.75, "#08519c"],
    [1, "#54278f"],
  ],
  wind_speed: [
    [0, "#440154"],
    [0.2, "#3b528b"],
    [0.4, "#21918c"],
    [0.6, "#5ec962"],
    [0.8, "#fde725"],
    [1, "#d73027"],
  ],
};

const LIMITS = {
  t2m: [-40, 45],
  d2m: [-40, 35],
  sp: [950, 1050], // hPa
  tp: [0, 20], // mm
  wind_speed: [0, 35], // m/s
};

const FIELD_ALIASES = {
  temperature: "t2m",
  temp: "t2m",
  t2m: "t2m",
  dewpoint: "d2m",
  d2m: "d2m",
  pressure: "sp",
  sp: "sp",
  rainfall: "tp",
  rain: "tp",
  precipitation: "tp",
  tp: "tp",
  wind: "wind_speed",
  wind_speed: "wind_speed",
};

function normalizeLongitude(lon) {
  return ((Number(lon) + 180) % 360 + 360) % 360 - 180;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function gridMax(grid) {
  let max = -Infinity;

  for (const row of grid || []) {
    for (const value of row || []) {
      if (finite(value)) max = Math.max(max, value);
    }
  }

  return max;
}

function convertValue(value, field, maxValue) {
  if (!finite(value)) return null;

  // ERA5 temperature is commonly stored in Kelvin.
  if ((field === "t2m" || field === "d2m") && maxValue > 100) {
    return value - 273.15;
  }

  // ERA5 surface pressure is commonly stored in Pascals.
  if (field === "sp" && maxValue > 2000) {
    return value / 100;
  }

  // ERA5 total precipitation is commonly stored in metres.
  if (field === "tp" && maxValue <= 1) {
    return value * 1000;
  }

  return value;
}

function getColor(value, field) {
  const [min, max] = LIMITS[field];
  const stops = COLORS[field];

  if (!finite(value)) return null;

  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));

  for (let i = 1; i < stops.length; i++) {
    const [p2, color2] = stops[i];
    const [p1, color1] = stops[i - 1];

    if (ratio <= p2) {
      const amount = (ratio - p1) / (p2 - p1);

      const rgb1 = color1.match(/\w\w/g).map((c) => parseInt(c, 16));
      const rgb2 = color2.match(/\w\w/g).map((c) => parseInt(c, 16));

      const rgb = rgb1.map((c, j) =>
        Math.round(c + (rgb2[j] - c) * amount)
      );

      return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    }
  }

  return stops[stops.length - 1][1];
}

function nearestIndex(values, target) {
  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let i = 0; i < values.length; i++) {
    const distance = Math.abs(Number(values[i]) - target);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return bestIndex;
}

export default function WeatherLayer({
  weather,
  layer,
  frameIndex = 0,
  showWind = true,
}) {
  const map = useMap();

  useEffect(() => {
    if (!weather?.latitude?.length || !weather?.longitude?.length) {
      console.warn("WeatherLayer: latitude/longitude grid is missing.", weather);
      return;
    }

    const frame = weather.frames?.[frameIndex];

    if (!frame) {
      console.warn("WeatherLayer: frame not found.", frameIndex);
      return;
    }

    const field = FIELD_ALIASES[layer] || layer;
    const rawGrid = frame[field];

    if (!rawGrid?.length) {
      console.warn(
        `WeatherLayer: no data for "${field}". Available fields:`,
        Object.keys(frame)
      );
      return;
    }

    const latitudes = weather.latitude.map(Number);
    const longitudes = weather.longitude.map(Number);

    if (
      rawGrid.length !== latitudes.length ||
      !rawGrid[0] ||
      rawGrid[0].length !== longitudes.length
    ) {
      console.error("WeatherLayer: grid dimensions do not match coordinates.", {
        gridRows: rawGrid.length,
        latitudeCount: latitudes.length,
        gridColumns: rawGrid[0]?.length,
        longitudeCount: longitudes.length,
        field,
      });
      return;
    }

    const maxRawValue = gridMax(rawGrid);

    if (!Number.isFinite(maxRawValue)) {
      console.error("WeatherLayer: grid contains no valid numeric data.", field);
      return;
    }

    const grid = rawGrid.map((row) =>
      row.map((value) => convertValue(Number(value), field, maxRawValue))
    );

    const container = map.getContainer();
    const canvas = document.createElement("canvas");

    canvas.className = "weather-data-overlay";
    canvas.style.cssText = `
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 450;
    `;

    container.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    let animationId = null;
    let particles = [];
    let lastAnimationTime = 0;

    function resizeCanvas() {
      const size = map.getSize();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas.width = Math.round(size.x * dpr);
      canvas.height = Math.round(size.y * dpr);
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function getCoordinateStep(values) {
      if (values.length < 2) return 0.25;

      const differences = [];

      for (let i = 1; i < Math.min(values.length, 20); i++) {
        const difference = Math.abs(values[i] - values[i - 1]);
        if (difference > 0) differences.push(difference);
      }

      return differences.length
        ? differences.reduce((sum, value) => sum + value, 0) /
            differences.length
        : 0.25;
    }

    const latStep = getCoordinateStep(latitudes);
    const lonStep = getCoordinateStep(longitudes);

    function drawField() {
      resizeCanvas();

      const size = map.getSize();
      ctx.clearRect(0, 0, size.x, size.y);

      const rows = latitudes.length;
      const cols = longitudes.length;

      // Draw each grid cell geographically, rather than stretching the
      // dataset over the entire screen.
      const stride = Math.max(1, Math.floor(Math.max(rows, cols) / 500));

      ctx.globalAlpha = field === "tp" ? 0.78 : 0.72;

      for (let r = 0; r < rows; r += stride) {
        const lat = latitudes[r];

        for (let c = 0; c < cols; c += stride) {
          const value = grid[r]?.[c];
          const color = getColor(value, field);

          if (!color || !finite(lat) || !finite(longitudes[c])) continue;

          const lon = normalizeLongitude(longitudes[c]);

          const topLeft = map.latLngToContainerPoint([
            Math.min(89.9, lat + latStep / 2),
            lon - lonStep / 2,
          ]);

          const bottomRight = map.latLngToContainerPoint([
            Math.max(-89.9, lat - latStep / 2),
            lon + lonStep / 2,
          ]);

          let x1 = Math.min(topLeft.x, bottomRight.x);
          let y1 = Math.min(topLeft.y, bottomRight.y);
          let width = Math.abs(bottomRight.x - topLeft.x);
          let height = Math.abs(bottomRight.y - topLeft.y);

          // Avoid drawing giant rectangles across the antimeridian.
          if (width > size.x / 2) continue;

          // If sampling a large grid, cover the skipped cells too.
          if (stride > 1) {
            width = Math.max(width, 1);
            height = Math.max(height, 1);
          }

          if (
            x1 > size.x ||
            y1 > size.y ||
            x1 + width < 0 ||
            y1 + height < 0
          ) {
            continue;
          }

          ctx.fillStyle = color;
          ctx.fillRect(x1, y1, Math.max(width + 0.5, 1), Math.max(height + 0.5, 1));
        }
      }

      ctx.globalAlpha = 1;
    }

    function sampleWind(lat, lon) {
      const row = nearestIndex(latitudes, lat);
      const col = nearestIndex(
        longitudes.map(normalizeLongitude),
        normalizeLongitude(lon)
      );

      const u = Number(frame.u10?.[row]?.[col]);
      const v = Number(frame.v10?.[row]?.[col]);

      if (!Number.isFinite(u) || !Number.isFinite(v)) return null;

      return { u, v };
    }

    function seedParticles() {
      const size = map.getSize();
      const count = Math.min(900, Math.max(180, Math.floor((size.x * size.y) / 1800)));

      particles = Array.from({ length: count }, () => ({
        x: Math.random() * size.x,
        y: Math.random() * size.y,
        age: Math.random() * 70,
      }));
    }

    function animate(timestamp) {
      if (field !== "wind_speed" || !showWind || !frame.u10 || !frame.v10) {
        return;
      }

      animationId = requestAnimationFrame(animate);

      if (timestamp - lastAnimationTime < 33) return;
      lastAnimationTime = timestamp;

      const size = map.getSize();

      ctx.globalAlpha = 0.13;
      ctx.fillStyle = "rgba(12, 20, 30, 0.35)";
      ctx.fillRect(0, 0, size.x, size.y);
      ctx.globalAlpha = 1;

      for (const particle of particles) {
        const oldX = particle.x;
        const oldY = particle.y;

        const latlng = map.containerPointToLatLng([particle.x, particle.y]);
        const wind = sampleWind(latlng.lat, latlng.lng);

        if (wind) {
          const scale = 0.12;

          const nextLat = latlng.lat + wind.v * scale * 0.01;
          const nextLon =
            latlng.lng + (wind.u * scale * 0.01) / Math.max(0.2, Math.cos((latlng.lat * Math.PI) / 180));

          const nextPoint = map.latLngToContainerPoint([nextLat, nextLon]);

          particle.x = nextPoint.x;
          particle.y = nextPoint.y;

          ctx.strokeStyle = "rgba(255,255,255,0.8)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(oldX, oldY);
          ctx.lineTo(particle.x, particle.y);
          ctx.stroke();
        }

        particle.age++;

        if (
          particle.age > 90 ||
          particle.x < 0 ||
          particle.y < 0 ||
          particle.x > size.x ||
          particle.y > size.y
        ) {
          particle.x = Math.random() * size.x;
          particle.y = Math.random() * size.y;
          particle.age = 0;
        }
      }
    }

    function redraw() {
      if (animationId !== null) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }

      drawField();
      if (field === "wind_speed" && showWind && frame.u10 && frame.v10_) {
        seedParticles();
        ctx.clearRect(0, 0, map.getSize().x, map.getSize().y);
        drawField();
        animationId = requestAnimationFrame(animate);
      }
    }

    map.on("moveend", redraw);
    map.on("zoomend", redraw);
    map.on("resize", redraw);

    redraw();

    console.info("Weather overlay rendered:", {
      field,
      rows: grid.length,
      columns: grid[0]?.length,
      rawMaximum: maxRawValue,
      convertedRange: [
        Math.min(...grid.flat().filter(finite)),
        Math.max(...grid.flat().filter(finite)),
      ],
    });

    return () => {
      if (animationId !== null) cancelAnimationFrame(animationId);

      map.off("moveend", redraw);
      map.off("zoomend", redraw);
      map.off("resize", redraw);

      canvas.remove();
    };
  }, [map, weather, layer, frameIndex, showWind]);

  return null;
}