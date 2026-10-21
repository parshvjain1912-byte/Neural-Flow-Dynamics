
const LEGENDS = {
  t2m: { title: "Temperature", unit: "°C", min: -40, max: 45, labels: ["-40", "-20", "0", "20", "45"], gradient: "linear-gradient(90deg,#313695,#4575b4,#abd9e9,#ffffbf,#fdae61,#f46d43,#a50026)" },
  d2m: { title: "Dew point", unit: "°C", min: -40, max: 35, labels: ["-40", "-20", "0", "15", "35"], gradient: "linear-gradient(90deg,#313695,#74add1,#ffffbf,#fdae61,#a50026)" },
  sp: { title: "Surface pressure", unit: "hPa", min: 950, max: 1050, labels: ["950", "975", "1000", "1025", "1050"], gradient: "linear-gradient(90deg,#542788,#998ec3,#f7f7f7,#7fbf7b,#1b7837)" },
  tp: { title: "Precipitation", unit: "mm", min: 0, max: 25, labels: ["0", "5", "10", "15", "25+"], gradient: "linear-gradient(90deg,#f7fbff,#c6dbef,#6baed6,#2171b5,#6a51a3,#d01c8b)" },
  wind_speed: { title: "Wind speed", unit: "m/s", min: 0, max: 35, labels: ["0", "7", "14", "21", "35+"], gradient: "linear-gradient(90deg,#f7fcf0,#ccebc5,#7bccc4,#2b8cbe,#8856a7,#810f7c)" },
};

export default function WeatherLegend({ layer }) {
  const item = LEGENDS[layer] || LEGENDS.t2m;

  return (
    <div className="weather-legend">
      <div className="legend-heading">
        <strong>{item.title}</strong>
        <span>{item.unit}</span>
      </div>
      <div className="legend-gradient" style={{ background: item.gradient }} />
      <div className="legend-labels">
        {item.labels.map((label) => <span key={label}>{label}</span>)}
      </div>
    </div>
  );
}
