# sea_predictor_ga.py
# Implements a Genetic Algorithm (GA) to find optimal coefficients 
# for a simple Autoregressive (AR) model with a trend component to forecast sea conditions.
# The results are written to historical_data.json, simulating real-time output.

import json
import numpy as np
import random
import os
from datetime import datetime, timedelta
from typing import Dict, Any

# --- Configuration ---
# MODIFIED: Increased population and generations for a more thorough search
POPULATION_SIZE = 60
GENERATIONS = 30
MUTATION_RATE = 0.1
HISTORY_LENGTH = 5 # Number of previous data points used for prediction
HISTORY_FILE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'cache', 'environmental_history.json')

# --- Live Data Handling ---

def get_historical_data_live(variable_key, current_value, num_points=HISTORY_LENGTH):
    """
    Reads environmental data history from the cache file and prepares the series.
    If the file doesn't exist or has insufficient data, it pads the history 
    by assuming the current value has been stable for the required duration.
    """
    history_list = []
    
    if os.path.exists(HISTORY_FILE_PATH):
        try:
            with open(HISTORY_FILE_PATH, 'r') as f:
                history_data = json.load(f)
            for entry in history_data:
                val = entry.get(variable_key, current_value)
                if val is not None:
                    history_list.append(val)
        except (json.JSONDecodeError, IOError):
            print(f"Warning: Could not read or decode {HISTORY_FILE_PATH}. Starting with padded history.")

    required_history = history_list[-num_points:]

    if len(required_history) < num_points:
        padding_count = num_points - len(required_history)
        padding_value = current_value if current_value is not None else (required_history[0] if required_history else 0.0)
        padding = [padding_value] * padding_count
        required_history = padding + required_history
        
    if current_value is not None and required_history:
        required_history[-1] = current_value 
        
    return required_history

# --- Genetic Algorithm Core Components ---

class Individual:
    """Represents a set of AR+Trend model coefficients (the 'genome')."""
    def __init__(self, coefficients=None):
        # MODIFIED: Added one more coefficient for the linear trend component
        if coefficients is None:
            self.coefficients = np.random.uniform(-0.5, 0.5, size=HISTORY_LENGTH + 2)
        else:
            self.coefficients = coefficients
        self.fitness = 0.0

    def predict(self, history, t=0):
        """Uses the coefficients to predict the next value, including a trend component."""
        if len(history) != HISTORY_LENGTH:
            raise ValueError("History length mismatch")
        
        # MODIFIED: Prediction now includes autoregressive, bias, and trend parts
        # Coefficients are [ar_1, ..., ar_n, bias, trend_coeff]
        ar_part = np.dot(self.coefficients[:HISTORY_LENGTH], history)
        bias_part = self.coefficients[HISTORY_LENGTH]
        trend_part = self.coefficients[HISTORY_LENGTH + 1] * t
        prediction = ar_part + bias_part + trend_part
        return prediction

def calculate_fitness(individual, historical_series):
    """Evaluates fitness based on how well the coefficients predict known historical values."""
    if len(historical_series) <= HISTORY_LENGTH:
        return -1e9

    errors = []
    for i in range(HISTORY_LENGTH, len(historical_series)):
        history = historical_series[i - HISTORY_LENGTH:i][::-1]
        target = historical_series[i]
        # MODIFIED: Pass the time index 'i' to the prediction for trend calculation
        prediction = individual.predict(history, t=i)
        errors.append((prediction - target)**2)

    mse = np.mean(errors)
    return -mse if mse > 0 else 1.0


def select_parents(population):
    """Tournament Selection."""
    parents = []
    for _ in range(2):
        i1, i2 = random.randrange(0, POPULATION_SIZE), random.randrange(0, POPULATION_SIZE)
        winner_index = i1 if population[i1].fitness > population[i2].fitness else i2
        parents.append(population[winner_index])
    return parents[0], parents[1]


def crossover(parent1, parent2):
    """Uniform Crossover."""
    child_coeffs = np.copy(parent1.coefficients)
    for i in range(len(child_coeffs)):
        if random.random() < 0.5:
            child_coeffs[i] = parent2.coefficients[i]
    return Individual(child_coeffs)


def mutate(individual):
    """Add a small random perturbation."""
    for i in range(len(individual.coefficients)):
        if random.random() < MUTATION_RATE:
            individual.coefficients[i] += random.uniform(-0.5, 0.5) * 0.2


