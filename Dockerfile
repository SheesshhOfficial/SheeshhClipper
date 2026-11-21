FROM python:3.12-slim-trixie
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 clipper \
    && useradd --uid 1000 --gid clipper --no-create-home clipper \
    && mkdir -p /data \
    && chown clipper:clipper /data
WORKDIR /app
COPY requirements.txt .
RUN python -m pip install -r requirements.txt
COPY app ./app
ENV SHEESH_DATA_DIR=/data TMPDIR=/data/cache
USER clipper
EXPOSE 8000
CMD ["python","-m","uvicorn","app.main:app","--host","0.0.0.0","--port","8000","--no-access-log"]
