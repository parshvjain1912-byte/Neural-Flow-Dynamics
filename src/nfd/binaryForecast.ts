
export type NFDFrame = Record<string, Float32Array>;

export type NFDForecast = {
  metadata: {
    date: string;
    source?: string;
    variables: string[];
    shape: number[];
    times: string[];
    latitude: number[];
    longitude: number[];
    units?: Record<string, string>;
    dtype?: string;
    byte_order?: string;
    layout?: string;
    [key: string]: unknown;
  };
  coords: {
    latitude: number[];
    longitude: number[];
  };
  frames: NFDFrame[];
};

const EXPECTED_FORMAT = "nfd-f32-v1";
const MAX_HEADER_BYTES = 1024 * 1024;

function validateNumberArray(
  values: unknown,
  expectedLength: number,
  label: string,
): number[] {
  if (
    !Array.isArray(values) ||
    values.length !== expectedLength ||
    !values.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    throw new Error(`Invalid NFD metadata: ${label} is malformed.`);
  }

  return values;
}

export function decodeNFDForecast(buffer: ArrayBuffer): NFDForecast {
  if (buffer.byteLength < 8) {
    throw new Error("NFD forecast response is empty or incomplete.");
  }

  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);

  if (
    headerLength <= 0 ||
    headerLength > MAX_HEADER_BYTES ||
    4 + headerLength > buffer.byteLength
  ) {
    throw new Error("NFD forecast has an invalid binary header.");
  }

  let metadata: NFDForecast["metadata"];

  try {
    const headerBytes = new Uint8Array(buffer, 4, headerLength);
    metadata = JSON.parse(
      new TextDecoder().decode(headerBytes),
    ) as NFDForecast["metadata"];
  } catch {
    throw new Error("NFD forecast metadata is not valid JSON.");
  }

  const shape = metadata.shape;

  if (
    !Array.isArray(shape) ||
    shape.length !== 4 ||
    !shape.every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  ) {
    throw new Error("NFD metadata must contain four positive dimensions.");
  }

  const [timeCount, variableCount, rows, columns] = shape;
  const variables = metadata.variables;
  const times = metadata.times;

  if (
    !Array.isArray(variables) ||
    variables.length !== variableCount ||
    !variables.every((value) => typeof value === "string" && value.length > 0)
  ) {
    throw new Error("NFD metadata has invalid variable names.");
  }

  if (
    !Array.isArray(times) ||
    times.length !== timeCount ||
    !times.every((value) => typeof value === "string")
  ) {
    throw new Error("NFD metadata has invalid forecast timestamps.");
  }

  const latitude = validateNumberArray(
    metadata.latitude,
    rows,
    "latitude",
  );

  const longitude = validateNumberArray(
    metadata.longitude,
    columns,
    "longitude",
  );

  if (new Set(variables).size !== variables.length) {
    throw new Error("NFD metadata contains duplicate variable names.");
  }

  const headerEnd = 4 + headerLength;
  const dataOffset = Math.ceil(headerEnd / 4) * 4;
  const valueCount = timeCount * variableCount * rows * columns;
  const expectedBytes = dataOffset + valueCount * Float32Array.BYTES_PER_ELEMENT;

  if (!Number.isSafeInteger(expectedBytes) || expectedBytes !== buffer.byteLength) {
    throw new Error(
      `NFD forecast size mismatch: expected ${expectedBytes} bytes, received ${buffer.byteLength}.`,
    );
  }

  // The backend declares little-endian float32 values.
  if (metadata.byte_order && metadata.byte_order !== "little") {
    throw new Error(`Unsupported NFD byte order: ${metadata.byte_order}.`);
  }

  const raw = new Float32Array(valueCount);
  const littleEndian = new DataView(buffer, dataOffset);

  for (let i = 0; i < valueCount; i++) {
    raw[i] = littleEndian.getFloat32(i * 4, true);
  }

  const gridSize = rows * columns;
  const frames: NFDFrame[] = [];

  for (let t = 0; t < timeCount; t++) {
    const frame: NFDFrame = {};

    for (let v = 0; v < variableCount; v++) {
      const start = (t * variableCount + v) * gridSize;
      frame[variables[v]] = raw.slice(start, start + gridSize);
    }

    frames.push(frame);
  }

  return {
    metadata,
    coords: { latitude, longitude },
    frames,
  };
}

