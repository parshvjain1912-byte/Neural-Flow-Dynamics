export type NFDFrame = Record<string, Float32Array>;

export type NFDForecast = {
  metadata: {
    variables: string[];
    shape: number[];
    times: string[];
    latitude: number[];
    longitude: number[];
    [key: string]: unknown;
  };
  coords: {
    latitude: number[];
    longitude: number[];
  };
  frames: NFDFrame[];
};

export function decodeNFDForecast(buffer: ArrayBuffer): NFDForecast {
  if (buffer.byteLength < 8) {
    throw new Error("NFD binary response is too small.");
  }

  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  const headerEnd = 4 + headerLength;

  if (headerLength <= 0 || headerEnd > buffer.byteLength) {
    throw new Error("Invalid NFD binary header.");
  }

  const metadata = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)),
  ) as NFDForecast["metadata"];

  const [timeCount, variableCount, rows, columns] = metadata.shape;
  const { variables, times, latitude, longitude } = metadata;

  if (
    !Array.isArray(metadata.shape) ||
    metadata.shape.length !== 4 ||
    !Array.isArray(variables) ||
    !Array.isArray(times) ||
    !Array.isArray(latitude) ||
    !Array.isArray(longitude) ||
    variables.length !== variableCount ||
    times.length !== timeCount ||
    latitude.length !== rows ||
    longitude.length !== columns
  ) {
    throw new Error("NFD metadata dimensions are invalid.");
  }

  const offset = (headerEnd + 3) & ~3;
  const count = timeCount * variableCount * rows * columns;
  const expectedEnd = offset + count * 4;

  if (expectedEnd !== buffer.byteLength) {
    throw new Error(
      `NFD payload size mismatch: expected ${expectedEnd} bytes, got ${buffer.byteLength}.`,
    );
  }

  const raw = new Float32Array(buffer.slice(offset));
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
  const response = await fetch(
    `/weather-api/weather-binary?date=${encodeURIComponent(date)}`,
    { signal },
  );

  if (!response.ok) {
    throw new Error(`NFD forecast request failed (${response.status}).`);
  }

  const format = response.headers.get("X-Weather-Format");

  if (format && format !== "nfd-f32-v1") {
    throw new Error(`Unsupported NFD binary format: ${format}`);
  }

  return decodeNFDForecast(await response.arrayBuffer());
}
