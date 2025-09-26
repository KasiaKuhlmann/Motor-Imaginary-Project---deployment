# Motor-Imaginary-Project---deployment
This is repository for Data Science Retreat (portfolio project)

# EEG Motor Imagery Demo App

This repository contains a **demo application** for recognizing motor imagery movements from EEG signals. It demonstrates how EEG data can be classified, and connected with **neurofeedback** for real-time interaction.

⚠️ Note: This is a demo app intended for educational and experimental purposes only.

## Features
- Motor imagery classification  
- Integration with feedback mechanisms  

## Deployment

The app is containerized with Docker and ready for deployment on Railway or similar platforms.

### Run with Docker

Build the image:
```bash
docker build -t eeg-app .

docker run -p 8000:8000 eeg-app
****************************************************************************************************************
### Run locally (without Docker)

1. Clone the repository:
   git clone https://github.com/your-username/your-repo.git
   cd your-repo

2. Create a virtual environment and activate it:
   python -m venv venv
   source venv/bin/activate   # on Linux/Mac
   venv\Scripts\activate      # on Windows

3. Install dependencies:
   pip install -r deployment/requirements.txt

4. Run the app:
   python deployment/main.py

