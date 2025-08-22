#!/usr/bin/env python3
"""
pipeline.py

Single-factor maritime forecasting pipeline with GA for feature selection + hyperparameter search.
Includes accuracy threshold check and detailed accuracy reporting.

Run per-factor with:
    python3 pipeline.py --config config_wind.json

Requirements:
    pip install xarray xgboost pandas numpy global-land-mask scikit-learn netcdf4 h5netcdf
"""

import argparse
import json
import os
import random
import time
import warnings
from copy import deepcopy
from datetime import timedelta
import zipfile
import io

import numpy as np
import pandas as pd
import xarray as xr
import xgboost as xgb
from sklearn.model_selection import ParameterGrid, train_test_split
from sklearn.metrics import mean_absolute_error
from sklearn.multioutput import MultiOutputRegressor
from global_land_mask import globe

warnings.filterwarnings("ignore")


# -----------------------------
# Utilities
# -----------------------------
def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def load_dataset(path: str) -> xr.Dataset:
    """
    Loads an xarray Dataset from a path.
    Handles both standard .nc files and .nc files within a .zip archive.
    """
    if path.endswith(".zip"):
        print(f"Detected zip archive: {path}")
        with zipfile.ZipFile(path, 'r') as zf:
            nc_name = next((name for name in zf.namelist() if name.endswith('.nc')), None)
            if not nc_name:
                raise FileNotFoundError(f"No .nc file found in the zip archive: {path}")

            print(f"Found '{nc_name}' in zip, loading into memory...")
            nc_bytes = zf.read(nc_name)
            nc_file_obj = io.BytesIO(nc_bytes)
            
            # Use the 'h5netcdf' engine which can handle in-memory NetCDF4 files
            ds = xr.open_dataset(nc_file_obj, engine="h5netcdf")
            
            return ds
    else:
        # Original behavior for non-zip files
        print(f"Loading standard NetCDF file: {path}")
        return xr.open_dataset(path)


def weekly_dates(start_date: str, end_date: str):
    start = pd.Timestamp(start_date)
    end = pd.Timestamp(end_date)
    dates = []
    cur = start
    while cur <= end:
        dates.append(pd.Timestamp(cur))
        cur += timedelta(days=7)
    return dates


def encode_deg_to_sin_cos(arr_deg):
    rad = np.deg2rad(arr_deg)
    return np.sin(rad), np.cos(rad)


def decode_sin_cos_to_deg(sin_arr, cos_arr):
    rad = np.arctan2(sin_arr, cos_arr)
    deg = np.rad2deg(rad)
    return (deg + 360.0) % 360.0


def _sea_mask(lats, lons):
    # Clip coordinates to prevent floating point errors with the library
    lats = np.clip(lats, -90, 90)
    lons = np.clip(lons, -180, 180)
    lat_grid, lon_grid = np.meshgrid(lats, lons, indexing="ij")
    return ~globe.is_land(lat_grid, lon_grid)  # True on sea


def upsample_grid(grid, scale_factor):
    if scale_factor == 1:
        return grid
    return np.kron(grid, np.ones((scale_factor, scale_factor)))


def build_candidate_feature_names(max_lag):
    names = []
    for lag in range(1, max_lag + 1):
        names.append(f"lag_{lag}")
    # <<< MODIFIED START: Added more rolling window options for feature names >>>
    for w in (3, 7, 14, 30):
        if max_lag >= w:
            names.append(f"roll_mean_{w}")
            names.append(f"roll_std_{w}")
            names.append(f"roll_min_{w}")
            names.append(f"roll_max_{w}")
    # <<< MODIFIED END >>>
    names += ["doy_sin", "doy_cos", "lat", "lon"]
    return names


