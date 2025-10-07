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
BASE_NC_PATH = "nc_data"

# --- FastAPI App Initialization & Data Cache ---
data_cache = { "nc_files": {} }

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Handles loading and closing of NetCDF files during server startup and shutdown."""
    print("--- FastAPI server starting up: Loading NetCDF files... ---")
    nc_filenames = ["wind_asc.nc", "wind_dsc.nc", "current.nc", "waves.nc", "rain.nc", "ice.nc", "sea_depth.nc"]
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

# --- Pydantic Data Model ---
class GridDataRequest(BaseModel):
    """Defines the expected structure for incoming voyage requests."""
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


# --- MODIFIED: Helper function to process a bounded dataset ---
def process_bounded_dataset(request: GridDataRequest):
    """
    Processes all NetCDF files and returns data for the specified bounding box.
    """
    response_data = {}
    voyage_date = datetime.fromisoformat(request.date.replace('Z', '+00:00'))
    days_since_sunday = (voyage_date.weekday() + 1) % 7
    target_date = voyage_date - timedelta(days=days_since_sunday)

    # Use the first file to determine the slicing indices, assuming all grids are aligned
    first_nc_name = next(iter(data_cache["nc_files"]))
    first_handler = data_cache["nc_files"][first_nc_name]
    
    lat_var = first_handler.variables.get('lat') or first_handler.variables.get('latitude')
    lon_var = first_handler.variables.get('lon') or first_handler.variables.get('longitude')
    
    # Find the indices for the bounding box
    lat_indices = np.where((lat_var[:] >= request.min_lat) & (lat_var[:] <= request.max_lat))[0]
    lon_indices = np.where((lon_var[:] >= request.min_lon) & (lon_var[:] <= request.max_lon))[0]

    if len(lat_indices) == 0 or len(lon_indices) == 0:
        raise ValueError("Bounding box is outside the available data range.")

    lat_slice = slice(lat_indices[0], lat_indices[-1] + 1)
    lon_slice = slice(lon_indices[0], lon_indices[-1] + 1)

    response_data['lats'] = lat_var[lat_slice]
    response_data['lons'] = lon_var[lon_slice]

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

            # MODIFIED: Select the bounded data slice
            if variable.ndim == 3: # (time, lat, lon)
                data_slice = variable[time_idx, lat_slice, lon_slice]
            elif variable.ndim == 2: # (lat, lon)
                data_slice = variable[lat_slice, lon_slice]
            else:
                continue
            
            if var_name == 'elevation':
                land_mask = data_slice > 0
                data_slice *= -1
                data_slice[land_mask] = -9999
                var_name = 'depth'
            
            if np.ma.is_masked(data_slice):
                data_slice = data_slice.filled(-9999)

            response_data[var_name] = data_slice
            
    return response_data


# --- API Endpoints ---

@app.post("/get-data-grid-hybrid/")
async def get_data_grid_hybrid(request: GridDataRequest):
    """
    High-performance endpoint returning data in a hybrid format for a specified bounding box.
    """
    try:
        # MODIFIED: Call the new bounded dataset function
        response_data = process_bounded_dataset(request)
    except Exception as e:
        print(f"Error during data slicing: {e}", file=sys.stderr)
        return Response(status_code=500, content=f"Error processing grid request: {e}")
    
    print(f"Packing hybrid response for {response_data.get('lats').shape[0]}x{response_data.get('lons').shape[0]} grid...")
    binary_chunks = []
    metadata = { "variables": [] }
    
    metadata['lats'] = response_data.get('lats', np.array([])).tolist()
    metadata['lons'] = response_data.get('lons', np.array([])).tolist()

    for key, value in response_data.items():
        if key in ['lats', 'lons'] or not isinstance(value, np.ndarray): continue
        
        grid_array = value.astype(np.float64)
        grid_bytes = grid_array.tobytes()
        binary_chunks.append(grid_bytes)
        
        metadata['variables'].append({
            "name": key, "shape": grid_array.shape,
            "dtype": 'float64', "byte_length": len(grid_bytes)
        })

    meta_json = json.dumps(metadata)
    meta_bytes = meta_json.encode('utf-8')
    meta_size = len(meta_bytes)
    header = struct.pack('>I', meta_size)
    final_buffer = header + meta_bytes + b''.join(binary_chunks)
    
    print(f"Hybrid response ready: {len(meta_bytes)} bytes of metadata, {sum(len(c) for c in binary_chunks)} bytes of grid data.")
    return Response(content=final_buffer, media_type="application/octet-stream")


@app.post("/api/predict_next_step")
async def predict_next_step(request: PredictionRequest):
    """
    Runs the Genetic Algorithm predictor and writes the forecast to historical_data.json.
    """
    if not PREDICTOR_AVAILABLE:
        return {"error": "Prediction service is disabled because sea_predictor_ga.py could not be imported."}, 503

    try:
        print(f"Triggering GA prediction for {request.lat}, {request.lon} at {request.date}...")
        
        prediction_result = generate_and_save_prediction(
            request.lat, 
            request.lon, 
            request.date,
            request.current_conditions
        )

        if prediction_result:
            return prediction_result
        else:
            return {"error": "GA Prediction failed to run or save output."}, 500

    except Exception as e:
        print(f"Error executing GA prediction: {e}", file=sys.stderr)
        return {"error": f"Internal server error during prediction: {e}"}, 500