export async function fetchNFDForecast(
  date: string,
  signal?: AbortSignal,
): Promise<NFDForecast> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid NFD forecast date: ${date}.`);
  }

  const url = `/weather-api/weather-binary?date=${encodeURIComponent(date)}`;

  let response: Response;

  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }

    throw new Error(
      "Could not connect to the NFD backend. Check that the Python API is running on port 8000.",
    );
  }

  if (!response.ok) {
    let detail = "";

    try {
      const body = (await response.json()) as {
        detail?: string;
        error?: string;
      };

      detail = body.detail || body.error || "";
    } catch {
      // The server may return a non-JSON error page.
    }

    if (response.status === 404) {
      throw new Error(
        detail || `No NFD weather data is available for ${date}.`,
      );
    }

    if (response.status >= 500) {
      throw new Error(
        detail ||
        "The NFD backend failed to load its weather dataset. Check the Python terminal.",
      );
    }

    throw new Error(
      detail || `NFD forecast request failed with HTTP ${response.status}.`,
    );
  }

  const format = response.headers.get("X-Weather-Format");

  if (format && format !== EXPECTED_FORMAT) {
    throw new Error(`Unsupported NFD binary format: ${format}.`);
  }

  const buffer = await response.arrayBuffer();

  return decodeNFDForecast(buffer);
}

/**
 * Parse an NFD forecast timestamp into Unix milliseconds.
 *
 * Supports:
 * - ISO timestamps with an explicit timezone
 * - UTC timestamps such as 2026-10-21T06:00:00Z
 * - HH:MM or HH:MM:SS, interpreted as UTC on metadata.date
 */
export function parseNFDFrameTimestamp(
  date: string,
  time: string,
): number {
  const clockMatch = time.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);

  if (clockMatch) {
    const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (!dateMatch) return Number.NaN;

    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const hour = Number(clockMatch[1]);
    const minute = Number(clockMatch[2]);
    const second = Number(clockMatch[3] ?? "0");

    if (
      hour > 23 ||
      minute > 59 ||
      second > 59
    ) {
      return Number.NaN;
    }

    return Date.UTC(year, month - 1, day, hour, minute, second);
  }

  // ISO strings containing Z or an explicit UTC offset preserve
  // their absolute instant when parsed by JavaScript.
  const timestamp = Date.parse(time);

  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

/**
 * Find the nearest available NFD frame to a selected instant.
 *
 * selectedUtcMs must be an absolute timestamp in milliseconds.
 * The returned index is suitable for forecast.frames[index].
 */
export function findClosestNFDFrameIndex(
  forecast: NFDForecast,
  selectedUtcMs: number,
): number {
  const frameCount = Math.min(
    forecast.frames.length,
    forecast.metadata.times.length,
  );

  if (frameCount === 0) return -1;
  if (!Number.isFinite(selectedUtcMs)) return 0;

  let closestIndex = 0;
  let smallestDifference = Number.POSITIVE_INFINITY;

  for (let index = 0; index < frameCount; index += 1) {
    const timestamp = parseNFDFrameTimestamp(
      forecast.metadata.date,
      forecast.metadata.times[index],
    );

    if (!Number.isFinite(timestamp)) continue;

    const difference = Math.abs(timestamp - selectedUtcMs);

    if (difference < smallestDifference) {
      smallestDifference = difference;
      closestIndex = index;
    }
  }

  return Number.isFinite(smallestDifference) ? closestIndex : 0;
}