# -----------------------------
# Simple GA (feature selection + hyperparam)
# -----------------------------
class SimpleGA:
    def __init__(self, f_names, hyperparam_grid, fitness_fn,
                 pop_size=25, p_crossover=0.8, p_mutation=0.1, generations=15, **kwargs):
        self.f_names = f_names
        self.F = len(f_names)
        self.hyper_grid = list(ParameterGrid(hyperparam_grid))
        self.H = len(self.hyper_grid)
        self.pop_size = pop_size
        self.p_crossover = p_crossover
        self.p_mutation = p_mutation
        self.generations = generations
        self.fitness_fn = fitness_fn
        self.population = []

    def _random_individual(self):
        while True:
            mask = np.random.rand(self.F) < 0.5
            if mask.any():
                break
        hyper_idx = np.random.randint(0, self.H)
        return (mask, hyper_idx)

    def initialize(self):
        self.population = [self._random_individual() for _ in range(self.pop_size)]

    def tournament_selection(self, scored_pop, k=3):
        selected = []
        for _ in range(self.pop_size):
            aspirants = random.sample(scored_pop, k)
            aspirants.sort(key=lambda x: x[1][0], reverse=True)
            selected.append(aspirants[0][0])
        return selected

    def crossover(self, ind1, ind2):
        mask1, h1 = ind1
        mask2, h2 = ind2
        if np.random.rand() > self.p_crossover:
            return deepcopy(ind1), deepcopy(ind2)
        cp = np.random.randint(1, self.F)
        new1_mask = np.concatenate([mask1[:cp], mask2[cp:]])
        new2_mask = np.concatenate([mask2[:cp], mask1[cp:]])
        if np.random.rand() < 0.5:
            return (new1_mask, h2), (new2_mask, h1)
        else:
            return (new1_mask, h1), (new2_mask, h2)

    def mutate(self, ind):
        mask, hidx = ind
        for i in range(self.F):
            if np.random.rand() < self.p_mutation:
                mask[i] = not mask[i]
        if not mask.any():
            mask[np.random.randint(0, self.F)] = True
        if np.random.rand() < self.p_mutation:
            hidx = np.random.randint(0, self.H)
        return (mask, hidx)

    def run(self):
        self.initialize()
        best = None
        for gen in range(self.generations):
            scored_pop = []
            for ind in self.population:
                mask, hidx = ind
                try:
                    score_tuple = self.fitness_fn(mask, self.hyper_grid[hidx])
                    scored_pop.append((ind, score_tuple))
                except Exception as e:
                    print(f"Fitness eval error, assigning -inf. Error: {e}")
                    scored_pop.append((ind, (-1e9,)))
            
            scored_pop.sort(key=lambda x: x[1][0], reverse=True)

            gen_best = scored_pop[0]
            gen_best_score = gen_best[1][0]

            log_msg = f"GA gen {gen+1}/{self.generations} best_score={gen_best_score:.5f}"
            if len(gen_best[1]) == 3: # WCD case (wind, current)
                log_msg += f" (speed_mae={gen_best[1][1]:.4f}, dir_mae={gen_best[1][2]:.4f})"
            elif len(gen_best[1]) == 2: # Scalar case
                log_msg += f" (mae={gen_best[1][1]:.4f})"
            print(log_msg)

            if best is None or gen_best_score > best[1][0]:
                best = gen_best
                
            next_pop = [gen_best[0]]
            selected = self.tournament_selection(scored_pop)
            while len(next_pop) < self.pop_size:
                a, b = random.sample(selected, 2)
                child1, child2 = self.crossover(a, b)
                child1 = self.mutate(child1)
                child2 = self.mutate(child2)
                next_pop.extend([child1, child2])
            self.population = next_pop[:self.pop_size]
        
        return best[0], best[1][0]


# -----------------------------
# Supervised dataset builders
# -----------------------------
def make_supervised_scalar(var_da: xr.DataArray, max_lag, lat_var, lon_var, sampling_cfg):
    times = pd.to_datetime(var_da.coords['time'].values)
    doy = times.dayofyear
    doy_sin = np.sin(2 * np.pi * doy / 365.25)
    doy_cos = np.cos(2 * np.pi * doy / 365.25)

    all_features, all_targets = [], []
    nlat, nlon = var_da.shape[1], var_da.shape[2]
    total_grid_points = nlat * nlon
    sample_indices = None
    if sampling_cfg.get("enabled", False):
        fraction = sampling_cfg.get("fraction", 1.0)
        num_samples = int(total_grid_points * fraction)
        num_samples = min(num_samples, total_grid_points)
        sample_indices = np.random.choice(total_grid_points, num_samples, replace=False)
        sample_indices.sort()

    for tt in range(max_lag, len(times) - 1):
        target_flat = var_da.isel(time=tt + 1).values.ravel()
        hist = var_da.isel(time=slice(tt - max_lag + 1, tt + 1)).values
        valid_mask = ~np.isnan(target_flat)
        if sample_indices is not None:
            valid_sample_mask = valid_mask[sample_indices]
            idxs = sample_indices[valid_sample_mask]
        else:
            idxs = np.where(valid_mask)[0]
        if len(idxs) == 0:
            continue
        feats = {}
        for lag in range(1, max_lag + 1):
            feats[f"lag_{lag}"] = hist[-lag, :, :].ravel()[idxs]
        
        # <<< MODIFIED START: Added more rolling window features >>>
        for w in (3, 7, 14, 30):
            if max_lag >= w:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    feats[f"roll_mean_{w}"] = np.nanmean(hist[-w:, :, :], axis=0).ravel()[idxs]
                    feats[f"roll_std_{w}"] = np.nanstd(hist[-w:, :, :], axis=0).ravel()[idxs]
                    feats[f"roll_min_{w}"] = np.nanmin(hist[-w:, :, :], axis=0).ravel()[idxs]
                    feats[f"roll_max_{w}"] = np.nanmax(hist[-w:, :, :], axis=0).ravel()[idxs]
        # <<< MODIFIED END >>>

        feats["doy_sin"] = np.full(len(idxs), doy_sin[tt])
        feats["doy_cos"] = np.full(len(idxs), doy_cos[tt])
        lat_grid, lon_grid = np.meshgrid(var_da.coords[lat_var].values, var_da.coords[lon_var].values, indexing='ij')
        feats["lat"] = lat_grid.ravel()[idxs]
        feats["lon"] = lon_grid.ravel()[idxs]
        all_features.append(pd.DataFrame(feats))
        all_targets.append(pd.Series(target_flat[idxs]))
    if len(all_features) == 0:
        return pd.DataFrame(), pd.Series(dtype=float)
    X_df = pd.concat(all_features, ignore_index=True)
    y_ser = pd.concat(all_targets, ignore_index=True)
    print(f"Created scalar dataset with {len(X_df)} samples.")
    return X_df, y_ser


