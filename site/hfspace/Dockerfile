# Digest verified 2026-11-17 against registry-1.docker.io (library/python:3.11-slim, OCI index; sha256 of the manifest body matched).
FROM python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 user
USER user
ENV PATH=/home/user/.local/bin:$PATH PYTHONUNBUFFERED=1
WORKDIR /home/user/app
COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --require-hashes --no-deps -r requirements.txt
COPY --chown=user . .
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860", "--no-access-log", "--h11-max-incomplete-event-size", "16384"]
