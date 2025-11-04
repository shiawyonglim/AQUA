# data_server.py
# A high-performance FastAPI server to provide environmental data.
# MODIFIED to serve data for a requested bounding box.

import sys
import os
import json
import struct
from fastapi import FastAPI, Response
from pydantic import BaseModel
from typing import Dict, Any
import netCDF4
import numpy as np
from datetime import datetime, timedelta
from contextlib import asynccontextmanager

# --- IMPORT NEW PREDICTOR MODULE ---
try:
    from sea_predictor_ga import generate_and_save_prediction
    PREDICTOR_AVAILABLE = True
except ImportError:
    print("WARNING: 'sea_predictor_ga.py' not found. Prediction endpoint will be disabled.")
    PREDICTOR_AVAILABLE = False
# -----------------------------------


# --- Configuration ---
BASE_NC_PATH = "../data/nc_data"

# --- FastAPI App Initialization & Data Cache ---
data_cache = { "nc_files": {} }

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Handles loading and closing of NetCDF files during server startup and shutdown."""
    print("--- FastAPI server starting up: Loading NetCDF files... ---")
    
    # --- MODIFICATION: Updated the list of .nc files to load ---
    nc_filenames = ["wind.nc", "current.nc", "waves.nc", "rain.nc", "ice.nc", "sea_depth.nc"]
    # --- END MODIFICATION ---

    for filename in nc_filenames:
        try:
            path = os.path.join(BASE_NC_PATH, filename)
            data_cache["nc_files"][filename] = netCDF4.Dataset(path, 'r', decode_times=False)
            print(f"  - Successfully loaded and cached: {path}")
        except Exception as e:
            print(f"  - WARNING: Could not load {filename}. Error: {e}")
    print("--- Data loading complete. Server is ready. ---")
    yield
    print("--- Closing all open data files... ---")
    for handler in data_cache["nc_files"].values(): handler.close()
    print("--- Server shut down. ---")

app = FastAPI(lifespan=lifespan)

# --- (The rest of the file remains exactly the same) ---

# --- Pydantic Data Model ---
class GridDataRequest(BaseModel):
    min_lat: float
    min_lon: float
    max_lat: float
    max_lon: float
    date: str

class PredictionRequest(BaseModel):
    lat: float
    lon: float
    date: str
    current_conditions: Dict[str, Any]

def process_bounded_dataset(request: GridDataRequest):
    response_data = {}
    voyage_date = datetime.fromisoformat(request.date.replace('Z', '+00:00'))
    days_since_sunday = (voyage_date.weekday() + 1) % 7
    target_date = voyage_date - timedelta(days=days_since_sunday)
    
    first_nc_name = next(iter(data_cache["nc_files"]))
    first_handler = data_cache["nc_files"][first_nc_name]
    
    lat_var = first_handler.variables.get('lat') or first_handler.variables.get('latitude')
    lon_var = first_handler.variables.get('lon') or first_handler.variables.get('longitude')
    
    lat_indices = np.where((lat_var[:] >= request.min_lat) & (lat_var[:] <= request.max_lat))[0]
    lon_indices = np.where((lon_var[:] >= request.min_lon) & (lon_var[:] <= request.max_lon))[0]

    if len(lat_indices) == 0 or len(lon_indices) == 0:
        raise ValueError("Bounding box is outside the available data range.")

    lat_slice = slice(lat_indices[0], lat_indices[-1] + 1)
    lon_slice = slice(lon_indices[0], lon_indices[-1] + 1)

    response_data['lats'] = lat_var[lat_slice].tolist()
    response_data['lons'] = lon_var[lon_slice].tolist()

    for nc_name, nc_handler in data_cache["nc_files"].items():
        time_idx = 0
        if 'time' in nc_handler.variables:
            time_var = nc_handler.variables['time']
            target_num = netCDF4.date2num(target_date, time_var.units, calendar=getattr(time_var, 'calendar', 'standard'))
            time_idx = np.abs(time_var[:] - target_num).argmin()

        for var_name in nc_handler.variables:
            if var_name in ['lat', 'lon', 'latitude', 'longitude', 'time']: continue
            
            variable = nc_handler.variables[var_name]
            if not np.issubdtype(variable.dtype, np.number): continue

            if variable.ndim == 3:
                data_slice = variable[time_idx, lat_slice, lon_slice]
            elif variable.ndim == 2:
                data_slice = variable[lat_slice, lon_slice]
            else:
                continue
            
            if var_name == 'elevation':
                land_mask = data_slice >= 0
                data_slice *= -1
                data_slice[land_mask] = -9999
                var_name = 'depth'
            
            if np.ma.is_masked(data_slice):
                data_slice = data_slice.filled(-9999)

            if var_name == 'ice_conc' or var_name == 'ice_coverage':
                data_slice = data_slice / 100.0
                data_slice = np.clip(data_slice, 0, 1)

            response_data[var_name] = data_slice.astype(np.float64)
            
    return response_data

@app.post("/get-data-grid-hybrid/")
async def get_data_grid_hybrid(request: GridDataRequest):
    try:
        response_data = process_bounded_dataset(request)
    except Exception as e:
        return Response(status_code=500, content=f"Error processing grid request: {e}")
    
    binary_chunks, metadata = [], {"variables": []}
    metadata['lats'], metadata['lons'] = response_data.get('lats', []), response_data.get('lons', [])

    for key, value in response_data.items():
        if key in ['lats', 'lons'] or not isinstance(value, np.ndarray): continue
        grid_bytes = value.tobytes()
        binary_chunks.append(grid_bytes)
        metadata['variables'].append({"name": key, "shape": value.shape, "dtype": 'float64', "byte_length": len(grid_bytes)})

    meta_bytes = json.dumps(metadata).encode('utf-8')
    header = struct.pack('>I', len(meta_bytes))
    return Response(content=header + meta_bytes + b''.join(binary_chunks), media_type="application/octet-stream")

@app.post("/api/predict_next_step")
async def predict_next_step(request: PredictionRequest):
    if not PREDICTOR_AVAILABLE:
        return {"error": "Prediction service is disabled."}, 503
    try:
        prediction_result = generate_and_save_prediction(request.lat, request.lon, request.date, request.current_conditions)
        if prediction_result:
            return prediction_result
        else:
            return {"error": "GA Prediction failed."}, 500
    except Exception as e:
        return {"error": f"Internal server error: {e}"}, 500