def make_supervised_wcd(speed_da: xr.DataArray, deg_da: xr.DataArray, max_lag, lat_var, lon_var, sampling_cfg):
    times = pd.to_datetime(speed_da.coords['time'].values)
    nlat, nlon = speed_da.shape[1], speed_da.shape[2]
    lat_grid, lon_grid = np.meshgrid(speed_da.coords[lat_var].values, speed_da.coords[lon_var].values, indexing='ij')
    sin_all, cos_all = encode_deg_to_sin_cos(deg_da.values)

    all_X, all_Y = [], []
    total_grid_points = nlat * nlon
    sample_indices = None
    if sampling_cfg.get("enabled", False):
        fraction = sampling_cfg.get("fraction", 1.0)
        num_samples = int(total_grid_points * fraction)
        num_samples = min(num_samples, total_grid_points)
        sample_indices = np.random.choice(total_grid_points, num_samples, replace=False)
        sample_indices.sort()

    for tt in range(max_lag, len(times) - 1):
        y_speed = speed_da.isel(time=tt + 1).values.ravel()
        y_sin = sin_all[tt + 1, :, :].ravel()
        y_cos = cos_all[tt + 1, :, :].ravel()
        valid_mask = ~(np.isnan(y_speed) | np.isnan(y_sin) | np.isnan(y_cos))
        if sample_indices is not None:
            valid_sample_mask = valid_mask[sample_indices]
            idxs = sample_indices[valid_sample_mask]
        else:
            idxs = np.where(valid_mask)[0]
        if len(idxs) == 0:
            continue
        hist_speed = speed_da.isel(time=slice(tt - max_lag + 1, tt + 1)).values
        hist_sin = sin_all[tt - max_lag + 1: tt + 1, :, :]
        hist_cos = cos_all[tt - max_lag + 1: tt + 1, :, :]
        feats = {}
        for lag in range(1, max_lag + 1):
            feats[f"lag_speed_{lag}"] = hist_speed[-lag, :, :].ravel()[idxs]
            feats[f"lag_sin_{lag}"] = hist_sin[-lag, :, :].ravel()[idxs]
            feats[f"lag_cos_{lag}"] = hist_cos[-lag, :, :].ravel()[idxs]
        
        # <<< MODIFIED START: Added more rolling window features for WCD >>>
        for w in (3, 7, 14, 30):
            if max_lag >= w:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    feats[f"roll_mean_speed_{w}"] = np.nanmean(hist_speed[-w:, :, :], axis=0).ravel()[idxs]
                    feats[f"roll_std_speed_{w}"] = np.nanstd(hist_speed[-w:, :, :], axis=0).ravel()[idxs]
                    feats[f"roll_min_speed_{w}"] = np.nanmin(hist_speed[-w:, :, :], axis=0).ravel()[idxs]
                    feats[f"roll_max_speed_{w}"] = np.nanmax(hist_speed[-w:, :, :], axis=0).ravel()[idxs]
                    
                    feats[f"roll_mean_sin_{w}"] = np.nanmean(hist_sin[-w:, :, :], axis=0).ravel()[idxs]
                    feats[f"roll_mean_cos_{w}"] = np.nanmean(hist_cos[-w:, :, :], axis=0).ravel()[idxs]
        # <<< MODIFIED END >>>

        doy = times[tt].dayofyear
        feats["doy_sin"] = np.full(len(idxs), np.sin(2 * np.pi * doy / 365.25))
        feats["doy_cos"] = np.full(len(idxs), np.cos(2 * np.pi * doy / 365.25))
        feats["lat"] = lat_grid.ravel()[idxs]
        feats["lon"] = lon_grid.ravel()[idxs]
        all_X.append(pd.DataFrame(feats))
        all_Y.append(pd.DataFrame({
            "y_speed": y_speed[idxs],
            "y_sin": y_sin[idxs],
            "y_cos": y_cos[idxs],
        }))
    if len(all_X) == 0:
        return pd.DataFrame(), pd.DataFrame(columns=["y_speed", "y_sin", "y_cos"])
    X_df = pd.concat(all_X, ignore_index=True)
    Y_df = pd.concat(all_Y, ignore_index=True)
    print(f"Created WCD dataset with {len(X_df)} samples.")
    return X_df, Y_df


