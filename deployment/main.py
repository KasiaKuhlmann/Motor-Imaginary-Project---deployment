from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import torch
import torch.nn.functional as F
import pandas as pd
import os
import random
from scipy.signal import spectrogram
import numpy as np
from braindecode.models.shallow_fbcsp import ShallowFBCSPNet
from braindecode.modules.layers import Ensure4d  # necessary for loading



app = FastAPI()

# --- Serve static frontend files (index.html + app.js) ---
app.mount("/static", StaticFiles(directory="static"), name="static")

# --- Serve audio files from Waves/ ---
app.mount("/Waves", StaticFiles(directory="Waves"), name="Waves")

# --- Serve EEG samples ---
app.mount("/sample_EEG", StaticFiles(directory="sample_EEG"), name="sample_EEG")

# --- Root -> load index.html ---
@app.get("/", response_class=HTMLResponse)
def serve_index():
    with open(os.path.join("static", "index.html"), "r", encoding="utf-8") as f:
        return f.read()

# --- Load model ---
torch.serialization.add_safe_globals([ShallowFBCSPNet, Ensure4d])
MODEL_PATH = os.path.join(os.path.dirname(__file__), "model.pth")
model = None
if os.path.exists(MODEL_PATH):
    try:
        model = torch.load(MODEL_PATH, map_location="cpu", weights_only=False)  # 👈 ważne
        model.eval()
        print(f"✅ Model loaded from {MODEL_PATH}")
    except Exception as e:
        print(f"❌ Could not load model: {e}")
else:
    print(f"⚠️ Model file not found at {MODEL_PATH}")

# --- EEG parameters ---
FS = 200
EPOCH_LEN = int(1.5 * FS)  # 300 samples (1.5 sec)
STEP = 300                 # ~0.5s
THRESHOLD = 0.70

# --- Class to layer mapping ---
CLASS_TO_LAYER = {
    0: "left_hand.wav",
    1: "right_hand.wav",
    3: "left_leg.wav",
    5: "right_leg.wav"
}

EXERCISES = {
    "full": [0, 1, 3, 5],
    "hands": [0, 1, 2],
    "right": [1, 2, 5],
    "left": [0, 2, 3],
}

# ---------------- API endpoints ----------------
@app.get("/api/status")
def status():
    return {"status": "ok", "msg": "EEG → Music API running"}

@app.get("/api/music_sets")
def list_music_sets():
    base = os.path.join(os.path.dirname(__file__), "Waves")
    if not os.path.exists(base):
        return {"sets": []}
    sets = [d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))]
    return {"sets": sets}

@app.get("/api/available_exercises")
def available_exercises():
    return {"exercises": list(EXERCISES.keys())}

@app.get("/api/assign_tracks/{set_name}/{exercise}")
def assign_tracks(set_name: str, exercise: str):
    base = os.path.join(os.path.dirname(__file__), "Waves", set_name)
    if not os.path.exists(base):
        return {"error": f"Music set {set_name} not found"}

    wavs = [f for f in os.listdir(base) if f.endswith(".wav")]
    wavs.sort()

    # 🔹 Tutaj przypisujemy movement_classes ZAWSZE
    if exercise not in EXERCISES:
        return {"error": f"Exercise {exercise} not supported"}

    movement_classes = EXERCISES[exercise]   
    if len(wavs) < len(movement_classes):
        return {"error": f"Not enough wavs in {set_name} for {exercise}"}

    mapping = {}
    available = wavs[:]

    for cls in movement_classes:
        if cls == 2:  # neutral
            drum_file = next((w for w in available if w.lower().startswith("d")), None)
            if drum_file:
                mapping[cls] = f"{set_name}/{drum_file}"
                available.remove(drum_file)
            else:
                choice = random.choice(available)
                mapping[cls] = f"{set_name}/{choice}"
                available.remove(choice)
        else:
            if not available:
                return {"error": "Not enough wavs for all classes"}
            choice = random.choice(available)
            mapping[cls] = f"{set_name}/{choice}"
            available.remove(choice)

    return {"set": set_name, "exercise": exercise, "mapping": mapping}

@app.get("/api/stream_csv/{filename}")
def stream_csv(filename: str):
    file_path = os.path.join(os.path.dirname(__file__), "sample_EEG", filename)
    if not os.path.exists(file_path):
        return {"error": f"File {filename} not found"}
    if model is None:
        return {"error": "Model not loaded"}

    df = pd.read_csv(file_path)
    data = df.values.astype("float32")

    active_layers = set()
    timeline = []
    epochs = []  # for spectrogram

    for start in range(0, len(data) - EPOCH_LEN + 1, STEP):
        epoch = data[start:start + EPOCH_LEN]
        x = torch.tensor(epoch.T, dtype=torch.float32).unsqueeze(0)

        with torch.no_grad():
            y = model(x)
            if y.ndim == 3:
                y = y.mean(dim=2)
            probs = F.softmax(y, dim=1)
            max_prob, pred_class_tensor = torch.max(probs, dim=1)
            pred_class = int(pred_class_tensor)
            confidence = float(max_prob.item())

            if confidence >= THRESHOLD and pred_class in CLASS_TO_LAYER:
                active_layers.add(CLASS_TO_LAYER[pred_class])

        timeline.append({
            "time_sec": start / FS,
            "predicted_class": pred_class,
            "confidence": confidence,
            "active_layers": list(active_layers)
        })

        #  EEG signal for this epoch
        #  spectrogram for 10 channel
        f, t, Sxx = spectrogram(epoch[:, 10], fs=FS, nperseg=64, noverlap=32)
        # Sxx: shape (freq_bins, time_bins)
        # for simplicity only one channel (or repeat for several)
        Sxx_log = 10 * np.log10(Sxx + 1e-10)  # log scale
        epochs.append(Sxx_log.tolist())

    return {
        "file": filename,
        "timeline": timeline,
        "epochs": epochs
    }
# STARTER CODE
if __name__ == "__main__":
    import uvicorn, os
    port = int(os.getenv("PORT", "8080"))  # Render PORT
    # in DOCKER: reload=False
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)