
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";

type AdvisoryResult = {
    title: string;
    source: string;
    url: string;
    snippet: string;
    position: number;
};

type AdvisoryResponse = {
    provider: string;
    query: string;
    retrievedAt: string;
    count: number;
    results: AdvisoryResult[];
};

type Props = {
    location: string;
};

export default function TinyFishAdvisories({ location }: Props) {
    const [data, setData] = useState<AdvisoryResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const loadAdvisories = useCallback(async (signal?: AbortSignal) => {
        setLoading(true);
        setError("");

        try {
            const query =
                `official weather warnings IMD ${location} India`;

            const params = new URLSearchParams({ query });

            const response = await fetch(
                `/api/advisories?${params.toString()}`,
                { signal }
            );

            const result = await response.json();

            if (!response.ok) {
                throw new Error(
                    result.error || "Unable to retrieve weather search results."
                );
            }

            if (!Array.isArray(result.results)) {
                throw new Error("TinyFish returned an unexpected response.");
            }

            setData(result as AdvisoryResponse);
        } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
                return;
            }

            setError(
                err instanceof Error
                    ? err.message
                    : "Unable to retrieve weather search results."
            );
        } finally {
            if (!signal?.aborted) {
                setLoading(false);
            }
        }
    }, [location]);

    useEffect(() => {
        const controller = new AbortController();

        void loadAdvisories(controller.signal);

        return () => controller.abort();
    }, [loadAdvisories]);

    const formatRetrievedAt = (value: string) => {
        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return "Time unavailable";
        }

        return date.toLocaleString("en-IN", {
            dateStyle: "medium",
            timeStyle: "short"
        });
    };

    return (
        <section className="panel wide-panel">
            <div className="panel-heading">
                <div>
                    <div className="eyebrow">TINYFISH · LIVE SEARCH</div>
                    <h2>Official weather sources</h2>
                    <p className="muted">
                        Weather-warning search results for {location}.
                    </p>
                </div>

                <button
                    type="button"
                    className="button secondary small"
                    onClick={() => void loadAdvisories()}
                    disabled={loading}
                    aria-label="Refresh weather search results"
                >
                    <RefreshCw
                        size={14}
                        className={loading ? "spin" : ""}
                    />
                    {loading ? "Searching…" : "Refresh"}
                </button>
            </div>

            <div
                style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: 12,
                    marginBottom: 16,
                    borderRadius: 10,
                    background: "rgba(66, 217, 192, 0.08)"
                }}
            >
                <ShieldCheck size={18} style={{ flexShrink: 0 }} />

                <p className="muted tiny" style={{ margin: 0 }}>
                    Powered by TinyFish Search. These are search results, not
                    independently verified active warnings. Open the original
                    official source to confirm current alerts.
                </p>
            </div>

            {loading && !data && (
                <div className="muted" role="status">
                    <RefreshCw
                        size={16}
                        className="spin"
                        style={{ verticalAlign: "middle", marginRight: 8 }}
                    />
                    Searching weather sources…
                </div>
            )}

            {error && (
                <div className="alert-card medium" role="alert">
                    <div className="alert-symbol">
                        <AlertTriangle size={20} />
                    </div>

                    <div>
                        <b>Search unavailable</b>
                        <p>{error}</p>
                        <small>
                            Check that the TinyFish backend is running and try again.
                        </small>
                    </div>
                </div>
            )}

            {data && (
                <>
                    <div className="setting-row">
                        <span>
                            Search results
                            <small>{data.provider}</small>
                        </span>
                        <b>{data.count}</b>
                    </div>

                    <p className="muted tiny">
                        Retrieved: {formatRetrievedAt(data.retrievedAt)}
                    </p>

                    {data.results.length === 0 && (
                        <p className="muted">
                            No results were returned. Try refreshing later.
                        </p>
                    )}

                    {data.results.map((item, index) => {
                        let safeUrl: URL | null = null;

                        try {
                            safeUrl = new URL(item.url);

                            if (safeUrl.protocol !== "https:" &&
                                safeUrl.protocol !== "http:") {
                                safeUrl = null;
                            }
                        } catch {
                            safeUrl = null;
                        }

                        return (
                            <article
                                className="alert-card low"
                                key={`${item.url}-${index}`}
                                style={{ alignItems: "flex-start" }}
                            >
                                <div className="alert-symbol">
                                    <ShieldCheck size={19} />
                                </div>

                                <div style={{ minWidth: 0, flex: 1 }}>
                                    <b>{item.title}</b>

                                    {item.source && (
                                        <p className="muted tiny">
                                            Source: {item.source}
                                        </p>
                                    )}

                                    <p>{item.snippet || "No search summary available."}</p>

                                    {safeUrl && (
                                        <a
                                            href={safeUrl.toString()}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: 6,
                                                marginTop: 6
                                            }}
                                        >
                                            Open source <ExternalLink size={13} />
                                        </a>
                                    )}
                                </div>
                            </article>
                        );
                    })}
                </>
            )}
        </section>
    );
}