# -----------------------------
# GA evaluation and final training
# -----------------------------
def evaluate_and_retrain_scalar(X_df, y_ser, cfg, factor_key):
    max_lag = cfg['ga']['max_lag_days']
    f_names = build_candidate_feature_names(max_lag)
    f_names = [f for f in f_names if f in X_df.columns]
    if len(f_names) == 0:
        raise RuntimeError("No features available for GA.")

    hyperparam_grid = cfg.get('ga', {}).get('hyperparam_grid_scalar',
                                            {'n_estimators': [100, 200], 'max_depth': [4, 6], 'learning_rate': [0.05, 0.1]})

    X_train, X_test, y_train, y_test = train_test_split(X_df, y_ser, test_size=0.15, shuffle=False)

    sample_cells = min(len(X_train), cfg['ga'].get('sample_cells_for_ga', 15000))

    def fitness_fn(mask, hyperparams):
        selected = [name for i, name in enumerate(f_names) if mask[i]]
        if not selected:
            return (-1e9, 1e9)
        idx = np.random.choice(X_train.index, size=min(len(X_train), sample_cells), replace=False)
        X_sub = X_train.loc[idx, selected]
        y_sub = y_train.loc[idx]
        model = xgb.XGBRegressor(**hyperparams, verbosity=0, n_jobs=-1)
        model.fit(X_sub, y_sub)
        ypred = model.predict(X_test[selected])
        mae = mean_absolute_error(y_test, ypred)
        return -mae, mae

    ga_cfg = cfg.get('ga', {})
    ga = SimpleGA(f_names, hyperparam_grid, fitness_fn,
                  pop_size=ga_cfg.get('population', 25),
                  p_crossover=ga_cfg.get('p_crossover', 0.8),
                  p_mutation=ga_cfg.get('p_mutation', 0.1),
                  generations=ga_cfg.get('generations', 15))
    best_ind, best_score = ga.run()

    best_mask, best_hidx = best_ind
    best_hparams = list(ParameterGrid(hyperparam_grid))[best_hidx]
    selected_features = [name for i, name in enumerate(f_names) if best_mask[i]]

    print("\n--- Calculating Final Accuracy on Test Set ---")
    final_test_model = xgb.XGBRegressor(**best_hparams, verbosity=0, n_jobs=-1)
    final_test_model.fit(X_train[selected_features], y_train)
    ypred_final = final_test_model.predict(X_test[selected_features])
    final_mae = mean_absolute_error(y_test, ypred_final)
    print(f"Final Accuracy for '{factor_key}':")
    print(f"  -> MAE: {final_mae:.4f}\n")

    min_threshold = cfg.get('retraining_rules', {}).get('min_accuracy_threshold', {}).get(factor_key)
    if min_threshold is not None:
        print(f"Checking score against threshold for '{factor_key}': Best Score={best_score:.4f}, Threshold={min_threshold}")
        if best_score < min_threshold:
            print(f"❌ Accuracy threshold not met for '{factor_key}'. Halting process for this factor.")
            return None, None
        else:
            print(f"✅ Accuracy threshold met for '{factor_key}'.")

    print(f"Selected features ({len(selected_features)}): {selected_features}")
    print(f"Best hyperparams: {best_hparams} | GA score: {best_score:.4f}")

    final_model = xgb.XGBRegressor(**best_hparams, verbosity=0, n_jobs=-1)
    final_model.fit(X_df[selected_features], y_ser)
    return final_model, selected_features


