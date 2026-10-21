export default function Chart({
  values,
  color = "#42d9c0",
  suffix = ""
}: {
  values: number[];
  color?: string;
  suffix?: string;
}) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(1, max - min);

  const points = values.map((v, i) =>
    `${values.length < 2 ? 0 : i / (values.length - 1) * 300},${85 - (v - min) / span * 65}`
  ).join(" ");

  return (
    <div className="chart-wrap">
      <svg viewBox="0 0 300 100" role="img" aria-label="Forecast trend chart">
        <defs>
          <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity=".25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {[20, 42, 64, 86].map(y => (
          <line
            key={y}
            x1="0"
            x2="300"
            y1={y}
            y2={y}
            stroke="currentColor"
            opacity=".08"
          />
        ))}

        <polygon points={`0,100 ${points} 300,100`} fill="url(#chart-fill)" />

        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {values.map((v, i) => {
          const x = values.length < 2 ? 0 : i / (values.length - 1) * 300;
          const y = 85 - (v - min) / span * 65;

          return (
            <circle key={i} cx={x} cy={y} r="2.6" fill={color}>
              <title>{Math.round(v)}{suffix}</title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}
