import sys
import json
import subprocess
import requests

def get_environmental_data(lat, lon):
    """
    Calls the get_env_data.py script to fetch environmental data
    for a specific latitude and longitude.
    """
    try:
        # Ensure the path to the script is correct
        # If call.py is in the root, and get_env_data.py is too, this is fine.
        command = [
            sys.executable, 
            "get_env_data.py", 
            str(lat), 
            str(lon),
            "--depth_file", "depth-cache.tif" # Make sure this file is accessible
        ]
        
        result = subprocess.run(command, capture_output=True, text=True, check=True)
        
        # The output from the script is a JSON string, so we parse it
        return json.loads(result.stdout)
        
    except FileNotFoundError:
        print("Error: 'get_env_data.py' not found. Make sure it's in the same directory.")
        return None
    except subprocess.CalledProcessError as e:
        print(f"Error executing get_env_data.py: {e}")
        print(f"Stderr: {e.stderr}")
        return None
    except json.JSONDecodeError:
        print("Error: Could not parse JSON from get_env_data.py script.")
        return None


def find_path_with_env_data(start_coords, end_coords, vessel_params):
    """
    Finds a path by first getting environmental data for the start point
    and then calling the pathfinding API.
    """
    print(f"Fetching environmental data for start point: {start_coords}")
    
    # Get environmental data based on the starting point of the journey
    env_data = get_environmental_data(start_coords['lat'], start_coords['lng'])
    
    if not env_data:
        print("Could not retrieve environmental data. Aborting pathfinding.")
        return

    print("Successfully retrieved environmental data:", env_data)
    
    # Combine vessel and environmental parameters
    all_params = {**vessel_params, **env_data}

    # Prepare the data payload for the API request
    payload = {
        "start": start_coords,
        "end": end_coords,
        "params": all_params
    }
    
    api_url = "http://localhost:3000/api/path"
    
    try:
        print("Sending request to pathfinding server...")
        response = requests.post(api_url, json=payload)
        response.raise_for_status()  # Raises an exception for bad status codes (4xx or 5xx)
        
        path_data = response.json()
        
        # Save the output to a file
        output_filename = "path_output.json"
        with open(output_filename, 'w') as f:
            json.dump(path_data, f, indent=4)
            
        print(f"\nPath found! Route saved to {output_filename}")
        if path_data:
            print(f"Total Fuel: {path_data[-1]['totalFuel']:.2f} L")

    except requests.exceptions.RequestException as e:
        print(f"\nAn error occurred while calling the API: {e}")


if __name__ == "__main__":
    # --- Define Vessel and Route ---
    
    # Example Vessel Parameters (Fishing Trawler)
    vessel_parameters = {
        "baseWeight": 1500,
        "load": 500,
        "speed": 10,
        "draft": 5,
        "hpReq": 2000,
        "fuelRate": 0.22,
        "k": 0.05, 
        "F": 1.2, 
        "S": 1.1
    }

    # Example Route
    start_coordinates = {"lat": 5.5, "lng": 114.5}
    end_coordinates = {"lat": 2.5, "lng": 111.5}

    # --- Execute Pathfinding ---
    find_path_with_env_data(start_coordinates, end_coordinates, vessel_parameters)
