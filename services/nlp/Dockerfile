FROM python:3.11-slim

# cache-bust: 2026-03-30-b (force fresh layer after smarter keyword matching PR)
WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

# Pre-download NLTK data at build time so startup is instant
RUN python -c "import nltk; nltk.download('stopwords'); nltk.download('punkt'); nltk.download('punkt_tab')"

COPY . .

# Expose default port
EXPOSE 8080

# Use exec form for proper signal handling
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
