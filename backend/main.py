# command - python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000

from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
import json, struct, threading, time

import cfgrib
import numpy as np
import pandas as pd
import xarray as xr
from ecmwf.opendata import Client

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data" / "WeatherData(Sep-Oct2026).grib"
EXPECTED_TIMES = ["00:00", "06:00", "12:00", "18:00"]
VARIABLES = ["u10", "v10", "d2m", "t2m", "sp", "tp", "wind_speed"]
SOURCE_VARIABLES = VARIABLES[:-1]
# Raw SI units: the frontend converts them for display (see FIELD_CONFIG in WebGLWeatherLayer.jsx).
UNITS = {"u10": "m/s", "v10": "m/s", "d2m": "K", "t2m": "K", "sp": "Pa", "tp": "m", "wind_speed": "m/s"}

# ---------------- Forecast (ECMWF IFS open data) settings ----------------
FORECAST_DIR = BASE_DIR / "data" / "forecast"
FORECAST_MAX_STEP = 240                         # 00/12 UTC runs go to 360h, 06/18 only to 144h
FORECAST_STEPS = list(range(0, FORECAST_MAX_STEP + 1, 6))
FORECAST_PARAMS = ["10u", "10v", "2d", "2t", "sp", "tp"]
FORECAST_REFRESH_SECONDS = 1800
FORECAST_KEEP_RUNS = 2

_ecmwf_client = Client(source="ecmwf", model="ifs", resol="0p25")
_forecast_lock = threading.Lock()
_forecast_state = {"run": None, "checked": 0.0}


@asynccontextmanager
async def lifespan(app):
    # pre-warm the forecast so the first user doesn't wait for the download
    threading.Thread(target=_safe_warm, daemon=True).start()
    yield


def _safe_warm():
    try:
        ensure_latest_forecast()
    except Exception as exc:
        print(f"[forecast] warm-up failed: {exc}")


