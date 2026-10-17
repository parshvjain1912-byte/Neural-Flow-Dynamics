# command - python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000

from datetime import date
from functools import lru_cache
from pathlib import Path
import json, struct

import cfgrib
import numpy as np
import pandas as pd
import xarray as xr

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, Response

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data" / "WeatherData(Sep-Oct2026).grib"
EXPECTED_TIMES = ["00:00", "06:00", "12:00", "18:00"]
VARIABLES = ["u10", "v10", "d2m", "t2m", "sp", "tp", "wind_speed"]
SOURCE_VARIABLES = VARIABLES[:-1]
UNITS = {"u10": "m/s", "v10": "m/s", "d2m": "degC", "t2m": "degC", "sp": "hPa", "tp": "mm", "wind_speed": "m/s"}

app = FastAPI(title="Neural Flow Dynamics API", description="Global ERA5 weather data API for NFD.", version="0.2.0")
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_credentials=False, allow_methods=["GET"], allow_headers=["*"])


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
        raise RuntimeError("No time dimension found. Run inspect_grib.py.")
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
        raise HTTPException(status_code=500, detail=f"Could not read GRIB dataset: {exc}. Run inspect_grib.py.") from exc


def get_grid(ds, variable, timestamp):
    field = ds[variable].sel(time=timestamp)
    if "step" in field.dims:
        field = field.isel(step=0)
    return np.asarray(field.squeeze(drop=True).transpose("latitude", "longitude").values)


def get_timestamps_for_date(ds, requested_date):
    timestamps = pd.to_datetime(ds.time.values, errors="coerce")
    day = pd.Timestamp(requested_date).strftime("%Y-%m-%d")
    return [t for t in timestamps if not pd.isna(t) and t.strftime("%Y-%m-%d") == day]


def grid_to_json(values):
    a = np.asarray(values, dtype=float)
    return [[None if not np.isfinite(v) else float(v) for v in row] for row in a]


def get_frame_arrays(ds, timestamp):
    u10, v10 = get_grid(ds, "u10", timestamp), get_grid(ds, "v10", timestamp)
    return [u10, v10, get_grid(ds, "d2m", timestamp), get_grid(ds, "t2m", timestamp), get_grid(ds, "sp", timestamp), get_grid(ds, "tp", timestamp), np.hypot(u10, v10)]


@lru_cache(maxsize=3)
def build_binary(date_string):
    ds = load_or_http_error()
    timestamps = get_timestamps_for_date(ds, date.fromisoformat(date_string))
    if not timestamps:
        raise HTTPException(status_code=404, detail=f"No weather data found for {date_string}. Check /api/dates.")
    frames = [np.stack(get_frame_arrays(ds, t), axis=0) for t in timestamps]
    data = np.ascontiguousarray(np.stack(frames).astype("<f4", copy=False))
    metadata = {
        "date": date_string, "source": "ERA5 reanalysis", "variables": VARIABLES,
        "units": UNITS, "times": [pd.Timestamp(t).strftime("%H:%M") for t in timestamps],
        "expected_times_utc": EXPECTED_TIMES, "shape": list(data.shape),
        "latitude": ds.latitude.values.tolist(), "longitude": ds.longitude.values.tolist(),
        "dtype": "float32", "byte_order": "little",
        "layout": "time,variable,latitude,longitude"
    }
    header = json.dumps(metadata, separators=(",", ":"), allow_nan=False).encode("utf-8")
    padding = b"\0" * (-(4 + len(header)) % 4)
    return struct.pack("<I", len(header)) + header + padding + data.tobytes()


@app.get("/")
def root():
    return {"project": "Neural Flow Dynamics", "message": "NFD Weather API is running.", "docs": "/docs"}


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/dates")
def available_dates():
    ds = load_or_http_error()
    timestamps = pd.to_datetime(ds.time.values, errors="coerce")
    dates = sorted({t.strftime("%Y-%m-%d") for t in timestamps if not pd.isna(t)})
    return {"dates": dates}


@app.get("/api/weather-binary")
def get_weather_binary(requested_date: date = Query(..., alias="date")):
    body = build_binary(requested_date.isoformat())
    return Response(content=body, media_type="application/octet-stream", headers={"Cache-Control": "public, max-age=3600", "X-Weather-Format": "nfd-f32-v1"})


@app.get("/api/weather")
def get_weather(requested_date: date = Query(..., alias="date")):
    ds = load_or_http_error()
    timestamps = get_timestamps_for_date(ds, requested_date)
    if not timestamps:
        raise HTTPException(status_code=404, detail=f"No weather data found for {requested_date}. Check /api/dates.")
    frames = []
    for timestamp in timestamps:
        fields = get_frame_arrays(ds, timestamp)
        frames.append({"time": pd.Timestamp(timestamp).strftime("%H:%M"), **{name: grid_to_json(values) for name, values in zip(VARIABLES, fields)}})
    times = [f["time"] for f in frames]
    return JSONResponse(content={
        "date": requested_date.isoformat(), "source": "ERA5 reanalysis",
        "grid": "Global; original dataset resolution", "units": UNITS,
        "expected_times_utc": EXPECTED_TIMES, "available_times_utc": times,
        "missing_times_utc": [t for t in EXPECTED_TIMES if t not in times],
        "latitude": ds.latitude.values.tolist(), "longitude": ds.longitude.values.tolist(),
        "frames": frames
    })
