# 1. Use Python 3.11 slim image as base
FROM python:3.11-slim

# 2. Set the working directory inside the container
WORKDIR /app
COPY deployment/ /app/

# 3. Copy files into the container
COPY requirements.txt .
COPY main.py .
COPY model.pth .
COPY static ./static
COPY sample_EEG ./sample_EEG
COPY Waves ./Waves


# 4. Install required Python packages
RUN pip install --no-cache-dir -r requirements.txt

# 5. Expose port 8080 for FastAPI
EXPOSE 8080

# 6. Run FastAPI with uvicorn when the container starts
CMD ["python", "main.py"]
