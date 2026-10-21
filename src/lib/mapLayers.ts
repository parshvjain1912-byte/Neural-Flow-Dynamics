export type MapLayer = "temperature" | "wind" | "pressure" | "rainfall";

export const MAP_LAYERS: { id: MapLayer; label: string }[] = [
  { id: "temperature", label: "Temp" },
  { id: "wind", label: "Wind" },
  { id: "pressure", label: "Pressure" },
  { id: "rainfall", label: "Rain" },
];
