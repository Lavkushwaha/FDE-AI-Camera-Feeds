# Same ffmpeg build as mock-cameras (jrottenberg/ffmpeg:6-ubuntu) — the apt-packaged
# ffmpeg 5.1 on Debian corrupts real mp4 files across -stream_loop restarts; 6.1 doesn't.
FROM jrottenberg/ffmpeg:6-ubuntu
ENTRYPOINT []
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
CMD ["npm", "run", "dev"]
