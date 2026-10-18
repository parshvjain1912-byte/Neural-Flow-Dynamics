import { COLOR_SCALES, buildLut, encode } from "./Colorscales";

const FIELD_CONFIG = {
  temperature: { key: "t2m", convert: v => v - 273.15 },
  wind: { key: "wind_speed", convert: v => v },
  // Prefers mean-sea-level pressure ("msl"); falls back to surface pressure ("sp").
  pressure: { key: "msl", fallback: "sp", convert: v => v / 100 },
  rainfall: { key: "tp", convert: v => v * 1000 },
};

const FIELD_ALIASES = {
  t2m: "temperature", temperature: "temperature",
  wind_speed: "wind", wind: "wind", u10: "wind", v10: "wind",
  sp: "pressure", pressure: "pressure",
  tp: "rainfall", rainfall: "rainfall",
};

const EARTH_CIRCUMFERENCE = 40075016.686;

function normalizeFieldName(name) {
  return FIELD_ALIASES[String(name || "temperature").toLowerCase()] || "temperature";
}

function mercatorX(lon) {
  return (lon + 180) / 360;
}

function mercatorY(lat) {
  const r = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(r)) / Math.PI) / 2;
}

function flattenGrid(value) {
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (!Array.isArray(value)) return [];
  return value.flat(Infinity);
}

function getBinaryField(frame, key) {
  const { data, metadata } = frame || {};
  if (!data || !metadata?.variables || !metadata?.shape) return null;

  const variableIndex = metadata.variables.indexOf(key);
  if (variableIndex < 0) return null;

  const [timeCount, variableCount, rows, cols] = metadata.shape;
  const timeIndex = frame.timeIndex ?? 0;

  if (
    timeIndex < 0 || timeIndex >= timeCount ||
    variableCount !== metadata.variables.length
  ) return null;

  const start = (timeIndex * variableCount + variableIndex) * rows * cols;
  return data.subarray(start, start + rows * cols);
}

function findArray(objects, keys) {
  for (const obj of objects) {
    if (!obj || typeof obj !== "object") continue;
    for (const key of keys) {
      const value = obj[key];
      if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value);
    }
  }
  return null;
}

function extractCoordinates(weather, frame) {
  const sources = [weather, frame, weather?.grid, frame?.grid, weather?.metadata];
  const latitudes = findArray(sources, ["latitudes", "latitude", "lats", "lat"]);
  const longitudes = findArray(sources, ["longitudes", "longitude", "lons", "lon"]);

  if (!latitudes || !longitudes || latitudes.length < 2 || longitudes.length < 2) {
    console.error("[NFD] Missing grid coordinates. Expected latitude/longitude arrays.");
    return null;
  }

  const latOrder = latitudes.map((value, index) => ({ value: Number(value), index }))
    .filter(p => Number.isFinite(p.value))
    .sort((a, b) => b.value - a.value);

  const lonOrder = longitudes.map((value, index) => ({ value: Number(value), index }))
    .filter(p => Number.isFinite(p.value))
    .map(p => ({ ...p, value: ((p.value + 180) % 360 + 360) % 360 - 180 }))
    .sort((a, b) => a.value - b.value);

  if (latOrder.length < 2 || lonOrder.length < 2) return null;

  return {
    latitudes: latOrder.map(p => p.value),
    longitudes: lonOrder.map(p => p.value),
    latOrder: latOrder.map(p => p.index),
    lonOrder: lonOrder.map(p => p.index),
    rows: latOrder.length,
    cols: lonOrder.length,
  };
}

function reorderGrid(values, grid) {
  const { rows, cols, latOrder, lonOrder } = grid;
  if (!values || values.length !== rows * cols) {
    console.error("[NFD] Grid dimensions do not match field data", {
      expected: rows * cols,
      received: values?.length ?? 0,
    });
    return null;
  }

  const result = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      result[r * cols + c] = Number(values[latOrder[r] * cols + lonOrder[c]]);
    }
  }
  return result;
}