app = FastAPI(title="Neural Flow Dynamics API", description="Global ERA5 + ECMWF forecast weather data API for NFD.", version="0.3.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_credentials=False, allow_methods=["GET"], allow_headers=["*"])


# ======================= ERA5 (historical) =======================

@lru_cache(maxsize=1)
def load_dataset():
    if not DATA_FILE.is_file():
        raise FileNotFoundError(f"GRIB file not found: {DATA_FILE}")
    groups = cfgrib.open_datasets(str(DATA_FILE), backend_kwargs={"indexpath": ""})
    if not groups:
        raise RuntimeError("No readable GRIB groups found.")
    ds = xr.merge(groups, compat="override", join="outer")
    if "step" in ds.dims and ds.sizes["step"] == 1:
        ds = ds.squeeze("step", drop=True)
    if "valid_time" in ds.coords and ds["valid_time"].dims == ("time",):
        ds = ds.assign_coords(time=ds["valid_time"].values)
    if "time" not in ds.dims:
        raise RuntimeError("No time dimension found.")
    missing = [v for v in SOURCE_VARIABLES if v not in ds.data_vars]
    if missing:
        raise RuntimeError(f"Missing variables {missing}; found {list(ds.data_vars)}.")
    if "latitude" not in ds.coords or "longitude" not in ds.coords:
        raise RuntimeError("Latitude/longitude coordinates not found.")
    return ds.sortby("time")


def load_or_http_error():
    try:
        return load_dataset()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read GRIB dataset: {exc}.") from exc


def get_grid(ds, variable, timestamp):
    field = ds[variable].sel(time=timestamp)
    if "step" in field.dims:
        field = field.isel(step=0)
    values = np.asarray(field.squeeze(drop=True).transpose("latitude", "longitude").values, dtype=float)
    return values


def get_timestamps_for_date(ds, requested_date):
    timestamps = pd.to_datetime(ds.time.values, errors="coerce")
    day = pd.Timestamp(requested_date).strftime("%Y-%m-%d")
    return [t for t in timestamps if not pd.isna(t) and t.strftime("%Y-%m-%d") == day]


def get_frame_arrays(ds, timestamp):
    u10, v10 = get_grid(ds, "u10", timestamp), get_grid(ds, "v10", timestamp)
    return [u10, v10, get_grid(ds, "d2m", timestamp), get_grid(ds, "t2m", timestamp), get_grid(ds, "sp", timestamp), get_grid(ds, "tp", timestamp), np.hypot(u10, v10)]


def pack_binary(data, times, lat, lon, date_string, **extra):
    """Shared binary packer: [uint32 header_len][json header][pad to 4][float32 data]."""
    metadata = {
        "date": date_string, "source": "ERA5 reanalysis", "variables": VARIABLES,
        "units": UNITS, "times": times, "expected_times_utc": EXPECTED_TIMES,
        "shape": list(data.shape), "latitude": lat, "longitude": lon,
        "dtype": "float32", "byte_order": "little",
        "layout": "time,variable,latitude,longitude", **extra,
    }
    header = json.dumps(metadata, separators=(",", ":"), allow_nan=False).encode("utf-8")
    padding = b"\0" * (-(4 + len(header)) % 4)
    body = np.ascontiguousarray(np.asarray(data).astype("<f4", copy=False)).tobytes()
    return struct.pack("<I", len(header)) + header + padding + body


@lru_cache(maxsize=3)
def build_binary(date_string):
    ds = load_or_http_error()
    timestamps = get_timestamps_for_date(ds, date.fromisoformat(date_string))
    if not timestamps:
        raise HTTPException(status_code=404, detail=f"No weather data found for {date_string}. Check /api/available-dates.")
    data = np.stack([np.stack(get_frame_arrays(ds, t), axis=0) for t in timestamps])
    return pack_binary(data, [pd.Timestamp(t).strftime("%H:%M") for t in timestamps],
                       ds.latitude.values.tolist(), ds.longitude.values.tolist(), date_string,
                       kind="reanalysis")


FORECAST_CACHE_GLOB = "ifs_*_1deg_raw.npz"   # "_raw": SI units (K, Pa, m), same as the ERA5 file


def _forecast_npz(run):
    return FORECAST_DIR / f"ifs_{run}_1deg_raw.npz"


def _download_forecast(run_dt):
    FORECAST_DIR.mkdir(parents=True, exist_ok=True)
    run = run_dt.strftime("%Y%m%d%H")
    grib = FORECAST_DIR / f"ifs_{run}.grib2"
    _ecmwf_client.retrieve(
        date=run_dt.strftime("%Y-%m-%d"), time=run_dt.hour,
        type="fc", stream="oper", step=FORECAST_STEPS, param=FORECAST_PARAMS, target=str(grib),
    )
    groups = cfgrib.open_datasets(str(grib), backend_kwargs={"indexpath": ""})
    ds = xr.merge(
        [g.drop_vars(["heightAboveGround", "surface"], errors="ignore") for g in groups],
        compat="override", join="outer",
    )
    ds = ds.isel(latitude=slice(None, None, 4), longitude=slice(None, None, 4)).load()  # 0.25 deg -> 1 deg

    step_h = (ds.step.values / np.timedelta64(1, "h")).astype(int)
    g = lambda v: ds[v].transpose("step", "latitude", "longitude").values.astype("float32")

    # Keep the SAME raw units as the ERA5 file (K, Pa, m). The frontend (FIELD_CONFIG in
    # WebGLWeatherLayer.jsx) does the K->degC, Pa->hPa, m->mm conversion; converting here as
    # well made every forecast value fall off the colour scale (one flat colour).
    u10, v10 = g("u10"), g("v10")
    d2m, t2m = g("d2m"), g("t2m")                                              # Kelvin
    sp = g("sp")                                                               # Pascal
    acc = np.nan_to_num(g("tp"))                                               # metres, accumulated since step 0
    tp = np.clip(np.diff(acc, axis=0, prepend=acc[:1]), 0, None)               # metres per 6 h step
    data = np.stack([u10, v10, d2m, t2m, sp, tp, np.hypot(u10, v10)], axis=1).astype("<f4")
    lat = ds.latitude.values.astype(float)
    lon = ds.longitude.values.astype(float)

    # Match the grid conventions of the ERA5 file (lat order, lon range) so both sources line up.
    try:
        ref = load_dataset()
        ref_lat, ref_lon = ref.latitude.values, ref.longitude.values
        if ref_lon.min() < 0:
            lon = np.where(lon > 180, lon - 360, lon)
            order = np.argsort(lon)
            lon, data = lon[order], data[..., order]
        if (ref_lat[0] < ref_lat[-1]) != (lat[0] < lat[-1]):
            lat, data = lat[::-1], data[:, :, ::-1, :]
    except Exception as exc:
        print(f"[forecast] could not align grid with ERA5 ({exc}); keeping native ECMWF grid.")

    valid = np.array([(run_dt + timedelta(hours=int(h))).strftime("%Y-%m-%dT%H:%M") for h in step_h])
    np.savez_compressed(_forecast_npz(run), data=np.ascontiguousarray(data), valid=valid, latitude=lat, longitude=lon)

    grib.unlink(missing_ok=True)
    for f in FORECAST_DIR.glob("ifs_*.grib2.*"):   # stray index files
        f.unlink(missing_ok=True)


def _prune_forecasts():
    for old in sorted(FORECAST_DIR.glob(FORECAST_CACHE_GLOB))[:-FORECAST_KEEP_RUNS]:
        old.unlink(missing_ok=True)


def ensure_latest_forecast():
    """Return the latest cached run id (YYYYMMDDHH), downloading it if needed."""
    with _forecast_lock:
        if _forecast_state["run"] and time.time() - _forecast_state["checked"] < FORECAST_REFRESH_SECONDS:
            return _forecast_state["run"]
        try:
            # asking for the last step guarantees the run is complete (and 00/12 UTC only)
            run_dt = _ecmwf_client.latest(type="fc", stream="oper", step=FORECAST_MAX_STEP, param="2t")
            run = run_dt.strftime("%Y%m%d%H")
            if not _forecast_npz(run).exists():
                _download_forecast(run_dt)
                _prune_forecasts()
        except Exception:
            cached = sorted(FORECAST_DIR.glob(FORECAST_CACHE_GLOB))
            if not cached:
                raise
            run = cached[-1].stem.split("_")[1]      # fall back to last good run
        _forecast_state.update(run=run, checked=time.time())
        return run


@lru_cache(maxsize=2)
def load_forecast_run(run):
    p = _forecast_npz(run)
    if not p.is_file():
        raise FileNotFoundError(f"Forecast run {run} not cached.")
    z = np.load(p)
    return {"data": z["data"], "valid": z["valid"].tolist(),
            "latitude": z["latitude"].tolist(), "longitude": z["longitude"].tolist()}


def forecast_dates(run):
    return sorted({v[:10] for v in load_forecast_run(run)["valid"]})


def forecast_frames_for_date(run, date_string):
    r = load_forecast_run(run)
    idx = [i for i, v in enumerate(r["valid"]) if v.startswith(date_string)]
    if not idx:
        return None
    return {"times": [r["valid"][i][11:16] for i in idx], "data": np.ascontiguousarray(r["data"][idx]),
            "latitude": r["latitude"], "longitude": r["longitude"]}


@lru_cache(maxsize=4)
def build_forecast_binary(run, date_string):
    f = forecast_frames_for_date(run, date_string)
    if f is None:
        raise HTTPException(status_code=404, detail=f"Run {run} has no forecast for {date_string}. Check /api/available-dates.")
    return pack_binary(f["data"], f["times"], f["latitude"], f["longitude"], date_string,
                       source="ECMWF IFS open data (forecast)", kind="forecast", run=run, tp_period_hours=6)


def forecast_or_http_error(run=None):
    try:
        run = run or ensure_latest_forecast()
        load_forecast_run(run)
        return run
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Forecast unavailable: {exc}") from exc


# ======================= Routes =======================

@app.get("/")
def root():
    return {"project": "Neural Flow Dynamics", "message": "NFD Weather API is running.", "docs": "/docs"}


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/available-dates")
def available_dates():
    historical = []
    try:
        ds = load_dataset()
        historical = sorted({
            t.strftime("%Y-%m-%d")
            for t in pd.to_datetime(ds.time.values)
            if not pd.isna(t)
        })
    except Exception as exc:
        print(f"[ERA5] Historical data unavailable: {exc}")

    run = forecast_or_http_error()
    forecast = forecast_dates(run)
    return {
        "dates": sorted(set(historical) | set(forecast)),
        "historical_dates": historical,
        "forecast_dates": forecast,
        "forecast_run": run,
    }


@app.get("/api/weather-binary")
def get_weather_binary(requested_date: date = Query(..., alias="date")):
    date_string = requested_date.isoformat()

    try:
        body = build_binary(date_string)
        source = "era5"
    except HTTPException as exc:
        if exc.status_code != 500:
            raise
        run = forecast_or_http_error()
        body = build_forecast_binary(run, date_string)
        source = "ecmwf-forecast"

    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "public, max-age=900",
            "X-Weather-Format": "nfd-f32-v1",
            "X-Weather-Source": source,
        },
    )


@app.get("/api/forecast-binary")
def get_forecast_binary(requested_date: date = Query(..., alias="date"),
                        run: str = Query(None, regex=r"^\d{10}$")):
    run = forecast_or_http_error(run)
    body = build_forecast_binary(run, requested_date.isoformat())
    return Response(content=body, media_type="application/octet-stream",
                    headers={"Cache-Control": "public, max-age=900", "X-Weather-Format": "nfd-f32-v1",
                             "X-Forecast-Run": run})
