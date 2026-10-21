// Type stubs for the JavaScript map modules that live in /frontend (the standalone map app).
declare module "*/frontend/src/WebGLWeatherLayer.jsx" {
  import type { CustomLayerInterface } from "maplibre-gl";

  export default class WebGLWeatherLayer implements CustomLayerInterface {
    constructor(options?: { id?: string; alpha?: number; particleCount?: number });
    id: string;
    type: "custom";
    renderingMode: "2d" | "3d";
    onAdd(map: unknown, gl: WebGLRenderingContext | WebGL2RenderingContext): void;
    render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: unknown): void;
    update(
      coords: { latitude: ArrayLike<number>; longitude: ArrayLike<number> } | null,
      frame: Record<string, Float32Array> | null,
      layer: string,
      showWind: boolean
    ): void;
  }
}

declare module "*/frontend/src/Colorscales.js" {
  export type ColorScale = {
    min: number;
    max: number;
    gamma: number;
    unit: string;
    ticks: number[];
    stops: (readonly [number, string] | readonly [number, string, number])[];
  };
  export const COLOR_SCALES: Record<string, ColorScale>;
  export function encode(value: number, scale: ColorScale): number;
  export function legendGradient(scale: ColorScale): string;
}
