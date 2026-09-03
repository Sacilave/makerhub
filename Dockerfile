FROM node:24-slim AS frontend-build

WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
COPY app/static/css/app.css /app/static/css/app.css
RUN npm run build
RUN npm prune --omit=dev

FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MAKERHUB_CONFIG_DIR=/app/config/config \
    MAKERHUB_LOGS_DIR=/app/config/logs \
    MAKERHUB_STATE_DIR=/app/config/state \
    MAKERHUB_ARCHIVE_DIR=/app/data \
    MAKERHUB_LOCAL_DIR=/app/data/local

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium curl libarchive-tools libnss3 libnspr4 libatk1.0-0 \
        libatk-bridge2.0-0 libcups2 libdbus-1-3 libdrm2 libxkbcommon0 \
        libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libgbm1 libpango-1.0-0 libcairo2 libasound2 libx11-xcb1 \
        libfontconfig1 libx11-6 libxcb1 libxext6 libxshmfence1 libglib2.0-0 \
        libgtk-3-0 libpangocairo-1.0-0 libcairo-gobject2 libgdk-pixbuf-2.0-0 \
        libxss1 libxtst6 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# CloakBrowser's CDP bridge needs Node at runtime. Reuse the same Node runtime
# that built the frontend instead of installing a second distro Node package.
COPY --from=frontend-build /usr/local/bin/node /usr/local/bin/node

COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt \
    && python -c "from importlib.metadata import version; assert version('pillow') == '12.3.0'; assert version('opencv-python-headless') == '4.14.0.94'; assert version('cryptography') == '50.0.1'"

RUN mkdir -p /app/config/config /app/config/logs /app/config/state /app/data /app/data/local
COPY app ./app
COPY compose.yaml ./compose.yaml
COPY VERSION ./VERSION
COPY docker/entrypoint.sh ./docker/entrypoint.sh
COPY frontend/package.json ./frontend/package.json
COPY --from=frontend-build /frontend/node_modules ./frontend/node_modules
COPY --from=frontend-build /frontend/dist ./frontend/dist
RUN chmod +x /app/docker/entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["app"]
