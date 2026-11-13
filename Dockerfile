# The matchmaking server as a container image. No npm install: the service has no dependencies (Node's own tls,
# sqlite, http).
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="swgb-matchmaking" \
      org.opencontainers.image.description="Matchmaking, lobby and ladder server for the SWGB remaster (a fork of Empire League's server, MIT)" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/swgbremastered/matchmaking"

ENV NODE_ENV=production \
    SWGB_MM_CONFIG=/app/config.json \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app
COPY package.json README.md LICENSE LICENSE.empire-league ./
COPY src ./src
COPY data/maps.json ./data/maps.json
# the default config (TLS on, certificate in /certs, database in /data); mount another over it to change it
COPY config.example.json ./config.json

# /data: the database (a named volume); /certs: the certificate and key (mounted read-only)
RUN mkdir -p /data /certs && chown node:node /data
USER node
VOLUME ["/data"]

# TCP: the control link (TLS) and the relay; UDP: the hole-punch rendezvous (the same number). 4318: the health
# check, on 127.0.0.1 inside the container only (not published).
EXPOSE 4317/tcp 4317/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:4318/health > /dev/null || exit 1

STOPSIGNAL SIGTERM
CMD ["node", "src/server.mjs"]
