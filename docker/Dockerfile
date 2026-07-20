FROM node:24-bookworm-slim

# Prefer IPv4 for network requests inside the container/build.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
ENV PREFER_IPV4=true

# Disable IPv6 at the apt level and force IPv4 for registry access.
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Prefer IPv4 for npm registry access.
RUN npm config set prefer-offline false \
    && npm config set registry https://registry.npmjs.org/ \
    && npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /workspace

ENTRYPOINT ["pi"]
