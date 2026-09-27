# Pix sandbox image — built from the host-published body release.
# The build context contains the frozen package.json + package-lock.json
# (+ optional sealed resources/). Pi is installed INSIDE the image from the
# lock: no moving tags, no unpinned global installs at run time.
FROM node:24-bookworm-slim

# Prefer IPv4 for network requests inside the container/build.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
ENV PREFER_IPV4=true
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Frozen body install: exactly the versions the host published.
# vendor/ (offline package inputs) must precede npm ci — the lock may
# reference file:./vendor/*.tgz. Both dirs always exist in the context.
WORKDIR /opt/pix/body
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

# Sealed non-dependency resources (local extension snapshots, etc.).
COPY resources/ ./resources/

# The body is read-only for the run user.
RUN chmod -R a-w /opt/pix/body

COPY entrypoint.js /opt/pix/entrypoint.js

ENV PI_BODY_DIR=/opt/pix/body
WORKDIR /workspace

# Entry: the managed Pi CLI, resolved from the package's own bin metadata.
ENTRYPOINT ["node", "/opt/pix/entrypoint.js"]
