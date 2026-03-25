FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

# Pre-download NLTK data at build time so startup is instant
RUN python -c "import nltk; nltk.download('stopwords'); nltk.download('punkt'); nltk.download('punkt_tab')"

COPY . .

# Use shell form so Railway's $PORT variable is expanded at runtime
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}