def evaluate_and_retrain_wcd(X_df, Y_df, cfg, group_name):
    max_lag = cfg['ga']['max_lag_days']
    
    # <<< MODIFIED START: Build WCD feature names dynamically >>>
    f_names = []
    for lag in range(1, max_lag + 1):
        f_names += [f"lag_speed_{lag}", f"lag_sin_{lag}", f"lag_cos_{lag}"]
    for w in (3, 7, 14, 30):
        if max_lag >= w:
            f_names += [f"roll_mean_speed_{w}", f"roll_std_speed_{w}", f"roll_min_speed_{w}", f"roll_max_speed_{w}",
                        f"roll_mean_sin_{w}", f"roll_mean_cos_{w}"]
    f_names += ["doy_sin", "doy_cos", "lat", "lon"]
    # <<< MODIFIED END >>>

    f_names = [f for f in f_names if f in X_df.columns]
    if len(f_names) == 0:
        raise RuntimeError("No features for WCD GA.")

    hyperparam_grid = cfg.get('ga', {}).get('hyperparam_grid_wcd',
                                            {'n_estimators': [100, 200], 'max_depth': [4, 6], 'learning_rate': [0.05, 0.1]})

    X_train, X_test, Y_train, Y_test = train_test_split(X_df, Y_df, test_size=0.15, shuffle=False)
    sample_cells = min(len(X_train), cfg['ga'].get('sample_cells_for_ga', 15000))

    w_speed = cfg.get('ga', {}).get('w_speed', 0.6)
    w_angle = cfg.get('ga', {}).get('w_angle', 0.4)

    def fitness_fn(mask, hyperparams):
        selected = [name for i, name in enumerate(f_names) if mask[i]]
        if not selected:
            return (-1e9, 1e9, 1e9)
        idx = np.random.choice(X_train.index, size=min(len(X_train), sample_cells), replace=False)
        X_sub = X_train.loc[idx, selected]
        Y_sub = Y_train.loc[idx]
        base = xgb.XGBRegressor(**hyperparams, verbosity=0, n_jobs=-1)
        mor = MultiOutputRegressor(base, n_jobs=1)
        mor.fit(X_sub, Y_sub)
        Y_pred = mor.predict(X_test[selected])
        
        speed_true = Y_test["y_speed"].values
        sin_true = Y_test["y_sin"].values
        cos_true = Y_test["y_cos"].values
        
        speed_pred = Y_pred[:, 0]
        sin_pred = Y_pred[:, 1]
        cos_pred = Y_pred[:, 2]
        
        mae_speed = mean_absolute_error(speed_true, speed_pred)
        deg_true = decode_sin_cos_to_deg(sin_true, cos_true)
        deg_pred = decode_sin_cos_to_deg(sin_pred, cos_pred)
        ang_err = np.abs(((deg_pred - deg_true + 180) % 360) - 180)
        ang_mae = np.nanmean(ang_err)
        
        combined = - (w_speed * mae_speed + w_angle * ang_mae)
        return combined, mae_speed, ang_mae

    ga_cfg = cfg.get('ga', {})
    ga = SimpleGA(f_names, hyperparam_grid, fitness_fn,
                  pop_size=ga_cfg.get('population', 25),
                  p_crossover=ga_cfg.get('p_crossover', 0.8),
                  p_mutation=ga_cfg.get('p_mutation', 0.1),
                  generations=ga_cfg.get('generations', 15))
    best_ind, best_score = ga.run()

    best_mask, best_hidx = best_ind
    best_hparams = list(ParameterGrid(hyperparam_grid))[best_hidx]
    selected_features = [name for i, name in enumerate(f_names) if best_mask[i]]

    print("\n--- Calculating Final Accuracy on Test Set ---")
    final_test_base = xgb.XGBRegressor(**best_hparams, verbosity=0, n_jobs=-1)
    final_test_mor = MultiOutputRegressor(final_test_base, n_jobs=1)
    final_test_mor.fit(X_train[selected_features], Y_train)
    Y_pred_final = final_test_mor.predict(X_test[selected_features])
    
    final_mae_speed = mean_absolute_error(Y_test["y_speed"], Y_pred_final[:, 0])
    final_deg_true = decode_sin_cos_to_deg(Y_test["y_sin"], Y_test["y_cos"])
    final_deg_pred = decode_sin_cos_to_deg(Y_pred_final[:, 1], Y_pred_final[:, 2])
    final_ang_err = np.abs(((final_deg_pred - final_deg_true + 180) % 360) - 180)
    final_ang_mae = np.nanmean(final_ang_err)
    
    print(f"Final Accuracy for '{group_name}':")
    print(f"  -> Speed MAE: {final_mae_speed:.4f}")
    print(f"  -> Direction MAE: {final_ang_mae:.4f}\n")

    min_threshold = cfg.get('retraining_rules', {}).get('min_accuracy_threshold', {}).get(group_name)
    if min_threshold is not None:
        print(f"Checking score against threshold for '{group_name}': Best Score={best_score:.4f}, Threshold={min_threshold}")
        if best_score < min_threshold:
            print(f"❌ Accuracy threshold not met for '{group_name}'. Halting process for this factor.")
            return None, None
        else:
            print(f"✅ Accuracy threshold met for '{group_name}'.")

    print(f"WCD selected {len(selected_features)} features. Best hyperparams: {best_hparams} | GA score: {best_score:.4f}")

    base = xgb.XGBRegressor(**best_hparams, verbosity=0, n_jobs=-1)
    mor_final = MultiOutputRegressor(base, n_jobs=1)
    mor_final.fit(X_df[selected_features], Y_df[["y_speed", "y_sin", "y_cos"]])
    return mor_final, selected_features


