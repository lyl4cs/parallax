# Long-running worker for Railway / Fly.io / any container host. Not for Vercel (see README).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

COPY pyproject.toml ./
COPY parallax ./parallax
RUN pip install --no-cache-dir ".[db,live]"

# One process per set of leader accounts. Never run two replicas over the same leaders.
CMD ["python", "-m", "parallax.main"]
