FROM python:3.12-slim-trixie
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 clipper \
    && useradd --uid 1000 --gid clipper --no-create-home clipper \
    && mkdir -p /data \
    && chown clipper:clipper /data
# Keep OS dependencies independent of app changes so subsequent builds can reuse them.
COPY --from=ghcr.io/denoland/deno:bin-2.9.8@sha256:b507583d3c68ba69f3ed2ce5969ae5b8b70f43421c781279c7aea06435263543 /deno /usr/local/bin/deno
RUN deno --version \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends fonts-dejavu-core fonts-deva \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN python -m pip install -r requirements.txt
COPY app ./app
ENV SHEESH_DATA_DIR=/data TMPDIR=/data/cache DENO_DIR=/data/cache/deno HF_HOME=/data/models HOME=/data/cache/home
USER clipper
EXPOSE 8000
CMD ["python","-m","uvicorn","app.main:app","--host","0.0.0.0","--port","8000","--no-access-log"]
