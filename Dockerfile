# syntax=docker/dockerfile:1
# QoreWitness agent and recorder. One image, two services (see docker-compose.yml).
# Behind a TLS-inspecting proxy, pass its CA for the build only:
#   docker build --secret id=extra_ca,src=/path/ca.crt .
FROM node:22.21.1-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && npm install -g pnpm@10.28.0 --ignore-scripts
WORKDIR /opt/qorewitness
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && pnpm install --frozen-lockfile --ignore-scripts
COPY . .
ARG QW_COMMIT=unknown
ENV QW_COMMIT=${QW_COMMIT} NODE_ENV=production
RUN useradd --system --uid 10001 --home /data qw && mkdir -p /data && chown qw /data
USER qw
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/qorewitness/deploy/docker-entrypoint.sh"]
CMD ["agent"]
