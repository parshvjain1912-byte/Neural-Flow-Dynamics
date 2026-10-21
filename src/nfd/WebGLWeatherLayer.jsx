
import { COLOR_SCALES, buildLut, encode } from "./Colorscales";

const EARTH_CIRCUMFERENCE = 40075016.686;
const TRAIL_LENGTH = 36;
const PARTICLE_SPEED = 450000;
const FADE_MS = 800;

const FIELD_CONFIG = {
  temperature: { key: "t2m", convert: (v) => v - 273.15 },
  wind: { key: "wind_speed", convert: (v) => v },
  pressure: { key: "sp", convert: (v) => v / 100 },
  rainfall: { key: "tp", convert: (v) => v * 1000 },
};

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const ease = (t) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

function mercatorX(lon) {
  return (lon + 180) / 360;
}

function mercatorY(lat) {
  const r = clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(r)) / Math.PI) / 2;
}

function extractCoordinates(coords) {
  const latitude = coords?.latitude;
  const longitude = coords?.longitude;

  if (!latitude || !longitude || latitude.length < 2 || longitude.length < 2) {
    console.error("[NFD] Forecast has no usable latitude/longitude grid.");
    return null;
  }

  const latOrder = Array.from(latitude)
    .map((value, index) => ({ value: Number(value), index }))
    .filter((p) => Number.isFinite(p.value))
    .sort((a, b) => b.value - a.value);

  const lonOrder = Array.from(longitude)
    .map((value, index) => {
      const lon = Number(value);
      return {
        value: ((lon + 180) % 360 + 360) % 360 - 180,
        index,
      };
    })
    .filter((p) => Number.isFinite(p.value))
    .sort((a, b) => a.value - b.value);

  if (latOrder.length < 2 || lonOrder.length < 2) return null;

  return {
    latitudes: latOrder.map((p) => p.value),
    longitudes: lonOrder.map((p) => p.value),
    latOrder: latOrder.map((p) => p.index),
    lonOrder: lonOrder.map((p) => p.index),
    rows: latOrder.length,
    cols: lonOrder.length,
  };
}

function reorderGrid(values, grid) {
  if (!values || !grid) return null;

  const { rows, cols, latOrder, lonOrder } = grid;

  if (values.length !== rows * cols) {
    console.error("[NFD] Forecast grid dimensions do not match.", {
      expected: rows * cols,
      received: values.length,
    });
    return null;
  }

  const result = new Float32Array(rows * cols);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      result[r * cols + c] =
        Number(values[latOrder[r] * cols + lonOrder[c]]);
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

  if (!shader) throw new Error("Could not create WebGL shader.");

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

  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error("Could not create WebGL program.");
  }

  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`WebGL program linking failed: ${message}`);
  }

  return program;
}

function makeTexture(gl) {
  const texture = gl.createTexture();

  if (!texture) throw new Error("Could not create WebGL texture.");

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0])
  );

  return texture;
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
  float value = clamp(mix(va, vb, u_mix), 0.0, 1.0);

  vec4 color = texture(
    u_lut,
    vec2(value * (255.0 / 256.0) + 0.5 / 256.0, 0.5)
  );

  float alpha = color.a * clamp(u_alpha, 0.0, 1.0);
  fragColor = vec4(color.rgb * alpha, alpha);
}`;

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
  gl_Position = u_matrix * vec4(a_pos.x + u_offset, a_pos.y, 0.0, 1.0);
  gl_PointSize = u_size * (0.35 + 0.65 * a_fade);
}`;

const PARTICLE_FRAGMENT = `#version 300 es
precision highp float;

in float v_fade;
out vec4 fragColor;

void main() {
  float distanceFromCenter = length(gl_PointCoord - vec2(0.5));
  float glow = 1.0 - smoothstep(0.05, 0.5, distanceFromCenter);
  float alpha = glow * (0.12 + 0.78 * v_fade);

  if (alpha < 0.025) discard;

  vec3 cyan = vec3(0.04, 0.72, 1.0);
  fragColor = vec4(cyan * alpha, alpha);
}`;