function mercatorMesh(grid) {
  const { rows, cols, latitudes, longitudes } = grid;
  const positions = new Float32Array(rows * cols * 4);
  const indices = new Uint32Array((rows - 1) * (cols - 1) * 6);
  let p = 0;
  let k = 0;

  for (let r = 0; r < rows; r++) {
    const y = mercatorY(latitudes[r]);
    for (let c = 0; c < cols; c++) {
      positions[p++] = mercatorX(longitudes[c]);
      positions[p++] = y;
      positions[p++] = c / (cols - 1);
      positions[p++] = r / (rows - 1);
    }
  }

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      indices.set([a, d, b, b, d, e], k);
      k += 6;
    }
  }
  return { positions, indices, count: indices.length };
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed: ${message}`);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program linking failed: ${message}`);
  }
  return program;
}

const WEATHER_VERTEX = `#version 300 es
precision highp float;
in vec2 a_pos;
in vec2 a_uv;
uniform mat4 u_matrix;
uniform float u_offset;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_matrix * vec4(a_pos.x + u_offset, a_pos.y, 0.0, 1.0);
}`;

// Cross-fades between two field textures (u_a -> u_b) on the GPU.
const WEATHER_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_lut;
uniform float u_mix;
uniform float u_alpha;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec4 a = texture(u_a, v_uv);
  vec4 b = texture(u_b, v_uv);
  if (a.a < 0.5 && b.a < 0.5) discard;
  float va = a.a > 0.5 ? a.r : b.r;
  float vb = b.a > 0.5 ? b.r : a.r;
  float t = clamp(mix(va, vb, u_mix), 0.0, 1.0);
  vec4 c = texture(u_lut, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
  float al = c.a * clamp(u_alpha, 0.0, 1.0);
  fragColor = vec4(c.rgb * al, al);
}`;

// Each particle is drawn as TRAIL_LENGTH fading points, which forms a streak.
const PARTICLE_VERTEX = `#version 300 es
precision highp float;
in vec2 a_pos;
in float a_fade;
uniform mat4 u_matrix;
uniform float u_offset;
uniform float u_size;
out float v_fade;
void main() {
  v_fade = a_fade;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
  gl_Position = u_matrix * vec4(a_pos.x + u_offset, a_pos.y, 0.0, 1.0);
  gl_PointSize = u_size * (0.3 + 0.7 * a_fade);
}`;

const PARTICLE_FRAGMENT = `#version 300 es
precision highp float;
in float v_fade;
out vec4 fragColor;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  float a = (1.0 - smoothstep(0.25, 0.5, d)) * v_fade * 0.1;
  if (a < 0.02) discard;
  fragColor = vec4(vec3(1.0) * a, a);
}`;

const TRAIL_LENGTH = 44;
const PARTICLE_SPEED = 450000; // visual speed-up, divided by 2^zoom so screen speed stays steady
const FADE_MS = 900;
const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function makeTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  return tex;
}

export default class WebGLWeatherLayer {
  constructor(options = {}) {
    this.id = options.id || "nfd-weather-webgl";
    this.type = "custom";
    this.renderingMode = "2d";
    this.alpha = options.alpha ?? 0.8;
    this.particleCount = options.particleCount ?? 5000;
    this.ready = false;
    this.map = null;
    this.gl = null;
    this.grid = null;
    this.mesh = null;
    this.want = { coords: null, frame: null, layer: "temperature" };
    this.applied = { coords: null, frame: null, layer: null };
    this.hasField = false;
    this.activeLayer = "temperature";
    this.mix = 0;
    this.transition = null;
    this.windA = null; // { u, v } for the visible frame
    this.windB = null; // { u, v } for the incoming frame
    this.showWind = false;
    this.lastTime = 0;
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    try {
      this.weatherProgram = createProgram(gl, WEATHER_VERTEX, WEATHER_FRAGMENT);
      this.particleProgram = createProgram(gl, PARTICLE_VERTEX, PARTICLE_FRAGMENT);
      const w = this.weatherProgram, p = this.particleProgram;
      this.wLoc = {
        matrix: gl.getUniformLocation(w, "u_matrix"), a: gl.getUniformLocation(w, "u_a"),
        b: gl.getUniformLocation(w, "u_b"), mix: gl.getUniformLocation(w, "u_mix"),
        alpha: gl.getUniformLocation(w, "u_alpha"), lut: gl.getUniformLocation(w, "u_lut"),
        pos: gl.getAttribLocation(w, "a_pos"), uv: gl.getAttribLocation(w, "a_uv"),
        offset: gl.getUniformLocation(w, "u_offset"),
      };
      this.pLoc = {
        matrix: gl.getUniformLocation(p, "u_matrix"), size: gl.getUniformLocation(p, "u_size"),
        pos: gl.getAttribLocation(p, "a_pos"), fade: gl.getAttribLocation(p, "a_fade"),
        offset: gl.getUniformLocation(p, "u_offset"),
      };
      this.positionBuffer = gl.createBuffer();
      this.indexBuffer = gl.createBuffer();
      this.particleBuffer = gl.createBuffer();
      this.fadeBuffer = gl.createBuffer();
      this.texA = makeTexture(gl);
      this.texB = makeTexture(gl);
      this.luts = {};
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      for (const name of Object.keys(COLOR_SCALES)) {
        const tex = makeTexture(gl);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildLut(COLOR_SCALES[name]));
        this.luts[name] = tex;
      }
      this.ready = true;
      this.sync();
    } catch (error) {
      this.ready = false;
      console.error("[NFD] WebGL layer initialization failed:", error);
    }
  }

  // coords: any payload with latitude/longitude arrays. frame: one frame object. layer: field name.
  update(coords, frame, layer, showWind) {
    this.want = { coords, frame, layer: normalizeFieldName(layer) };
    this.showWind = !!showWind;
    this.sync();
  }

  sync() {
    if (!this.ready) return;
    const { coords, frame, layer } = this.want;
    if (coords && coords !== this.applied.coords) {
      this.applied.coords = coords;
      this.grid = extractCoordinates(coords, null);
      this.mesh = this.grid ? mercatorMesh(this.grid) : null;
      this.uploadMesh();
      this.createParticles();
      this.hasField = false;
      this.applied.frame = null;
    }
    if (this.grid && frame && (frame !== this.applied.frame || layer !== this.applied.layer)) {
      const sameLayer = layer === this.applied.layer;
      this.applied.frame = frame;
      this.applied.layer = layer;
      this.loadField(frame, layer, sameLayer);
    }
    this.map?.triggerRepaint();
  }

  fieldValues(frame, name) {
    const config = FIELD_CONFIG[name];
    const binary = getBinaryField(frame, config.key)
      ?? (config.fallback ? getBinaryField(frame, config.fallback) : null);

    if (binary) {
      const grid = reorderGrid(binary, this.grid);
      if (!grid) return null;

      for (let i = 0; i < grid.length; i++) {
        grid[i] = Number.isFinite(grid[i]) ? config.convert(grid[i]) : NaN;
      }
      return grid;
    }

    let raw = frame[config.key] ?? (config.fallback ? frame[config.fallback] : undefined);

    if (name === "wind" && raw == null) {
      const u = flattenGrid(frame.u10);
      const v = flattenGrid(frame.v10);
      raw = u.map((x, i) => Math.hypot(Number(x), Number(v[i])));
    }

    const grid = reorderGrid(flattenGrid(raw), this.grid);
    if (!grid) return null;

    const out = new Float32Array(grid.length);
    for (let i = 0; i < grid.length; i++) {
      out[i] = Number.isFinite(grid[i]) ? config.convert(grid[i]) : NaN;
    }
    return out;
  }

  loadField(frame, name, animate = true) {
    const gl = this.gl;
    const values = this.fieldValues(frame, name);
    if (!values) return;
    const scale = COLOR_SCALES[name];
    const rgba = new Uint8Array(values.length * 4);
    for (let i = 0; i < values.length; i++) {
      if (!Number.isFinite(values[i])) continue;
      rgba[i * 4] = Math.round(encode(values[i], scale) * 255);
      rgba[i * 4 + 3] = 255;
    }
    if (this.transition) this.finishTransition(); // never stack transitions

    gl.bindTexture(gl.TEXTURE_2D, this.texB);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.grid.cols, this.grid.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);

    const u = getBinaryField(frame, "u10") ?? flattenGrid(frame.u10);
    const v = getBinaryField(frame, "v10") ?? flattenGrid(frame.v10);

    this.windB = u.length && u.length === v.length
      ? { u: reorderGrid(u, this.grid), v: reorderGrid(v, this.grid) } : null;

    this.activeLayer = name;
    if (!animate || !this.hasField) {
      this.finishTransition(); // first frame or layer switch: show immediately
      this.hasField = true;
    } else {
      this.transition = { start: performance.now() };
    }
  }

  finishTransition() {
    [this.texA, this.texB] = [this.texB, this.texA];
    this.windA = this.windB;
    this.mix = 0;
    this.transition = null;
  }

  uploadMesh() {
    const gl = this.gl;
    if (!this.mesh) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.indices, gl.STATIC_DRAW);
  }

  // ---- particles ----
  createParticles() {
    const n = this.particleCount;
    this.particles = Array.from({ length: n }, () => ({ x: 0, y: 0, age: 0, life: 0 }));
    this.trail = new Float32Array(n * TRAIL_LENGTH * 2);
    const fade = new Float32Array(n * TRAIL_LENGTH);
    for (let i = 0; i < n; i++) for (let k = 0; k < TRAIL_LENGTH; k++) fade[i * TRAIL_LENGTH + k] = 1 - k / TRAIL_LENGTH;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fadeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, fade, gl.STATIC_DRAW);
    this.particles.forEach((p, i) => this.respawn(p, i));
  }

  respawn(p, i) {
    // Spawn inside the visible area so particles are dense wherever the user looks.
    let x0 = 0, x1 = 1, y0 = 0.02, y1 = 0.98;
    if (this.map) {
      const b = this.map.getBounds();

      const span = b.getEast() - b.getWest();
      if (span < 360) {
        x0 = ((mercatorX(b.getWest()) % 1) + 1) % 1;
        x1 = x0 + span / 360; 
      }

      //const west = mercatorX(b.getWest()), east = mercatorX(b.getEast());
      //if (east > west) { x0 = Math.max(0, west); x1 = Math.min(1, east); }
      y0 = Math.max(0.001, mercatorY(b.getNorth()));
      y1 = Math.min(0.999, mercatorY(b.getSouth()));
    }
    p.x = (x0 + Math.random() * (x1 - x0)) % 1;
    p.y = y0 + Math.random() * (y1 - y0);
    p.age = 0;
    p.life = 80 + Math.random() * 120;
    const base = i * TRAIL_LENGTH * 2;
    for (let k = 0; k < TRAIL_LENGTH; k++) { this.trail[base + k * 2] = p.x; this.trail[base + k * 2 + 1] = p.y; }
  }

  sampleWind(x, y) {
    const w = this.windA;
    if (!this.grid || !w?.u || !w?.v) return null;
    const { rows, cols, latitudes, longitudes } = this.grid;
    const lon = x * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
    const dLat = (latitudes[0] - latitudes[rows - 1]) / (rows - 1);
    const dLon = (longitudes[cols - 1] - longitudes[0]) / (cols - 1);
    const row = Math.round((latitudes[0] - lat) / dLat);
    const col = Math.round((lon - longitudes[0]) / dLon);
    if (row < 0 || row >= rows || col < 0 || col >= cols) return null;
    const idx = row * cols + col;
    const m = this.mix, b = this.windB;
    let u = w.u[idx], v = w.v[idx];
    if (m > 0 && b?.u && b?.v) { u += (b.u[idx] - u) * m; v += (b.v[idx] - v) * m; }
    return Number.isFinite(u) && Number.isFinite(v) ? { u, v, lat } : null;
  }

  renderParticles(gl, matrix, dt) {
    if (!this.showWind || !this.particles?.length || !this.windA) return;
    const scale = PARTICLE_SPEED * Math.pow(2, -this.map.getZoom());
    const K = TRAIL_LENGTH * 2;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const wind = this.sampleWind(p.x, p.y);
      p.age++;
      if (!wind || p.age > p.life) { this.respawn(p, i); continue; }
      const cosLat = Math.max(0.15, Math.cos(wind.lat * Math.PI / 180));
      p.x = (p.x + wind.u * dt * scale / (EARTH_CIRCUMFERENCE * cosLat) + 1) % 1;
      p.y -= wind.v * dt * scale / (EARTH_CIRCUMFERENCE * cosLat);
      if (p.y < 0.001 || p.y > 0.999) { this.respawn(p, i); continue; }
      const base = i * K;
      this.trail.copyWithin(base + 2, base, base + K - 2);
      this.trail[base] = p.x;
      this.trail[base + 1] = p.y;
    }
    gl.useProgram(this.particleProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.trail, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.pLoc.pos);
    gl.vertexAttribPointer(this.pLoc.pos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fadeBuffer);
    gl.enableVertexAttribArray(this.pLoc.fade);
    gl.vertexAttribPointer(this.pLoc.fade, 1, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(this.pLoc.matrix, false, matrix);
    gl.uniform1f(this.pLoc.size, 3.4 * (window.devicePixelRatio || 1));
    for (let o = this.copyFirst; o <= this.copyLast; o++) {
      gl.uniform1f(this.pLoc.offset, o);
      gl.drawArrays(gl.POINTS, 0, this.particles.length * TRAIL_LENGTH);
    }
    gl.disableVertexAttribArray(this.pLoc.pos);
    gl.disableVertexAttribArray(this.pLoc.fade);
  }

  render(gl, args = {}) {
    // mainMatrix maps 0..1 Mercator coordinates to clip space in MapLibre.
    const matrix = args.defaultProjectionData?.mainMatrix;
    if (!this.ready || !this.mesh || !this.hasField || !matrix) return;

    if (this.transition) {
      const t = (performance.now() - this.transition.start) / FADE_MS;
      if (t >= 1) this.finishTransition(); else this.mix = ease(t);
    }

    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const loc = this.wLoc;
    gl.useProgram(this.weatherProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(loc.pos);
    gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(loc.uv);
    gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texB);
    gl.uniform1i(loc.a, 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.luts[this.activeLayer]);
    gl.uniform1i(loc.b, 1);
    gl.uniform1i(loc.lut, 2);
    gl.uniform1f(loc.mix, this.transition ? this.mix : 0);
    gl.uniform1f(loc.alpha, this.alpha);
    gl.uniformMatrix4fv(loc.matrix, false, matrix);
    const bnd = this.map.getBounds();
    this.copyFirst = Math.floor((bnd.getWest() + 180) / 360);
    this.copyLast = Math.floor((bnd.getEast() + 180) / 360);
    for (let o = this.copyFirst; o <= this.copyLast; o++) {
      gl.uniform1f(loc.offset, o);
      gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0);
    }
    gl.disableVertexAttribArray(loc.pos);
    gl.disableVertexAttribArray(loc.uv);
    gl.activeTexture(gl.TEXTURE0);

    const now = performance.now();
    const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, 0.05) : 1 / 60;
    this.lastTime = now;
    this.renderParticles(gl, matrix, dt);

    if (this.transition || (this.showWind && this.windA)) this.map?.triggerRepaint();
  }

  onRemove() {
    const gl = this.gl;
    if (gl) {
      [this.positionBuffer, this.indexBuffer, this.particleBuffer, this.fadeBuffer].forEach(b => b && gl.deleteBuffer(b));
      [this.texA, this.texB, ...Object.values(this.luts || {})].forEach(t => t && gl.deleteTexture(t));
      [this.weatherProgram, this.particleProgram].forEach(p => p && gl.deleteProgram(p));
    }
    this.map = this.gl = this.mesh = this.grid = null;
    this.ready = false;
  }
}