# -----------------------------
# Forecasting (autoregressive)
# -----------------------------
def forecast_scalar(ds_hist: xr.Dataset, var_name: str, model, selected_features, dates_out, cfg):
    lat_var, lon_var, time_var = cfg['lat_var'], cfg['lon_var'], cfg['time_var']
    lats = ds_hist.coords[lat_var].values
    lons = ds_hist.coords[lon_var].values
    sea_mask = _sea_mask(lats, lons)

    var = ds_hist[var_name]
    max_lag = cfg['ga']['max_lag_days']
    nlat, nlon = len(lats), len(lons)
    forecasts = {}

    history = [var.isel({time_var: i}).values for i in range(-max_lag, 0)]

    for ts in dates_out:
        hs = np.array(history)
        feats = {}
        for i, lag in enumerate(range(1, max_lag + 1), start=1):
            feats[f"lag_{i}"] = hs[-lag, :, :].ravel()
        
        # <<< MODIFIED START: Ensure forecasting uses same features as training >>>
        for w in (3, 7, 14, 30):
            if max_lag >= w:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    feats[f"roll_mean_{w}"] = np.nanmean(hs[-w:, :, :], axis=0).ravel()
                    feats[f"roll_std_{w}"] = np.nanstd(hs[-w:, :, :], axis=0).ravel()
                    feats[f"roll_min_{w}"] = np.nanmin(hs[-w:, :, :], axis=0).ravel()
                    feats[f"roll_max_{w}"] = np.nanmax(hs[-w:, :, :], axis=0).ravel()
        # <<< MODIFIED END >>>

        doy = ts.dayofyear
        feats["doy_sin"] = np.full(nlat * nlon, np.sin(2 * np.pi * doy / 365.25))
        feats["doy_cos"] = np.full(nlat * nlon, np.cos(2 * np.pi * doy / 365.25))
        feats["lat"] = np.repeat(lats, nlon)
        feats["lon"] = np.tile(lons, nlat)

        Xpred = pd.DataFrame({k: feats[k] for k in selected_features if k in feats})
        y_flat = model.predict(Xpred)
        y_grid = y_flat.reshape(nlat, nlon)
        y_grid = np.where(sea_mask, y_grid, np.nan)
        forecasts[ts.strftime("%Y-%m-%d")] = y_grid

        history.pop(0)
        history.append(y_grid)

    return forecasts


def forecast_wcd(ds_hist: xr.Dataset, speed_name: str, deg_name: str, model, selected_features, dates_out, cfg):
    lat_var, lon_var, time_var = cfg['lat_var'], cfg['lon_var'], cfg['time_var']
    lats = ds_hist.coords[lat_var].values
    lons = ds_hist.coords[lon_var].values
    sea_mask = _sea_mask(lats, lons)

    speed_da = ds_hist[speed_name]
    deg_da = ds_hist[deg_name]
    max_lag = cfg['ga']['max_lag_days']
    nlat, nlon = len(lats), len(lons)

    sin_all, cos_all = encode_deg_to_sin_cos(deg_da.values)

    h_speed = [speed_da.isel({time_var: i}).values for i in range(-max_lag, 0)]
    h_sin = [sin_all[i, :, :] for i in range(-max_lag, 0)]
    h_cos = [cos_all[i, :, :] for i in range(-max_lag, 0)]

    forecasts_speed = {}
    forecasts_deg = {}

    for ts in dates_out:
        hs = np.array(h_speed)
        hsi = np.array(h_sin)
        hco = np.array(h_cos)

        feats = {}
        for i, lag in enumerate(range(1, max_lag + 1), start=1):
            feats[f"lag_speed_{i}"] = hs[-lag, :, :].ravel()
            feats[f"lag_sin_{i}"] = hsi[-lag, :, :].ravel()
            feats[f"lag_cos_{i}"] = hco[-lag, :, :].ravel()
        
        # <<< MODIFIED START: Ensure forecasting uses same features as training >>>
        for w in (3, 7, 14, 30):
            if max_lag >= w:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    feats[f"roll_mean_speed_{w}"] = np.nanmean(hs[-w:, :, :], axis=0).ravel()
                    feats[f"roll_std_speed_{w}"] = np.nanstd(hs[-w:, :, :], axis=0).ravel()
                    feats[f"roll_min_speed_{w}"] = np.nanmin(hs[-w:, :, :], axis=0).ravel()
                    feats[f"roll_max_speed_{w}"] = np.nanmax(hs[-w:, :, :], axis=0).ravel()

                    feats[f"roll_mean_sin_{w}"] = np.nanmean(hsi[-w:, :, :], axis=0).ravel()
                    feats[f"roll_mean_cos_{w}"] = np.nanmean(hco[-w:, :, :], axis=0).ravel()
        # <<< MODIFIED END >>>

        doy = ts.dayofyear
        feats["doy_sin"] = np.full(nlat * nlon, np.sin(2 * np.pi * doy / 365.25))
        feats["doy_cos"] = np.full(nlat * nlon, np.cos(2 * np.pi * doy / 365.25))
        feats["lat"] = np.repeat(lats, nlon)
        feats["lon"] = np.tile(lons, nlat)

        Xpred = pd.DataFrame({k: feats[k] for k in selected_features if k in feats})
        pred = model.predict(Xpred)  # [N,3] => speed, sin, cos

        sp_flat = pred[:, 0]
        si_flat = pred[:, 1]
        co_flat = pred[:, 2]

        mag = np.sqrt(si_flat**2 + co_flat**2) + 1e-9
        si_flat /= mag
        co_flat /= mag

        deg_flat = decode_sin_cos_to_deg(si_flat, co_flat)

        sp_grid = sp_flat.reshape(nlat, nlon)
        deg_grid = deg_flat.reshape(nlat, nlon)

        sp_grid = np.where(sea_mask, sp_grid, np.nan)
        deg_grid = np.where(sea_mask, deg_grid, np.nan)

        key = ts.strftime("%Y-%m-%d")
        forecasts_speed[key] = sp_grid
        forecasts_deg[key] = deg_grid

        h_speed.pop(0); h_sin.pop(0); h_cos.pop(0)
        h_speed.append(sp_grid)
        h_sin.append(si_flat.reshape(nlat, nlon))
        h_cos.append(co_flat.reshape(nlat, nlon))

    return forecasts_speed, forecasts_deg


