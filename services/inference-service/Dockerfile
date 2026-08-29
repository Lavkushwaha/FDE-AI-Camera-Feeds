# For GPU inference, switch base image to nvidia/cuda:12.x-runtime and install
# onnxruntime-gpu / torch with CUDA support. This slim image is enough to boot
# the API skeleton and wire the rest of the pipeline first.
FROM python:3.11-slim


# opencv-python (pulled by ultralytics) needs GUI shared libs at runtime;
# slim images don't ship them. Install + clean apt cache in ONE layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5000"]