def run_genetic_algorithm(historical_series):
    """Runs the GA to find the best predictive model coefficients."""
    population = [Individual() for _ in range(POPULATION_SIZE)]
    for _ in range(GENERATIONS):
        for individual in population:
            individual.fitness = calculate_fitness(individual, historical_series)
        
        new_population = [max(population, key=lambda i: i.fitness)] # Elitism
        while len(new_population) < POPULATION_SIZE:
            parent1, parent2 = select_parents(population)
            child = crossover(parent1, parent2)
            mutate(child)
            new_population.append(child)
        population = new_population

    for individual in population:
        individual.fitness = calculate_fitness(individual, historical_series)
    return max(population, key=lambda i: i.fitness)

# --- Main Prediction Function ---

def predict_sea_conditions_ga(variable_key, current_value):
    """
    Runs the full GA process and outputs the next 3 forecasted steps.
    Includes a sanity check for constant historical data.
    """
    historical_series = get_historical_data_live(variable_key, current_value, num_points=HISTORY_LENGTH + 5)

    if len(historical_series) < HISTORY_LENGTH + 1:
        print(f"Warning: Insufficient history for {variable_key}. Returning current value.")
        return [current_value or 0.0] * 3, [0.0] * (HISTORY_LENGTH + 2)
        
    is_constant = all(abs(x - historical_series[0]) < 1e-9 for x in historical_series)
    if is_constant:
        print(f"Info: Historical data for {variable_key} is constant. Bypassing GA and predicting stable conditions.")
        return [historical_series[0]] * 3, [0.0] * (HISTORY_LENGTH + 2)

    best_predictor = run_genetic_algorithm(historical_series)
    
    forecast_steps = 3
    current_series = list(historical_series)
    forecast = []

    for i in range(forecast_steps):
        history_input = current_series[-HISTORY_LENGTH:][::-1]
        # MODIFIED: Pass a future time index to project the trend forward
        future_time_index = len(historical_series) + i
        predicted_value = best_predictor.predict(history_input, t=future_time_index)
        
        # Apply constraints based on the variable type
        if variable_key == 'ice_conc':
            predicted_value = min(1.0, max(0.0, predicted_value)) # Clamp between 0 and 1
        elif 'direction' in variable_key:
            predicted_value = predicted_value % 360 # Wrap direction
        else:
            predicted_value = max(0.0, predicted_value) # Ensure non-negative

        current_series.append(predicted_value)
        forecast.append(predicted_value)
    
    return forecast, best_predictor.coefficients.tolist()

def generate_and_save_prediction(lat: float, lon: float, date: str, current_conditions: Dict[str, Any]):
    """Runs prediction for key variables and saves to JSON file."""
    
    prediction_keys = {
        'wind_speed_mps': 'wind_speed_mps',
        'wind_direction_deg': 'wind_direction_deg',
        'current_speed_mps': 'current_speed_mps',
        'current_direction_deg': 'current_direction_deg',
        'waves_height_m': 'waves_height_m',
        'weekly_precip_mean': 'weekly_precip_mean',
        'ice_conc': 'ice_conc'
    }

    forecasts = {}
    all_coeffs = {}

    for display_key, log_key in prediction_keys.items():
        current_val = current_conditions.get(log_key)
        forecast, coeffs = predict_sea_conditions_ga(log_key, current_val)
        forecasts[display_key] = forecast
        all_coeffs[f"{display_key}_coeffs"] = coeffs

    future_points = []
    current_time = datetime.fromisoformat(date.replace('Z', '+00:00'))
    
    for i in range(3):
        future_time = current_time + timedelta(hours=(i + 1) * 6) 
        
        point_data = {
            "timestamp": future_time.isoformat(),
            "lat": lat, "lon": lon
        }
        for key, forecast_list in forecasts.items():
            point_data[f"predicted_{key}"] = forecast_list[i] if i < len(forecast_list) else 0.0
        future_points.append(point_data)

    prediction_data = {
        "metadata": {
            # MODIFIED: Updated model name
            "model": "Genetic Algorithm AR(5)+Trend Live-Trained",
            "run_at": datetime.now().isoformat(),
            "start_location": {"lat": lat, "lon": lon},
            "start_date": date,
            "grounding_data": current_conditions
        },
        "forecast_horizon_hours": 18,
        "optimized_coefficients": all_coeffs,
        "forecast_data": future_points
    }

    try:
        with open('historical_data.json', 'w') as f:
            json.dump(prediction_data, f, indent=4)
        # FIX: Return the prediction data directly without the extra "forecast" key
        return prediction_data
    except Exception as e:
        print(f"Error saving historical_data.json: {e}")
        return None