# -----------------------------
# Saving results
# -----------------------------
def _save_stack_as_nc(varname, forecasts, cfg, filename):
    ratio = cfg['input_resolution'] / cfg['output_resolution']
    if abs(round(ratio) - ratio) > 1e-8:
        raise AssertionError("Resolution ratio must be an integer.")
    scale = int(round(ratio))

    dates_sorted = sorted(forecasts.keys())
    stack_in = np.stack([forecasts[d] for d in dates_sorted])  # [T, lat, lon]
    T, nlat, nlon = stack_in.shape
    stack_hr = np.stack([upsample_grid(stack_in[t], scale) for t in range(T)])

    south = cfg["bounds"]["south"]
    west = cfg["bounds"]["west"]
    out_res = cfg["output_resolution"]
    nlat_hr, nlon_hr = stack_hr.shape[1], stack_hr.shape[2]

    lats_hr = np.linspace(south + out_res / 2.0,
                          south + out_res / 2.0 + (nlat_hr - 1) * out_res,
                          nlat_hr)
    lons_hr = np.linspace(west + out_res / 2.0,
                          west + out_res / 2.0 + (nlon_hr - 1) * out_res,
                          nlon_hr)

    da = xr.DataArray(
        data=stack_hr,
        dims=["time", "lat", "lon"],
        coords={"time": dates_sorted, "lat": lats_hr, "lon": lons_hr},
        name=varname
    )

    ensure_dir(cfg["output_dir"])
    da.to_netcdf(filename, encoding={varname: {"zlib": True, "complevel": 5}})
    print(f"Saved: {filename}")


def save_scalar_nc(factor_key, forecasts, cfg):
    fname = os.path.join(cfg["output_dir"],
                         f"forecast_{factor_key}_{cfg['forecast_start'].replace('-','')}-{cfg['forecast_end'].replace('-','')}.nc")
    _save_stack_as_nc(f"{factor_key}_forecast", forecasts, cfg, fname)


