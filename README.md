AQUA: AI-Powered Maritime Route Optimization
<div align="center">
<img src="https://i.imgur.com/your_project_logo_or_banner.png" alt="AQUA Banner" width="800"/>
</div>

AQUA is a full-stack web application designed to find the most fuel-efficient maritime routes by analyzing real-time environmental data and predicting future sea conditions with a live-trained AI model.

This project addresses the critical challenges of modern shipping: high fuel consumption, significant CO₂ emissions, and the operational risks posed by unpredictable weather. By leveraging a sophisticated pathfinding algorithm and a predictive AI, AQUA provides smarter, safer, and more economical routing solutions.

✨ Key Features
Dynamic, Fuel-Efficient Routing: Utilizes a powerful A* pathfinding algorithm to calculate the optimal route based on minimizing fuel consumption, not just distance.

Comprehensive Environmental Analysis: The algorithm considers multiple real-world factors, including wind speed & direction, ocean currents, wave height, sea depth, rainfall, and ice concentration.

Interactive "No-Go" Zones: Allows users to draw custom exclusion zones on the map (e.g., for piracy, military exercises, or protected areas) that the routing algorithm must avoid.

Multi-Strategy Route Comparison: Offers "Balanced," "Fastest," and "Safest" routing strategies and displays the resulting paths and metrics on a comparison dashboard.

Live Voyage Simulation: A real-time boat animation visualizes the journey, complete with a heads-up display (HUD) showing the vessel's progress and the live environmental conditions it encounters.

AI-Powered Weather Prediction: A Genetic Algorithm (GA) is trained live on data collected during the voyage to evolve a predictive model that forecasts sea conditions for the next 6 hours.

Interactive Map Interface: Users can easily set routes, select different vessel types, and monitor all voyage metrics through a clean and intuitive user interface.

🛠️ Tech Stack & Architecture
AQUA is built with a modern, multi-service architecture that separates concerns for performance and scalability.

Component	Technology	Purpose
Front-End (Client)	HTML5, Tailwind CSS, JavaScript, Leaflet.js	Renders the interactive map, UI panels, and real-time simulation.
Back-End (API)	Node.js, Express.js	Serves the front-end and runs the core A* pathfinding algorithm.
Data & AI Service	Python, FastAPI, NumPy	Serves large environmental datasets and runs the live GA prediction model.

Export to Sheets
🚀 Getting Started
Follow these steps to set up and run the project on your local machine.

Prerequisites
Node.js (v16 or later)

Python (v3.8 or later) with pip

A modern web browser (Chrome, Firefox, etc.)

1. Download Environmental Data
The application relies on a large set of environmental data files (.nc format). These are essential for the pathfinding algorithm.

➡️ Click here to download the nc_data folder from Google Drive

Place the downloaded nc_data folder in the root directory of the project.

2. Set Up the Back-End Services
You will need to run two separate servers in two separate terminals.

Terminal 1: Start the Python Data & AI Service
Bash

# Navigate to the project's root directory
cd /path/to/your/project

# Install Python dependencies
pip install -r requirements.txt

# Start the FastAPI server (runs on http://127.0.0.1:8000)
uvicorn data_server:app --reload
Terminal 2: Start the Node.js Routing Server
Bash

# Navigate to the project's root directory in a new terminal
cd /path/to/your/project

# Install Node.js dependencies
npm install

# Start the Express server (runs on http://localhost:3000)
node server.js
3. Launch the Application
Once both servers are running, open your web browser and navigate to:

➡️ http://localhost:3000

The application should now be fully operational.

🗺️ How to Use the App
Set a Route:

Use the search boxes to select a start and end port.

Alternatively, double-click a start point and then an end point directly on the map.

For a quick start, click the "Load Demo Route" button.

Configure Vessel: Select a ship type from the dropdown or enter custom parameters for your vessel. The voyage date will default to today.

Analyze & Compare: Once calculated, all route strategies will be displayed. Use the sidebar to view key metrics, compare all routes in the dashboard, or view the environmental profile of a specific route.

Start the Simulation: Click the boat icon control button on the bottom right to begin the real-time voyage animation.

Monitor Live Data: As the boat travels, the HUD on the right will update with live environmental data and the 6-hour forecast from the AI model.