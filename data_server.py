# data_server.py
# A high-performance FastAPI server to provide environmental data.
# MODIFIED to always return the full global map, ignoring request bounds.

import sys
import os
import json
import struct
from fastapi import FastAPI, Response
from pydantic import BaseModel
import netCDF4
import numpy as np
from datetime import datetime, timedelta
from contextlib import asynccontextmanager

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

            # Disable automatic time decoding to prevent errors with future dates
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

# --- Helper Function to Process the Full Dataset ---
def process_full_dataset(request: GridDataRequest):
    """
    Processes all NetCDF files and returns the full global data, ignoring request bounds.
    """
    response_data = {}
    voyage_date = datetime.fromisoformat(request.date.replace('Z', '+00:00'))
    days_since_sunday = (voyage_date.weekday() + 1) % 7
    target_date = voyage_date - timedelta(days=days_since_sunday)

    for nc_name, nc_handler in data_cache["nc_files"].items():
        lat_var = nc_handler.variables.get('lat') or nc_handler.variables.get('latitude')
        lon_var = nc_handler.variables.get('lon') or nc_handler.variables.get('longitude')
        
        # full coordinate arrays
        if 'lats' not in response_data:
            response_data['lats'] = lat_var[:]
        if 'lons' not in response_data:
            response_data['lons'] = lon_var[:]

        time_idx = 0
        if 'time' in nc_handler.variables:
            time_var = nc_handler.variables['time']

            # find the closest time index by comparing raw numbers
            target_num = netCDF4.date2num(target_date, time_var.units, calendar=getattr(time_var, 'calendar', 'standard'))
            time_idx = np.abs(time_var[:] - target_num).argmin()

        for var_name in nc_handler.variables:
            if var_name in ['lat', 'lon', 'latitude', 'longitude', 'time']: continue
            
            variable = nc_handler.variables[var_name]
            
            # Skip any non-numeric variables 
            if not np.issubdtype(variable.dtype, np.number):
                continue

            # Select the full data slice, not a subset
            if variable.ndim == 3: # (time, lat, lon)
                data_slice = variable[time_idx, :, :]
            elif variable.ndim == 2: # (lat, lon)
                data_slice = variable[:, :]
            else:
                continue

            # Process elevation and masked data as before
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
    High-performance endpoint returning data in a hybrid format for the entire globe.
    """
    try:
        response_data = process_full_dataset(request)
    except Exception as e:
        print(f"Error during data slicing: {e}", file=sys.stderr)
        return Response(status_code=500, content=f"Error processing grid request: {e}")
    
    print("Packing hybrid response for full map...")
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