def save_wcd_nc(prefix, forecasts_speed, forecasts_deg, cfg):
    ratio = cfg['input_resolution'] / cfg['output_resolution']
    if abs(round(ratio) - ratio) > 1e-8:
        raise AssertionError("Resolution ratio must be an integer.")
    scale = int(round(ratio))

    dates_sorted = sorted(forecasts_speed.keys())
    sp_in = np.stack([forecasts_speed[d] for d in dates_sorted])
    dg_in = np.stack([forecasts_deg[d] for d in dates_sorted])
    T, nlat, nlon = sp_in.shape
    sp_hr = np.stack([upsample_grid(sp_in[t], scale) for t in range(T)])
    dg_hr = np.stack([upsample_grid(dg_in[t], scale) for t in range(T)])

    south = cfg["bounds"]["south"]
    west = cfg["bounds"]["west"]
    out_res = cfg["output_resolution"]
    nlat_hr, nlon_hr = sp_hr.shape[1], sp_hr.shape[2]
    lats_hr = np.linspace(south + out_res / 2.0,
                          south + out_res / 2.0 + (nlat_hr - 1) * out_res,
                          nlat_hr)
    lons_hr = np.linspace(west + out_res / 2.0,
                          west + out_res / 2.0 + (nlon_hr - 1) * out_res,
                          nlon_hr)

    ds = xr.Dataset()
    ds[f"{prefix}_speed_forecast"] = xr.DataArray(sp_hr, dims=["time","lat","lon"],
                                                  coords={"time": dates_sorted, "lat": lats_hr, "lon": lons_hr})
    ds[f"{prefix}_dir_forecast"] = xr.DataArray(dg_hr, dims=["time","lat","lon"],
                                                coords={"time": dates_sorted, "lat": lats_hr, "lon": lons_hr})

    ensure_dir(cfg["output_dir"])
    fname = os.path.join(cfg["output_dir"],
                         f"forecast_{prefix}_{cfg['forecast_start'].replace('-','')}-{cfg['forecast_end'].replace('-','')}.nc")
    comp = {name: {"zlib": True, "complevel": 5} for name in ds.data_vars}
    ds.to_netcdf(fname, encoding=comp)
    print(f"Saved: {fname}")


# -----------------------------
# Main
# -----------------------------
def main(config_path):
    with open(config_path, "r") as fh:
        cfg = json.load(fh)

    seed = cfg.get("seed", 42)
    np.random.seed(seed)
    random.seed(seed)

    ensure_dir(cfg.get("output_dir", "."))

    ds = load_dataset(cfg["nc_path"])

    factor = cfg["factor"]
    max_lag = cfg['ga']['max_lag_days']

    dates_out = weekly_dates(cfg["forecast_start"], cfg["forecast_end"])
    print(f"Forecast dates (weekly): {dates_out[0].date()} -> {dates_out[-1].date()} (n={len(dates_out)})")

    if factor in ("rain", "waves", "ice"):
        varname = cfg['variables'][factor]
        print(f"Processing scalar factor: {factor} -> var {varname}")

        X_df, y_ser = make_supervised_scalar(ds[varname], max_lag, cfg['lat_var'], cfg['lon_var'], cfg.get("data_sampling", {}))
        if X_df.empty or y_ser.empty:
            print("No training samples, skipping.")
            return

        model, sel_feats = evaluate_and_retrain_scalar(X_df, y_ser, cfg, factor)
        
        if model is None:
            print(f"Halting pipeline because accuracy threshold was not met for '{factor}'.")
            return

        forecasts = forecast_scalar(ds, varname, model, sel_feats, dates_out, cfg)
        save_scalar_nc(factor, forecasts, cfg)

    elif factor == "wind":
        speed_name = cfg['variables']['wind_speed']
        dir_name = cfg['variables']['wind_dir']
        print(f"Processing wind group: speed={speed_name} dir={dir_name}")

        Xw, Yw = make_supervised_wcd(ds[speed_name], ds[dir_name], max_lag, cfg['lat_var'], cfg['lon_var'], cfg.get("data_sampling", {}))
        if Xw.empty or Yw.empty:
            print("No WCD training samples, skipping.")
            return
        model_w, feat_w = evaluate_and_retrain_wcd(Xw, Yw, cfg, "wind")

        if model_w is None:
            print(f"Halting pipeline because accuracy threshold was not met for 'wind'.")
            return

        fw_sp, fw_deg = forecast_wcd(ds, speed_name, dir_name, model_w, feat_w, dates_out, cfg)
        save_wcd_nc("wind", fw_sp, fw_deg, cfg)

    elif factor == "current":
        speed_name = cfg['variables']['current_speed']
        dir_name = cfg['variables']['current_dir']
        print(f"Processing current group: speed={speed_name} dir={dir_name}")

        Xc, Yc = make_supervised_wcd(ds[speed_name], ds[dir_name], max_lag, cfg['lat_var'], cfg['lon_var'], cfg.get("data_sampling", {}))
        if Xc.empty or Yc.empty:
            print("No WCD training samples, skipping.")
            return
        model_c, feat_c = evaluate_and_retrain_wcd(Xc, Yc, cfg, "current")

        if model_c is None:
            print(f"Halting pipeline because accuracy threshold was not met for 'current'.")
            return
        
        fc_sp, fc_deg = forecast_wcd(ds, speed_name, dir_name, model_c, feat_c, dates_out, cfg)
        save_wcd_nc("current", fc_sp, fc_deg, cfg)

    else:
        raise ValueError(f"Unknown factor: {factor}")

    print("DONE.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Maritime forecasting pipeline (per-factor).")
    parser.add_argument("--config", required=True, help="Path to JSON config (one factor per config).")
    args = parser.parse_args()
    main(args.config)
