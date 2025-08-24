import sys
import rasterio

tif_file = "cache/depth-cache.tif"

# Read lon, lat from command line arguments
lon = float(sys.argv[1])
lat = float(sys.argv[2])

with rasterio.open(tif_file) as src:
    row, col = src.index(lon, lat)
    value = src.read(1)[row, col]
    print(value)  # send value back to Node
