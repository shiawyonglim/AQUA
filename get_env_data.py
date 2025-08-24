import rasterio
import netCDF4
import json
import sys
import argparse

def get_depth(lat, lon, tif_path):
    """Extracts depth from a GeoTIFF file at given coordinates."""
    try:
        with rasterio.open(tif_path) as src:
            # Get the value at the specified longitude and latitude
            for val in src.sample([(lon, lat)]):
                # Rasterio returns a numpy array, get the first element
                depth = float(val[0])
                # Handle no-data values if necessary (often represented as a large negative number)
                if depth < -1000:
                    return 100 # Default safe depth if no data is available
                return depth
    except Exception as e:
        # print(f"Warning: Could not read depth data from {tif_path}. Error: {e}", file=sys.stderr)
        return 100 # Default safe depth on error

def get_netcdf_value(lat, lon, nc_path, var_name):
    """Extracts a variable from a NetCDF file at the closest point to given coordinates."""
    try:
        with netCDF4.Dataset(nc_path, 'r') as nc:
            # Find the nearest latitude and longitude indices
            lat_var = nc.variables['latitude']
            lon_var = nc.variables['longitude']
            lat_idx = (abs(lat_var[:] - lat)).argmin()
            lon_idx = (abs(lon_var[:] - lon)).argmin()
            
            value = nc.variables[var_name][0, lat_idx, lon_idx] # Assuming time is the first dimension
            return float(value)
    except Exception as e:
        # print(f"Warning: Could not read {var_name} from {nc_path}. Error: {e}", file=sys.stderr)
        return 0 # Default to 0 on error

def main():
    """
    Main function to parse arguments and extract environmental data.
    Outputs a JSON object with the extracted data.
    """
    parser = argparse.ArgumentParser(description="Extract environmental data for a given lat/lon.")
    parser.add_argument("lat", type=float, help="Latitude of the point of interest.")
    parser.add_argument("lon", type=float, help="Longitude of the point of interest.")
    parser.add_argument("--depth_file", type=str, default="depth-cache.tif", help="Path to the depth GeoTIFF file.")
    # Add arguments for other data files as needed
    # parser.add_argument("--wind_file", type=str, help="Path to the wind NetCDF file.")
    # parser.add_argument("--current_file", type=str, help="Path to the current NetCDF file.")
    
    args = parser.parse_args()

    # --- Data Extraction ---
    # For now, we'll use placeholder values for wind and current as we don't have the files.
    # You would replace these with calls to get_netcdf_value when you have the files.
    
    depth = get_depth(args.lat, args.lon, args.depth_file)
    wind_strength = 1.0 # Placeholder
    wind_direction = 1.0 # Placeholder
    current_strength = 1.0 # Placeholder
    current_direction = 1.0 # Placeholder
    wave_height = 1.0 # Placeholder
    wave_direction = 1.0 # Placeholder
    rain_intensity = 1.0 # Placeholder
    rain_probability = 1.0 # Placeholder

    # --- Output JSON ---
    output_data = {
        "seaDepth": round(depth, 2),
        "windStrength": wind_strength,
        "windDirection": wind_direction,
        "currentStrength": current_strength,
        "currentDirection": current_direction,
        "waveHeight": wave_height,
        "waveDirection": wave_direction,
        "rainIntensity": rain_intensity,
        "rainProbability": rain_probability,
    }

    print(json.dumps(output_data))

if __name__ == "__main__":
    main()
