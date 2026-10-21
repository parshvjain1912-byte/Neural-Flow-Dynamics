import type { ReactNode } from "react";

export default function Metric({
  icon,
  title,
  value,
  detail
}: {
  icon: ReactNode;
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-title">
        {icon}
        <small>{title}</small>
      </div>
      <b className="metric-value">{value}</b>
      <span>{detail}</span>
    </div>
  );
}
