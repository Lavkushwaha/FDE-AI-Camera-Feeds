# For GPU inference, switch base image to nvidia/cuda:12.x-runtime and install
# onnxruntime-gpu / torch with CUDA support. This slim image is enough to boot
# the API skeleton and wire the rest of the pipeline first.
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5000"]
