FROM jrottenberg/ffmpeg:6-ubuntu
WORKDIR /app
COPY stream.sh /app/stream.sh
RUN chmod +x /app/stream.sh
ENTRYPOINT ["/app/stream.sh"]