export default class WebGLWeatherLayer {
  constructor(options = {}) {
    this.id = options.id || "nfd-weather-webgl";
    this.type = "custom";
    this.renderingMode = "2d";

    this.alpha = options.alpha ?? 0.82;
    this.particleCount = options.particleCount ?? 5000;

    this.ready = false;
    this.enabled = true;
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

    this.windA = null;
    this.windB = null;
    this.showWind = false;
    this.lastTime = 0;

    this.copyFirst = 0;
    this.copyLast = 0;
    this.particles = [];
    this.trail = new Float32Array(0);
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;

    try {
      this.weatherProgram = createProgram(gl, WEATHER_VERTEX, WEATHER_FRAGMENT);
      this.particleProgram = createProgram(gl, PARTICLE_VERTEX, PARTICLE_FRAGMENT);

      const w = this.weatherProgram;
      const p = this.particleProgram;

      this.wLoc = {
        matrix: gl.getUniformLocation(w, "u_matrix"),
        a: gl.getUniformLocation(w, "u_a"),
        b: gl.getUniformLocation(w, "u_b"),
        mix: gl.getUniformLocation(w, "u_mix"),
        alpha: gl.getUniformLocation(w, "u_alpha"),
        lut: gl.getUniformLocation(w, "u_lut"),
        pos: gl.getAttribLocation(w, "a_pos"),
        uv: gl.getAttribLocation(w, "a_uv"),
        offset: gl.getUniformLocation(w, "u_offset"),
      };

      this.pLoc = {
        matrix: gl.getUniformLocation(p, "u_matrix"),
        size: gl.getUniformLocation(p, "u_size"),
        pos: gl.getAttribLocation(p, "a_pos"),
        fade: gl.getAttribLocation(p, "a_fade"),
        offset: gl.getUniformLocation(p, "u_offset"),
      };

      this.positionBuffer = gl.createBuffer();
      this.indexBuffer = gl.createBuffer();
      this.particleBuffer = gl.createBuffer();
      this.fadeBuffer = gl.createBuffer();

      if (
        !this.positionBuffer ||
        !this.indexBuffer ||
        !this.particleBuffer ||
        !this.fadeBuffer
      ) {
        throw new Error("Could not allocate WebGL buffers.");
      }

      this.texA = makeTexture(gl);
      this.texB = makeTexture(gl);
      this.luts = {};

      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

      for (const name of Object.keys(COLOR_SCALES)) {
        const texture = makeTexture(gl);
        gl.bindTexture(gl.TEXTURE_2D, texture);

        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          256,
          1,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          buildLut(COLOR_SCALES[name])
        );

        this.luts[name] = texture;
      }

      this.ready = true;
      this.sync();
    } catch (error) {
      this.ready = false;
      console.error("[NFD] Weather renderer initialization failed:", error);
    }
  }

  update(coords, frame, layer, showWind) {
    this.want = { coords, frame, layer };
    this.showWind = Boolean(showWind);
    this.sync();
    this.map?.triggerRepaint();
  }

  sync() {
    if (!this.ready) return;

    const { coords, frame, layer } = this.want;

    if (coords && coords !== this.applied.coords) {
      this.grid = extractCoordinates(coords);
      this.mesh = this.grid ? mercatorMesh(this.grid) : null;

      this.applied.coords = coords;
      this.applied.frame = null;
      this.hasField = false;

      if (this.mesh) {
        this.uploadMesh();
        this.createParticles();
      }
    }

    if (!this.grid || !frame || !FIELD_CONFIG[layer]) {
      this.map?.triggerRepaint();
      return;
    }

    if (frame !== this.applied.frame || layer !== this.applied.layer) {
      const sameLayer = layer === this.applied.layer;
      this.applied.frame = frame;
      this.applied.layer = layer;
      this.loadField(frame, layer, sameLayer);
    }

    this.map?.triggerRepaint();
  }

  fieldValues(frame, name) {
    const config = FIELD_CONFIG[name];
    const raw = frame?.[config.key];
    const values = reorderGrid(raw, this.grid);

    if (!values) return null;

    for (let i = 0; i < values.length; i++) {
      values[i] = Number.isFinite(values[i])
        ? config.convert(values[i])
        : NaN;
    }

    return values;
  }

  loadField(frame, name, animate = true) {
    const gl = this.gl;
    const values = this.fieldValues(frame, name);
    const scale = COLOR_SCALES[name];

    if (!values || !scale) {
      console.error(`[NFD] Could not load the "${name}" weather field.`);
      return;
    }

    const rgba = new Uint8Array(values.length * 4);

    for (let i = 0; i < values.length; i++) {
      if (!Number.isFinite(values[i])) continue;

      rgba[i * 4] = Math.round(encode(values[i], scale) * 255);
      rgba[i * 4 + 3] = 255;
    }

    if (this.transition) this.finishTransition();

    gl.bindTexture(gl.TEXTURE_2D, this.texB);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      this.grid.cols,
      this.grid.rows,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba
    );

    const windU = frame.u10 ? reorderGrid(frame.u10, this.grid) : null;
    const windV = frame.v10 ? reorderGrid(frame.v10, this.grid) : null;

    this.windB =
      windU && windV ? { u: windU, v: windV } : null;

    if (name === "wind" && !this.windB) {
      console.error(
        "[NFD] Wind layer selected, but valid u10/v10 wind vectors are missing."
      );
    }

    this.activeLayer = name;

    if (!animate || !this.hasField) {
      this.finishTransition();
      this.hasField = true;
    } else {
      this.transition = { start: performance.now() };
    }
  }

  finishTransition() {
    if (this.gl && this.texA && this.texB) {
      [this.texA, this.texB] = [this.texB, this.texA];
    }

    this.windA = this.windB;
    this.mix = 0;
    this.transition = null;
  }

  uploadMesh() {
    if (!this.gl || !this.mesh) return;

    const gl = this.gl;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.positions, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.indices, gl.STATIC_DRAW);
  }

  createParticles() {
    const n = this.particleCount;

    this.particles = Array.from({ length: n }, () => ({
      x: 0,
      y: 0,
      age: 0,
      life: 0,
    }));

    this.trail = new Float32Array(n * TRAIL_LENGTH * 2);

    const fade = new Float32Array(n * TRAIL_LENGTH);

    for (let i = 0; i < n; i++) {
      for (let k = 0; k < TRAIL_LENGTH; k++) {
        fade[i * TRAIL_LENGTH + k] = 1 - k / TRAIL_LENGTH;
      }
    }

    if (!this.gl || !this.fadeBuffer) return;

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.fadeBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, fade, this.gl.STATIC_DRAW);

    this.particles.forEach((particle, index) => this.respawn(particle, index));
  }

  respawn(particle, index) {
    let x0 = 0;
    let x1 = 1;
    let y0 = 0.02;
    let y1 = 0.98;

    if (this.map) {
      const bounds = this.map.getBounds();
      const span = bounds.getEast() - bounds.getWest();

      if (span > 0 && span < 360) {
        x0 = ((mercatorX(bounds.getWest()) % 1) + 1) % 1;
        x1 = x0 + span / 360;
      }

      y0 = Math.max(0.001, mercatorY(bounds.getNorth()));
      y1 = Math.min(0.999, mercatorY(bounds.getSouth()));
    }

    particle.x = (x0 + Math.random() * (x1 - x0)) % 1;
    particle.y = y0 + Math.random() * Math.max(0.001, y1 - y0);
    particle.age = 0;
    particle.life = 90 + Math.random() * 130;

    const base = index * TRAIL_LENGTH * 2;

    for (let k = 0; k < TRAIL_LENGTH; k++) {
      this.trail[base + k * 2] = particle.x;
      this.trail[base + k * 2 + 1] = particle.y;
    }
  }

  sampleWind(x, y) {
    const wind = this.windA;
    const grid = this.grid;

    if (!grid || !wind?.u || !wind?.v) return null;

    const { rows, cols, latitudes, longitudes } = grid;
    const lon = x * 360 - 180;
    const lat =
      Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;

    const dLat = (latitudes[0] - latitudes[rows - 1]) / (rows - 1);
    const dLon = (longitudes[cols - 1] - longitudes[0]) / (cols - 1);

    if (!Number.isFinite(dLat) || !Number.isFinite(dLon) || dLat === 0 || dLon === 0) {
      return null;
    }

    const row = Math.round((latitudes[0] - lat) / dLat);
    const col = Math.round((lon - longitudes[0]) / dLon);

    if (row < 0 || row >= rows || col < 0 || col >= cols) return null;

    const index = row * cols + col;

    let u = wind.u[index];
    let v = wind.v[index];

    const incoming = this.windB;

    if (
      this.transition &&
      incoming?.u &&
      incoming?.v &&
      Number.isFinite(incoming.u[index]) &&
      Number.isFinite(incoming.v[index])
    ) {
      u += (incoming.u[index] - u) * this.mix;
      v += (incoming.v[index] - v) * this.mix;
    }

    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;

    return { u, v, lat };
  }

  renderParticles(gl, matrix, dt) {
    if (
      !this.showWind ||
      !this.particles.length ||
      !this.windA?.u ||
      !this.windA?.v
    ) {
      return;
    }

    const zoom = this.map?.getZoom() ?? 4;
    const scale = PARTICLE_SPEED * Math.pow(2, -zoom);
    const stride = TRAIL_LENGTH * 2;

    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i];
      const wind = this.sampleWind(particle.x, particle.y);

      particle.age++;

      if (!wind || particle.age > particle.life) {
        this.respawn(particle, i);
        continue;
      }

      const cosLat = Math.max(
        0.15,
        Math.cos(wind.lat * Math.PI / 180)
      );

      particle.x =
        (particle.x + wind.u * dt * scale / (EARTH_CIRCUMFERENCE * cosLat) + 1) % 1;

      particle.y -=
        wind.v * dt * scale / (EARTH_CIRCUMFERENCE * cosLat);

      if (
        !Number.isFinite(particle.x) ||
        !Number.isFinite(particle.y) ||
        particle.y < 0.001 ||
        particle.y > 0.999
      ) {
        this.respawn(particle, i);
        continue;
      }

      const base = i * stride;

      this.trail.copyWithin(base + 2, base, base + stride - 2);
      this.trail[base] = particle.x;
      this.trail[base + 1] = particle.y;
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

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    gl.uniform1f(this.pLoc.size, 3.6 * Math.min(dpr, 2));

    for (let offset = this.copyFirst; offset <= this.copyLast; offset++) {
      gl.uniform1f(this.pLoc.offset, offset);
      gl.drawArrays(gl.POINTS, 0, this.particles.length * TRAIL_LENGTH);
    }

    gl.disableVertexAttribArray(this.pLoc.pos);
    gl.disableVertexAttribArray(this.pLoc.fade);
  }

  render(gl, args = {}) {
    const matrix = args.defaultProjectionData?.mainMatrix;

    if (
      !this.enabled ||
      !this.ready ||
      !this.mesh ||
      !this.hasField ||
      !matrix
    ) {
      return;
    }

    if (this.transition) {
      const t = (performance.now() - this.transition.start) / FADE_MS;

      if (t >= 1) {
        this.finishTransition();
      } else {
        this.mix = ease(t);
      }
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
    gl.uniform1i(loc.a, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texB);
    gl.uniform1i(loc.b, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.luts[this.activeLayer]);
    gl.uniform1i(loc.lut, 2);

    gl.uniform1f(loc.mix, this.transition ? this.mix : 0);
    gl.uniform1f(loc.alpha, this.alpha);
    gl.uniformMatrix4fv(loc.matrix, false, matrix);

    const bounds = this.map.getBounds();

    this.copyFirst = Math.floor((bounds.getWest() + 180) / 360);
    this.copyLast = Math.floor((bounds.getEast() + 180) / 360);

    for (let offset = this.copyFirst; offset <= this.copyLast; offset++) {
      gl.uniform1f(loc.offset, offset);
      gl.drawElements(
        gl.TRIANGLES,
        this.mesh.count,
        gl.UNSIGNED_INT,
        0
      );
    }

    gl.disableVertexAttribArray(loc.pos);
    gl.disableVertexAttribArray(loc.uv);
    gl.activeTexture(gl.TEXTURE0);

    const now = performance.now();
    const dt = this.lastTime
      ? clamp((now - this.lastTime) / 1000, 0, 0.05)
      : 1 / 60;

    this.lastTime = now;

    this.renderParticles(gl, matrix, dt);

    if (
      this.transition ||
      (this.showWind && this.windA?.u && this.windA?.v)
    ) {
      this.map?.triggerRepaint();
    }
  }

  onRemove() {
    const gl = this.gl;

    if (gl) {
      [
        this.positionBuffer,
        this.indexBuffer,
        this.particleBuffer,
        this.fadeBuffer,
      ].forEach((buffer) => {
        if (buffer) gl.deleteBuffer(buffer);
      });

      [
        this.texA,
        this.texB,
        ...Object.values(this.luts || {}),
      ].forEach((texture) => {
        if (texture) gl.deleteTexture(texture);
      });

      [this.weatherProgram, this.particleProgram].forEach((program) => {
        if (program) gl.deleteProgram(program);
      });
    }

    this.map = null;
    this.gl = null;
    this.mesh = null;
    this.grid = null;
    this.particles = [];
    this.trail = new Float32Array(0);
    this.ready = false;
    this.lastTime = 0;
  }
}
